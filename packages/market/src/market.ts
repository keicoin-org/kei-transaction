/**
 * The market.
 *
 * An offer *is* a `swap_offer` block (SPEC §9.3). There is no listing table, no
 * matching engine, and no server: `sell()` writes a block that locks the seller's
 * own asset, `accept()` writes one block that moves both legs or neither, and
 * `cancel()` writes the block that gives the asset back. Everything read here is
 * read from account chains.
 *
 * Three things follow from that and are worth knowing before reading the code:
 *
 * - **Only the offerer locks anything, and it is their own asset** (§9.2). The
 *   same sword cannot be listed twice, because after the first offer it is not in
 *   the seller's spendable balance to offer again.
 * - **Accept and cancel race for one locked entry, and either can win** (§9.2,
 *   conflict 4). A lost race is a normal outcome with a sentence to match, not a
 *   condition this package tries to prevent.
 * - **Expiry is advisory** (§9.3). The chain has no clock, so an expired offer
 *   still settles if somebody accepts it. What actually removes a listing is the
 *   offerer's own cancel — which is why this package writes one in the background.
 */

import type { AssetId, KeiClient, SwapOffer } from '@keicoin/core'
import {
  KEI_ASSET,
  KEI_DECIMALS,
  KEI_NAME,
  KEI_SYMBOL,
  KeiError,
  assertAddress,
  fail,
  fromRaw,
  toRaw,
} from '@keicoin/core'

import { readTrades, summarise, type LegMeta, type MarketContext } from './history.js'
import { assetIdOf, durationMs } from './util.js'
import type {
  AssetAmount,
  BidOptions,
  Cancellation,
  ExpiryOptions,
  ListOptions,
  MarketOptions,
  MineOptions,
  Offer,
  OfferOptions,
  PriceSummary,
  SellOptions,
  Settlement,
  Trade,
  TradeOptions,
} from './types.js'

export interface MarketApi {
  /** List an asset for Kei. The common case, and the one §9.3 calls a sale offer. */
  sell(options: SellOptions): Promise<Offer>
  /** The mirror of `sell`: lock Kei, and take the asset from whoever fills it. */
  bid(options: BidOptions): Promise<Offer>
  /** Any asset for any asset. `sell` and `bid` are this with Kei on one side. */
  offer(options: OfferOptions): Promise<Offer>
  /** Take an offer. One block, both legs or neither (SPEC §9.2). */
  accept(offer: string | Offer): Promise<Settlement>
  /** Recover your own locked asset. Only valid while the offer is unaccepted. */
  cancel(offer: string | Offer): Promise<Cancellation>
  /** Cancel this wallet's own expired offers — what actually frees them (§9.3). */
  cancelExpired(): Promise<Cancellation[]>
  get(hash: string): Promise<Offer | null>
  /** Read listings off the chains of the accounts you name (SPEC §9.1). */
  offers(options: ListOptions): Promise<Offer[]>
  mine(options?: MineOptions): Promise<Offer[]>
  /** Settled offers — price history, read from the chain (SPEC §9.1). */
  trades(options?: TradeOptions): Promise<Trade[]>
  /** `medianPrice(sword, { window: '7d' })`, the §9.1 query. Null if never sold. */
  medianPrice(asset: AssetId | { id: AssetId }, options?: TradeOptions): Promise<number | null>
  price(asset: AssetId | { id: AssetId }, options?: TradeOptions): Promise<PriceSummary | null>
  /** Stop the background expiry sweep. `Kei.close()` calls this. */
  close(): void
}

const KEI_META: LegMeta = {
  asset: KEI_ASSET,
  symbol: KEI_SYMBOL,
  name: KEI_NAME,
  decimals: KEI_DECIMALS,
}

export function createMarket(client: KeiClient, options: MarketOptions = {}): MarketApi {
  const now = options.now ?? Date.now
  const autoCancelExpired = options.autoCancelExpired !== false
  const sweepInterval = options.sweepInterval ?? 30_000
  const metaCache = new Map<AssetId, LegMeta>()

  const meta = async (asset: AssetId): Promise<LegMeta> => {
    const id = String(asset ?? '').toUpperCase()
    if (id === '') fail('bad-asset', `A swap names an asset — Kei itself is ${KEI_ASSET}.`)
    if (id === KEI_ASSET) return KEI_META
    const cached = metaCache.get(id)
    if (cached) return cached
    const info = await client.node.assetInfo(id)
    if (!info) {
      fail('no-such-asset', `No asset with id ${String(asset)} exists on ${client.node.network}.`)
    }
    const found: LegMeta = {
      asset: info.id,
      symbol: info.symbol,
      name: info.name,
      decimals: info.decimals,
    }
    metaCache.set(id, found)
    return found
  }

  const context: MarketContext = { client, meta, now }

  const toOffer = async (raw: SwapOffer): Promise<Offer> => {
    const [give, want] = await Promise.all([meta(raw.asset), meta(raw.wantAsset)])
    const giveAmount = fromRaw(BigInt(raw.amount), give.decimals)
    const wantAmount = fromRaw(BigInt(raw.wantAmount), want.decimals)
    return {
      hash: raw.hash,
      from: raw.from,
      give: { ...give, amount: giveAmount },
      want: { ...want, amount: wantAmount },
      price: giveAmount === 0 ? 0 : wantAmount / giveAmount,
      to: raw.counterparty,
      expiresAt: raw.expiresAt,
      expired: raw.expiresAt !== null && raw.expiresAt <= now(),
      state: raw.state,
      mine: raw.from === client.address,
      acceptedBy: raw.acceptedBy,
      settledBy: raw.settledBy,
      seenAt: raw.seenAt,
      settledAt: raw.settledAt,
    }
  }

  /** What this wallet can actually put behind a block, in raw units. */
  const spendable = async (leg: LegMeta): Promise<bigint> =>
    leg.asset === KEI_ASSET
      ? client.balanceRaw()
      : BigInt(await client.node.holderBalance(leg.asset, client.address))

  const requireSpendable = async (leg: LegMeta, needed: bigint, why: string): Promise<void> => {
    const held = await spendable(leg)
    if (held >= needed) return
    // The most confusing outcome of self-locking is "where did my sword go?", and
    // the answer is usually an offer this wallet already wrote (SPEC §9.2).
    const locked = await lockedIn(leg.asset)
    const hint =
      locked > 0n
        ? ` ${format(locked, leg)} ${leg.symbol} is locked in your own open offers — market.cancel() frees it.`
        : ''
    fail(
      'insufficient-balance',
      `Not enough ${leg.symbol} — you hold ${format(held, leg)}, and ${why} ${format(needed, leg)}.${hint}`,
    )
  }

  const lockedIn = async (asset: AssetId): Promise<bigint> => {
    let total = 0n
    for (const raw of await client.node.accountSwaps(client.address, { state: 'open' })) {
      if (raw.asset === asset) total += BigInt(raw.amount)
    }
    return total
  }

  // ------------------------------------------------------------ expiry sweep

  let timer: ReturnType<typeof setTimeout> | undefined
  let armedFor: number | undefined

  const arm = (expiresAt: number | undefined): void => {
    if (!autoCancelExpired || expiresAt === undefined) return
    if (timer !== undefined && armedFor !== undefined && armedFor <= expiresAt) return
    if (timer !== undefined) clearTimeout(timer)
    armedFor = expiresAt
    timer = setTimeout(() => void sweep(), Math.max(0, expiresAt - now()) + 1)
    // A game that has quit should not be held open by a listing, and a test
    // should not hang on one either.
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  const sweep = async (): Promise<void> => {
    timer = undefined
    armedFor = undefined
    try {
      await cancelExpired()
      const open = await mine({ state: 'open', includeExpired: true })
      const next = open
        .map((offer) => offer.expiresAt)
        .filter((at): at is number => at !== null)
        .sort((a, b) => a - b)[0]
      if (next !== undefined) arm(next)
    } catch {
      // A sweep is housekeeping. If the node is unreachable this round, the next
      // offer this wallet writes arms it again; nothing is lost by staying quiet.
    }
  }

  // ----------------------------------------------------------------- writing

  const publish = async (
    give: AssetAmount,
    want: AssetAmount,
    to: string | undefined,
    expiry: ExpiryOptions,
  ): Promise<Offer> => {
    const giveMeta = await meta(assetIdOf(give.asset))
    const wantMeta = await meta(assetIdOf(want.asset))
    const giveRaw = positiveRaw(give.amount, giveMeta, `The amount of ${giveMeta.symbol} offered`)
    const wantRaw = positiveRaw(want.amount, wantMeta, `The asking price in ${wantMeta.symbol}`)
    const counterparty = to === undefined ? undefined : assertAddress(to, 'counterparty address')
    if (counterparty === client.address) {
      fail(
        'self-swap',
        'An offer reserved for your own address could only be accepted by you, and accepting your own offer moves nothing. Leave `to` out to let anyone accept.',
      )
    }
    const expiresAt = resolveExpiry(expiry, now)
    await requireSpendable(giveMeta, giveRaw, 'this offer locks')

    const { hash } = await client.submitAsset(
      {
        kind: 'swap_offer',
        asset: giveMeta.asset,
        amount: giveRaw.toString(),
        wantAsset: wantMeta.asset,
        wantAmount: wantRaw.toString(),
        ...(counterparty === undefined ? {} : { counterparty }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      },
      giveMeta.asset === KEI_ASSET ? -giveRaw : 0n,
    )

    const created = await client.node.swapOffer(hash)
    if (!created) {
      fail('offer-failed', `Offer ${hash} was published but cannot be read back. This is a node bug.`)
    }
    arm(expiresAt)
    return toOffer(created)
  }

  const accept = async (target: string | Offer): Promise<Settlement> => {
    const hash = hashOf(target, 'accept')
    const raw = await client.node.swapOffer(hash)
    if (!raw) {
      fail(
        'no-such-offer',
        `No offer with hash ${hash} exists on ${client.node.network}. An offer's hash is its id — read it from market.offers() rather than typing it.`,
      )
    }
    const offer = await toOffer(raw)
    if (offer.from === client.address) {
      fail(
        'self-accept',
        'That is this wallet\'s own offer. Accepting it would trade an asset with itself and move nothing — market.cancel() is what you want.',
      )
    }
    if (offer.state !== 'open') {
      fail(
        offer.state === 'accepted' ? 'offer-taken' : 'offer-cancelled',
        offer.state === 'accepted'
          ? `Offer ${hash} was already accepted by ${String(offer.acceptedBy)}. An offer settles exactly once — pick another listing.`
          : `Offer ${hash} was cancelled by its author, so the ${offer.give.symbol} is back in their wallet. Pick another listing.`,
      )
    }
    if (offer.to !== null && offer.to !== client.address) {
      fail(
        'not-the-counterparty',
        `Offer ${hash} is reserved for ${offer.to}, so this wallet cannot accept it (SPEC §9.2).`,
      )
    }
    const wantRaw = toRaw(offer.want.amount, offer.want.decimals, 'Price')
    await requireSpendable(offer.want, wantRaw, 'this offer asks for')

    const { hash: block } = await client.submitAsset(
      { kind: 'swap_accept', offer: hash, asset: offer.want.asset, amount: wantRaw.toString() },
      offer.want.asset === KEI_ASSET ? -wantRaw : 0n,
    )
    // Both legs are receivable the moment this block lands (SPEC §9.2). The
    // wallet collects them in the background anyway; doing it here means the
    // asset is in the balance by the time this promise resolves.
    await client.receiveAll()

    return {
      hash: block,
      offer: hash,
      from: offer.from,
      received: offer.give,
      paid: offer.want,
      price: offer.price,
    }
  }

  const cancelOffer = async (target: string | Offer): Promise<Cancellation> => {
    const hash = hashOf(target, 'cancel')
    const raw = await client.node.swapOffer(hash)
    if (!raw) {
      fail('no-such-offer', `No offer with hash ${hash} exists on ${client.node.network}.`)
    }
    const offer = await toOffer(raw)
    if (offer.from !== client.address) {
      fail(
        'not-your-offer',
        `Offer ${hash} was written by ${offer.from}, and only its author can cancel it — nobody else's asset is locked by it (SPEC §9.2).`,
      )
    }
    if (offer.state !== 'open') {
      fail(
        offer.state === 'accepted' ? 'offer-taken' : 'offer-cancelled',
        offer.state === 'accepted'
          ? `Offer ${hash} was accepted by ${String(offer.acceptedBy)}, so there is nothing left to cancel. The payment is on its way to this wallet.`
          : `Offer ${hash} was already cancelled, and the ${offer.give.symbol} is back in this wallet.`,
      )
    }
    const amountRaw = toRaw(offer.give.amount, offer.give.decimals, 'Locked amount')
    const { hash: block } = await client.submitAsset(
      { kind: 'swap_cancel', offer: hash },
      offer.give.asset === KEI_ASSET ? amountRaw : 0n,
    )
    return { hash: block, offer: hash, returned: offer.give }
  }

  const cancelExpired = async (): Promise<Cancellation[]> => {
    const out: Cancellation[] = []
    for (const offer of await mine({ state: 'open', includeExpired: true })) {
      if (!offer.expired) continue
      try {
        out.push(await cancelOffer(offer))
      } catch (error) {
        // Somebody accepted it between the read and the cancel. That is the race
        // §9.2 describes, and losing it is a sale, not a failure.
        if (error instanceof KeiError && (error.code === 'offer-taken' || error.code === 'offer-cancelled')) {
          continue
        }
        throw error
      }
    }
    return out
  }

  // ----------------------------------------------------------------- reading

  const list = async (
    accounts: readonly string[],
    filter: { asset?: AssetId; want?: AssetId; state: MineOptions['state']; includeExpired: boolean; limit?: number },
  ): Promise<Offer[]> => {
    const out: Offer[] = []
    for (const account of accounts) {
      const raws = await client.node.accountSwaps(assertAddress(account, 'account address'), {
        ...(filter.limit === undefined ? {} : { limit: filter.limit }),
        ...(filter.state ? { state: filter.state } : {}),
      })
      for (const raw of raws) {
        if (filter.asset !== undefined && raw.asset !== filter.asset) continue
        if (filter.want !== undefined && raw.wantAsset !== filter.want) continue
        const offer = await toOffer(raw)
        if (offer.expired && !filter.includeExpired) continue
        out.push(offer)
      }
    }
    return out
  }

  const offers = async (options: ListOptions): Promise<Offer[]> => {
    if (!options || options.from === undefined) {
      fail(
        'no-accounts',
        'market.offers() needs the accounts to read: an offer lives on its author\'s chain, so listings are a bounded walk of the chains you name (SPEC §9.1). Pass { from: sellerAddress } or { from: [ ... ] }. Kei has no network-wide listing index (SPEC §9.4).',
      )
    }
    const accounts = typeof options.from === 'string' ? [options.from] : [...options.from]
    if (accounts.length === 0) {
      fail('no-accounts', 'market.offers({ from: [] }) reads nothing. Name at least one account.')
    }
    return list(accounts, {
      ...(options.asset === undefined ? {} : { asset: assetIdOf(options.asset) }),
      ...(options.want === undefined ? {} : { want: assetIdOf(options.want) }),
      state: options.state === undefined ? 'open' : options.state,
      includeExpired: options.includeExpired === true,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    })
  }

  const mine = async (options: MineOptions = {}): Promise<Offer[]> =>
    list([client.address], {
      state: options.state === undefined ? 'open' : options.state,
      // Your own expired listings are exactly the ones you need to see.
      includeExpired: options.includeExpired !== false,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    })

  const trades = (options: TradeOptions = {}): Promise<Trade[]> => readTrades(context, options)

  const price = async (
    asset: AssetId | { id: AssetId },
    options: TradeOptions = {},
  ): Promise<PriceSummary | null> => {
    const id = assetIdOf(asset)
    const quote = options.quote === undefined ? KEI_ASSET : assetIdOf(options.quote)
    const matched = await readTrades(context, { ...options, asset: id, quote })
    return summarise(matched, id, quote)
  }

  return {
    sell: (sell) =>
      publish(
        { asset: sell.asset, amount: sell.amount ?? 1 },
        { asset: KEI_ASSET, amount: sell.price },
        sell.to,
        sell,
      ),
    bid: (bid) =>
      publish(
        { asset: KEI_ASSET, amount: bid.price },
        { asset: bid.asset, amount: bid.amount ?? 1 },
        bid.to,
        bid,
      ),
    offer: (options) => {
      if (!options?.give || !options?.want) {
        fail(
          'bad-offer',
          'market.offer() takes { give: { asset, amount }, want: { asset, amount } }. For a plain sale use market.sell({ asset, price }).',
        )
      }
      return publish(options.give, options.want, options.to, options)
    },
    accept,
    cancel: cancelOffer,
    cancelExpired,
    async get(hash) {
      const raw = await client.node.swapOffer(String(hash ?? ''))
      return raw ? toOffer(raw) : null
    },
    offers,
    mine,
    trades,
    async medianPrice(asset, options) {
      const summary = await price(asset, options)
      return summary ? summary.median : null
    },
    price,
    close() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      armedFor = undefined
    },
  }
}

function hashOf(target: string | Offer, verb: string): string {
  const hash = typeof target === 'string' ? target : target?.hash
  if (typeof hash !== 'string' || hash === '') {
    fail('bad-offer', `market.${verb}() takes an offer, or its hash. Read one from market.offers().`)
  }
  return hash.toUpperCase()
}

function positiveRaw(amount: number | string, leg: LegMeta, label: string): bigint {
  const raw = toRaw(amount, leg.decimals, label)
  if (raw <= 0n) fail('bad-amount', `${label} must be greater than zero.`)
  return raw
}

function format(raw: bigint, leg: LegMeta): string {
  return String(fromRaw(raw, leg.decimals))
}

function resolveExpiry(options: ExpiryOptions, now: () => number): number | undefined {
  if (options.expiresAt !== undefined && options.expiresIn !== undefined) {
    fail('bad-expiry', 'Pass expiresIn or expiresAt, not both.')
  }
  if (options.expiresIn !== undefined) return now() + durationMs(options.expiresIn, 'expiresIn')
  if (options.expiresAt === undefined) return undefined
  const at = options.expiresAt instanceof Date ? options.expiresAt.getTime() : options.expiresAt
  if (!Number.isSafeInteger(at) || at <= 0) {
    fail('bad-expiry', `expiresAt is a Date or a millisecond timestamp — got ${String(options.expiresAt)}.`)
  }
  return at
}
