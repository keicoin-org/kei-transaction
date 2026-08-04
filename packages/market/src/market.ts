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
import { readBook, type Book, type BookOptions } from './book.js'
import {
  assertMatches,
  classify,
  reconcileOffers,
  type OfferLife,
  type Reconciliation,
  type ReconcileOptions,
} from './lifecycle.js'
import {
  priceIndex,
  toCandles,
  toSeries,
  type Candle,
  type CandleOptions,
  type PriceIndex,
  type Series,
  type SeriesOptions,
} from './series.js'
import { assetIdOf, durationMs } from './util.js'
import type { AccountSource } from './directory.js'
import {
  DEFAULT_ACCOUNT_LIMIT,
  coverageOf,
  emptyCoverage,
  mapConcurrent,
  walkAccounts,
  withCoverage,
  type Covered,
} from './walk.js'
import type {
  AcceptOptions,
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
  /**
   * Take an offer. One block, both legs or neither (SPEC §9.2).
   *
   * Pass `{ expect }` with the terms your view rendered and the offer is checked
   * against the chain, field by field, immediately before signing. Any index
   * that told you about this listing is a list of where to look and never an
   * authority (SPEC §9.4) — this is how that stays true.
   */
  accept(offer: string | Offer, options?: AcceptOptions): Promise<Settlement>
  /** Recover your own locked asset. Only valid while the offer is unaccepted. */
  cancel(offer: string | Offer): Promise<Cancellation>
  /** Cancel this wallet's own expired offers — what actually frees them (§9.3). */
  cancelExpired(): Promise<Cancellation[]>
  get(hash: string): Promise<Offer | null>
  /**
   * Read listings off the chains of the accounts you name (SPEC §9.1).
   *
   * An array, with `coverage` on it: the walk reads `concurrency` chains at a
   * time, keeps going past a chain it cannot reach, and says which ones those
   * were. Rows come back in the order the accounts were asked for.
   */
  offers(options: ListOptions): Promise<Covered<Offer>>
  mine(options?: MineOptions): Promise<Covered<Offer>>
  /** Settled offers — price history, read from the chain (SPEC §9.1). */
  trades(options?: TradeOptions): Promise<Covered<Trade>>
  /**
   * Compatibility scalar for the median, or null if never sold. A number cannot
   * carry walk coverage; use `price(...).median` when completeness matters.
   */
  medianPrice(asset: AssetId | { id: AssetId }, options?: TradeOptions): Promise<number | null>
  price(asset: AssetId | { id: AssetId }, options?: TradeOptions): Promise<PriceSummary | null>

  /**
   * Asks and bids for one asset across the chains you name, in one walk per
   * account, with an honest account of what the walk could not see.
   */
  book(options: BookOptions): Promise<Book>
  /** Settled trades as an ordered price series, ready to draw (see `series.ts`). */
  series(options: SeriesOptions & TradeOptions): Promise<Series>
  /** The same series as OHLCV buckets. Bucketing is advisory — read `series.ts`. */
  candles(options: CandleOptions & TradeOptions): Promise<Covered<Candle>>
  /** Every traded asset's summary out of one walk, instead of one walk each. */
  prices(options?: TradeOptions & { assets?: Iterable<AssetId | { id: AssetId }> }): Promise<PriceIndex>
  /** Re-read a snapshot of listings and say what became of each one. */
  reconcile(snapshot: Iterable<string | Offer>, options?: ReconcileOptions): Promise<Reconciliation>
  /** A listing's state in a view's terms: live, reserved, stale, taken, cancelled. */
  lifeOf(offer: Offer): OfferLife

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
  const concurrency = options.concurrency
  const metaCache = new Map<AssetId, LegMeta>()
  // In flight as well as cached, because the walks below are concurrent now: a
  // cold cache and eight lanes converting offers in the same asset would
  // otherwise be eight identical `asset_info` calls, and reading faster is not
  // worth asking a rate-limited node the same question eight times.
  const metaInFlight = new Map<AssetId, Promise<LegMeta>>()

  const meta = async (asset: AssetId): Promise<LegMeta> => {
    const id = String(asset ?? '').toUpperCase()
    if (id === '') fail('bad-asset', `A swap names an asset — Kei itself is ${KEI_ASSET}.`)
    if (id === KEI_ASSET) return KEI_META
    const cached = metaCache.get(id)
    if (cached) return cached
    const pending = metaInFlight.get(id)
    if (pending) return pending
    const lookup = (async (): Promise<LegMeta> => {
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
    })().finally(() => metaInFlight.delete(id))
    metaInFlight.set(id, lookup)
    return lookup
  }

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

  const context: MarketContext = { client, meta, now, toOffer }

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
  let backgroundClosed = false
  let sweepEpoch = 0

  const arm = (expiresAt: number | undefined): void => {
    if (!autoCancelExpired || backgroundClosed || expiresAt === undefined) return
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
    const epoch = sweepEpoch
    try {
      await cancelExpired(() => !backgroundClosed && sweepEpoch === epoch)
      if (backgroundClosed || sweepEpoch !== epoch) return
      const open = await mine({ state: 'open', includeExpired: true })
      if (backgroundClosed || sweepEpoch !== epoch) return
      const next = open
        .map((offer) => offer.expiresAt)
        .filter((at): at is number => at !== null)
        .sort((a, b) => a - b)[0]
      if (next !== undefined) arm(next)
    } catch {
      // A transient read failure must not orphan an expired lock until another
      // offer happens to be written. Retry on the caller's housekeeping cadence.
      if (!backgroundClosed && sweepEpoch === epoch) arm(now() + sweepInterval)
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

  const accept = async (target: string | Offer, acceptOptions: AcceptOptions = {}): Promise<Settlement> => {
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
    // Last thing before the signature, and against the chain's copy rather than
    // the caller's: whatever told this wallet the listing existed is a list of
    // where to look, never an authority (SPEC §9.4).
    if (acceptOptions.expect !== undefined) assertMatches(offer, acceptOptions.expect)
    // Sign `raw`'s own wantAsset/wantAmount, not offer.want.amount — that field
    // round-tripped through a JS number for display and loses precision above
    // Number.MAX_SAFE_INTEGER. The chain only ever sees the raw string.
    const wantRaw = BigInt(raw.wantAmount)
    await requireSpendable(offer.want, wantRaw, 'this offer asks for')

    const { hash: block } = await client.submitAsset(
      { kind: 'swap_accept', offer: hash, asset: raw.wantAsset, amount: raw.wantAmount },
      raw.wantAsset === KEI_ASSET ? -wantRaw : 0n,
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

  async function cancelOfferChecked(target: string | Offer): Promise<Cancellation>
  async function cancelOfferChecked(
    target: string | Offer,
    shouldSubmit: () => boolean,
  ): Promise<Cancellation | null>
  async function cancelOfferChecked(
    target: string | Offer,
    shouldSubmit: () => boolean = () => true,
  ): Promise<Cancellation | null> {
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
    // The background sweep can be closed while either swapOffer() or toOffer()
    // is awaiting the node. Check again after those reads and immediately
    // before starting the signing/submission path. Explicit cancel() calls use
    // the default always-true guard and are unchanged.
    if (!shouldSubmit()) return null
    // Return `raw`'s own amount, not a re-conversion of offer.give.amount —
    // that field round-tripped through a JS number for display, and a cancel
    // built from it states a balance the ledger refuses whenever the locked
    // raw does not fit a double. Same rule as accept(): the chain only ever
    // sees the raw string.
    const { hash: block } = await client.submitAsset(
      { kind: 'swap_cancel', offer: hash },
      raw.asset === KEI_ASSET ? BigInt(raw.amount) : 0n,
    )
    return { hash: block, offer: hash, returned: offer.give }
  }

  const cancelOffer = (target: string | Offer): Promise<Cancellation> => cancelOfferChecked(target)

  const cancelExpired = async (shouldContinue: () => boolean = () => true): Promise<Cancellation[]> => {
    const out: Cancellation[] = []
    for (const offer of await mine({ state: 'open', includeExpired: true })) {
      if (!shouldContinue()) return out
      if (!offer.expired) continue
      try {
        const cancelled = await cancelOfferChecked(offer, shouldContinue)
        if (cancelled === null) return out
        out.push(cancelled)
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
    source: AccountSource,
    filter: {
      asset?: AssetId
      want?: AssetId
      state: MineOptions['state']
      includeExpired: boolean
      limit?: number
      signal?: AbortSignal
      concurrency?: number
      what: string
    },
  ): Promise<Covered<Offer>> => {
    const limit = filter.limit ?? DEFAULT_ACCOUNT_LIMIT
    const read = { signal: filter.signal, concurrency: filter.concurrency ?? concurrency, what: filter.what }

    const walk = await walkAccounts(
      source,
      async (account) => {
        const raws = await client.node.accountSwaps(account, {
          limit,
          ...(filter.state ? { state: filter.state } : {}),
        })
        return { rows: raws, truncated: raws.length >= limit }
      },
      read,
    )

    // Filter on the raw blocks first: the asset ids are already there, and
    // converting one costs an asset-metadata read that a rejected row wastes.
    const seen = new Set<string>()
    const kept = walk.rows.filter((raw) => {
      if (seen.has(raw.hash)) return false
      seen.add(raw.hash)
      return (
        (filter.asset === undefined || raw.asset === filter.asset) &&
        (filter.want === undefined || raw.wantAsset === filter.want)
      )
    })
    const converted = await mapConcurrent(kept, (raw) => toOffer(raw), read)
    const out = converted.filter((offer) => filter.includeExpired || !offer.expired)
    return withCoverage(out, walk.coverage)
  }

  const offers = async (options: ListOptions): Promise<Covered<Offer>> => {
    if (!options || options.from === undefined) {
      fail(
        'no-accounts',
        'market.offers() needs the accounts to read: an offer lives on its author\'s chain, so listings are a bounded walk of the chains you name (SPEC §9.1). Pass { from: sellerAddress } or { from: [ ... ] }. Kei has no network-wide listing index (SPEC §9.4).',
      )
    }
    const listing = await list(options.from, {
      ...(options.asset === undefined ? {} : { asset: assetIdOf(options.asset) }),
      ...(options.want === undefined ? {} : { want: assetIdOf(options.want) }),
      state: options.state === undefined ? 'open' : options.state,
      includeExpired: options.includeExpired === true,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      signal: options.signal,
      concurrency: options.concurrency,
      what: 'Reading listings',
    })
    // Nothing walkable is a caller mistake rather than an empty market, and the
    // two read identically from the outside if this is left to return `[]`. A
    // roster with one typo in it is *not* this case — that is a skipped address
    // in `coverage`, and the rest of the walk still happened.
    if (listing.coverage.asked === 0) {
      fail(
        'no-accounts',
        `market.offers({ from }) was given no accounts to read, so there is nothing to walk. Name at least one address — or, if that was a directory, nobody has announced themselves to it yet (see createDirectory).${skippedNote(listing.coverage.skipped)}`,
      )
    }
    return listing
  }

  const mine = async (options: MineOptions = {}): Promise<Covered<Offer>> =>
    list([client.address], {
      state: options.state === undefined ? 'open' : options.state,
      // Your own expired listings are exactly the ones you need to see.
      includeExpired: options.includeExpired !== false,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      signal: options.signal,
      concurrency: options.concurrency,
      what: 'Reading your own listings',
    })

  const trades = (options: TradeOptions = {}): Promise<Covered<Trade>> =>
    readTrades(context, { concurrency, ...options })

  const price = async (
    asset: AssetId | { id: AssetId },
    options: TradeOptions = {},
  ): Promise<PriceSummary | null> => {
    const id = assetIdOf(asset)
    const quote = options.quote === undefined ? KEI_ASSET : assetIdOf(options.quote)
    const matched = await readTrades(context, { concurrency, ...options, asset: id, quote })
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

    book: (bookOptions) => readBook(context, { concurrency, ...bookOptions }),

    async series(seriesOptions) {
      // The quote defaults to Kei in both halves, and the trade walk is filtered
      // by it as well as the series is — otherwise a sword that traded for gold
      // and for Kei draws one chart out of two different currencies.
      const quote = seriesOptions.quote === undefined ? KEI_ASSET : assetIdOf(seriesOptions.quote)
      const read = await readTrades(context, {
        concurrency,
        ...seriesOptions,
        asset: seriesOptions.asset,
        quote,
      })
      // `read` carries its walk's coverage, and `toSeries` passes it through, so
      // a chart drawn off a partial read can say so on the chart.
      return toSeries(read, { ...seriesOptions, quote })
    },

    async candles(candleOptions) {
      const quote = candleOptions.quote === undefined ? KEI_ASSET : assetIdOf(candleOptions.quote)
      const read = await readTrades(context, {
        concurrency,
        ...candleOptions,
        asset: candleOptions.asset,
        quote,
      })
      return withCoverage(toCandles(read, { ...candleOptions, quote }), coverageOf(read) ?? emptyCoverage())
    },

    async prices(priceOptions = {}) {
      const read = await readTrades(context, { concurrency, ...priceOptions })
      return priceIndex(read, {
        ...(priceOptions.quote === undefined ? {} : { quote: priceOptions.quote }),
        ...(priceOptions.assets === undefined ? {} : { assets: priceOptions.assets }),
      })
    },

    reconcile: (snapshot, reconcileOptions) =>
      reconcileOffers(context, snapshot, { concurrency, ...reconcileOptions }),

    lifeOf: (offer) => classify(offer, { viewer: client.address, now }),

    close() {
      backgroundClosed = true
      sweepEpoch += 1
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

/** Naming what was thrown away, so "nothing to walk" is not a mystery. */
function skippedNote(skipped: readonly string[]): string {
  if (skipped.length === 0) return ''
  const shown = skipped.slice(0, 3).join(', ')
  const rest = skipped.length > 3 ? `, and ${skipped.length - 3} more` : ''
  return ` Everything given was skipped for not being a Kei address: ${shown}${rest}.`
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
