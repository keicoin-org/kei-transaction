/**
 * The in-game wallet, headless half.
 *
 * SPEC §6.5: most players will never open the standalone wallet, so the in-game
 * panel is what they actually use. This ships the data behind it — one summary
 * call and a change event — which is also the escape hatch for a developer
 * drawing their own UI. The mountable `WalletPanel` (panel.ts) is built on top
 * of it and lands at M6, along with the seed-reveal friction from §6.6.
 *
 * Two things here are about what the network sees rather than what the caller
 * gets back. Asset metadata is fetched a bounded number at a time and then
 * remembered, because it cannot change (assets.ts). And the `change` event
 * drives at most one refresh per wallet at a time, however many blocks land and
 * however many panels are listening, because the alternative — a full summary
 * per update per listener — is how a busy wallet turns one arrival into a burst
 * of requests and then renders them in whatever order they happened to finish.
 *
 * One thing here is about what the caller gets back. `holdings` is what an
 * account can spend, and its own open offer holds its asset outside that
 * (SPEC §9.2), so a summary built on `holdings` alone answers "you have no
 * sword" to a player who listed one and can cancel it back at any time.
 * `locked` is the other half of that answer, and the two together are what the
 * account owns.
 */

import type {
  AssetId,
  KeiClient,
  OwnershipChallengeMessage,
  OwnershipProof,
} from '@keicoin/core'
import { KEI_ASSET, KEI_DECIMALS, assetCacheFor, fail, fromRaw, toRaw } from '@keicoin/core'
import type { ItemStats } from '@keicoin/tokens'
import type { ClaimsApi, PendingClaim } from '@keicoin/claims'
import {
  DEFAULT_ASSET_CACHE_LIMIT,
  DEFAULT_ASSET_CONCURRENCY,
  MAX_ASSET_CACHE_LIMIT,
  MAX_ASSET_CONCURRENCY,
  assetFactsFrom,
} from './assets.js'

export interface TokenBalance {
  asset: AssetId
  symbol: string
  name: string
  amount: number
  issuer: string
}

export interface ItemHolding {
  asset: AssetId
  name: string
  symbol: string
  count: number
  issuer: string
  image?: string
  /** Prose only: the stat block the chain packs in alongside it is split out. */
  description?: string
  stats?: ItemStats
}

/**
 * Something this account owns and cannot spend right now.
 *
 * Owned and spendable are two different questions, and `swap_offer` is where
 * they come apart: the offerer's own asset moves into the lock, so it leaves
 * `holdings` while it is still theirs and still recoverable by their own
 * `swap_cancel` (SPEC §9.2). `tokens` and `items` answer "what can this account
 * spend"; those plus `locked` answer "what does it own". Reporting only the
 * first as an inventory is what made the panel say a listed sword did not
 * exist.
 *
 * The words here are the availability axis and nothing else. Whether the block
 * behind a holding is pending, confirmed or failed is a separate question about
 * a different thing, and this type deliberately leaves those names free for it:
 * a locked item is confirmed on chain, and a pending one is not yet anywhere.
 */
export interface LockedHolding {
  asset: AssetId
  name: string
  symbol: string
  /** Whole units for an item, decimal for a token — as `items` and `tokens`. */
  amount: number
  /** Whether this shows as an item rather than a currency. */
  item: boolean
  /** Why it cannot be spent. An open offer is the only reason there is. */
  reason: 'offer'
  /** The `swap_offer` block holding it, and what `market.cancel` takes. */
  offer: string
  /** What the offer asks for it. */
  want: { asset: AssetId; symbol: string; name: string; amount: number }
  /** Advisory, and never enforced by the ledger (SPEC §9.3). */
  expiresAt: number | null
}

export interface WalletSummary {
  address: string
  /** Spendable Kei. Kei locked in this account's own offers is `keiLocked`. */
  kei: number
  /** Spendable balances, ascending by `asset` id — see `WalletApi.summary`. */
  tokens: TokenBalance[]
  /** Spendable holdings, ascending by `asset` id — see `WalletApi.summary`. */
  items: ItemHolding[]
  /**
   * Owned, not spendable: what this account has locked in its own open offers,
   * ascending by `asset` id and then by `offer`. Empty when `createWallet` was
   * given no `market`, which is also when nothing here costs a read.
   */
  locked: LockedHolding[]
  /** Kei locked in this account's own open offers, and not counted in `kei`. */
  keiLocked: number
  pending: PendingClaim[]
}

/** One side of an offer, as much of it as the wallet reads. */
export interface WalletMarketLeg {
  asset: AssetId
  symbol: string
  name: string
  amount: number
  /** Exact ledger quantity. Preferred over `amount` when Kei is totalled. */
  raw?: string
}

export interface WalletMarketOffer {
  hash: string
  give: WalletMarketLeg
  want: WalletMarketLeg
  expiresAt: number | null
}

/** The unread-chains half of a market walk's `coverage`. */
export interface WalletMarketCoverage {
  readonly failed: readonly { readonly reason: string }[]
}

export interface WalletMarketOffers extends ReadonlyArray<WalletMarketOffer> {
  readonly coverage?: WalletMarketCoverage
}

/**
 * What the wallet needs from `@keicoin/market`, declared structurally rather
 * than imported — the same reason `WalletPanelCustody` is (panel.ts). This
 * package depends on `@keicoin/core` and not on the market, and a game that
 * never trades should not acquire one to read its inventory. A real
 * `createMarket` result satisfies it exactly, and `Kei` passes its own.
 */
export interface WalletMarket {
  mine(options?: { state?: 'open' }): Promise<WalletMarketOffers>
}

export interface WalletApi {
  /**
   * A fresh read of the account: balance, holdings, this account's own open
   * offers, and pending claims are fetched every time. Only the assets'
   * issuance metadata is remembered between calls, and none of that can change
   * (SPEC §5.3, §5.4).
   *
   * `tokens`, `items` and `locked` are each **ascending by asset id**. That is
   * the order regardless of the order the node listed the holdings in and
   * regardless of which metadata lookup answered first, so two refreshes that
   * found the same things render the same way round. Two offers locking the
   * same asset are ordered by their offer hash after that.
   */
  summary(): Promise<WalletSummary>
  on(event: 'change', listener: (summary: WalletSummary) => void): () => void
  /**
   * Answer a server's challenge, proving this wallet controls its address
   * without disclosing anything that could sign anything else (SPEC §6.3).
   *
   * The challenge is structured, and the digest signed is derived from it here
   * — a wallet that signed a digest it was handed would sign whatever bytes the
   * asker chose, and the bytes worth choosing are a send. `verifyOwnershipProof`
   * is the other half, and it needs only the address.
   */
  signOwnershipChallenge(challenge: OwnershipChallengeMessage): Promise<OwnershipProof>
}

export interface WalletOptions {
  claims?: ClaimsApi
  /**
   * Where `locked` and `keiLocked` come from: this wallet's own open offers,
   * one bounded read of its own chain per summary. Without it both are empty
   * and `summary()` costs exactly what it did before, so an asset listed for
   * sale reads as gone — which is the whole of issue #43.
   */
  market?: WalletMarket
  /**
   * How many asset-metadata lookups this client may have in flight at once,
   * counted across every `summary()`, refresh, and `items.ownedBy()` it is
   * running rather than per call. Defaults to 8.
   *
   * Raise it when talking to a node you run yourself; the default is sized for
   * the shared public one (see `asset-cache.ts` in `@keicoin/core`). Must be a
   * whole number from 1 through 32.
   */
  assetConcurrency?: number
  /**
   * How many assets' immutable metadata this client remembers before evicting
   * the least recently used. Defaults to 2,048 — twice SPEC §7's hard cap of
   * 1,024 distinct assets per account. Must be a whole number from 1 through
   * 8,192; there is no unbounded setting.
   *
   * Both bounds belong to the client's one asset cache, which the wallet shares
   * with `items.ownedBy()`. The first caller to ask for it sizes it, and
   * `createWallet` asks while it is being constructed.
   */
  assetCacheLimit?: number
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum?: number,
): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0 || (maximum !== undefined && value > maximum)) {
    const range = maximum === undefined ? 'above zero' : `from 1 through ${maximum}`
    fail(
      'bad-wallet-option',
      `${name} must be a whole number ${range}, not ${String(value)}. There is deliberately no "unlimited" setting.`,
    )
  }
  return value
}

/** Asset ids are opaque strings, so the order is theirs rather than a locale's. */
function byAssetId(a: { asset: AssetId }, b: { asset: AssetId }): number {
  return a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0
}

/** One account can have several offers out on one asset; hashes break the tie. */
function byAssetThenOffer(a: LockedHolding, b: LockedHolding): number {
  return byAssetId(a, b) || (a.offer < b.offer ? -1 : a.offer > b.offer ? 1 : 0)
}

/**
 * The locked Kei of one offer, in raw units.
 *
 * Off `raw` when the offer carries it, which every offer this package is handed
 * by `@keicoin/market` does. Adding the decimal `amount`s instead would drift
 * at the eighteenth place, and the sum is subtracted from a balance elsewhere.
 */
function lockedRawOf(leg: WalletMarketLeg): bigint {
  return leg.raw === undefined ? toRaw(leg.amount, KEI_DECIMALS, 'Locked Kei') : BigInt(leg.raw)
}

export function createWallet(client: KeiClient, options: WalletOptions = {}): WalletApi {
  const assets = assetCacheFor(client, {
    limit: positiveInteger(
      options.assetCacheLimit,
      DEFAULT_ASSET_CACHE_LIMIT,
      'assetCacheLimit',
      MAX_ASSET_CACHE_LIMIT,
    ),
    concurrency: positiveInteger(
      options.assetConcurrency,
      DEFAULT_ASSET_CONCURRENCY,
      'assetConcurrency',
      MAX_ASSET_CONCURRENCY,
    ),
  })

  const summary = async (): Promise<WalletSummary> => {
    // Everything mutable, read fresh every time: the Kei balance, what the
    // account holds, and what it has yet to claim. None of this is ever served
    // from a cache — only the issuance metadata below is.
    const [info, holdings, pending, offers] = await Promise.all([
      client.node.accountInfo(client.address),
      client.node.holdings(client.address),
      options.claims ? options.claims.pending() : Promise.resolve<PendingClaim[]>([]),
      options.market
        ? options.market.mine({ state: 'open' })
        : Promise.resolve<WalletMarketOffers>([]),
    ])

    // A chain read that failed would arrive here as "nothing is locked", which
    // is the exact sentence this field exists to stop the wallet saying. Same
    // rule as a failed asset lookup (assets.ts): the caller sees the error
    // rather than an inventory quietly missing something.
    const unread = offers.coverage?.failed ?? []
    if (unread.length > 0) {
      fail(
        'wallet-offers-unread',
        `Could not read this account's own open offers, so the wallet cannot say what is locked in them: ${unread[0]?.reason ?? 'the read failed'}`,
      )
    }

    // Kei is not a holding and has no issuance record to look up, so it is
    // totalled separately and the rest are named from metadata like any other.
    const locks = offers.filter((offer) => offer.give.asset !== KEI_ASSET)
    let keiLockedRaw = 0n
    for (const offer of offers) {
      if (offer.give.asset === KEI_ASSET) keiLockedRaw += lockedRawOf(offer.give)
    }

    // One resolve over both halves of the inventory, through the client's shared
    // asset cache (#134). Both requirements have to hold at once: a locked asset
    // has left `holdings`, so resolving only the holdings would leave every
    // locked row unnamed and `continue` past it — which is issue #43 again by a
    // different route — and resolving it anywhere but this cache would put the
    // fan-out back outside the one bound the client has. `resolve` de-duplicates
    // its argument and shares in-flight lookups, so an asset that is somehow in
    // both halves still costs one request.
    const records = await assets.resolve([
      ...holdings.map((holding) => holding.asset),
      ...locks.map((offer) => offer.give.asset),
    ])

    const tokens: TokenBalance[] = []
    const items: ItemHolding[] = []
    for (const holding of holdings) {
      const record = records.get(holding.asset)
      if (!record) continue
      const asset = assetFactsFrom(record)
      if (asset.item) {
        items.push({
          asset: asset.asset,
          name: asset.name,
          symbol: asset.symbol,
          count: Number(holding.balance),
          issuer: asset.issuer,
          ...(asset.image === undefined ? {} : { image: asset.image }),
          ...(asset.description === undefined ? {} : { description: asset.description }),
          ...(asset.stats === undefined ? {} : { stats: asset.stats }),
        })
      } else {
        tokens.push({
          asset: asset.asset,
          symbol: asset.symbol,
          name: asset.name,
          amount: fromRaw(BigInt(holding.balance), asset.decimals),
          issuer: asset.issuer,
        })
      }
    }

    // Sorted rather than left in the node's holdings order, because that order
    // is the node's own business: `MockNode` lists assets in the order the
    // account acquired them, while SPEC §7's `holdings` table is keyed
    // `(account, asset_id)` and read as a prefix scan, which is id order. Two
    // nodes holding identical state may therefore list it differently, and a
    // player's inventory must not reshuffle when they switch node. Nothing in
    // this package promised the holdings order before now, so id order is the
    // contract from here, and `summary()` says so.
    // Named from the same cache the spendable rows are named from, so one asset
    // reads the same whichever half of the summary it is currently in.
    const locked: LockedHolding[] = []
    for (const offer of locks) {
      const record = records.get(offer.give.asset)
      if (!record) continue
      const asset = assetFactsFrom(record)
      locked.push({
        asset: asset.asset,
        name: asset.name,
        symbol: asset.symbol,
        amount: offer.give.amount,
        item: asset.item,
        reason: 'offer',
        offer: offer.hash,
        want: {
          asset: offer.want.asset,
          symbol: offer.want.symbol,
          name: offer.want.name,
          amount: offer.want.amount,
        },
        expiresAt: offer.expiresAt,
      })
    }

    tokens.sort(byAssetId)
    items.sort(byAssetId)
    locked.sort(byAssetThenOffer)

    return {
      address: client.address,
      kei: info ? fromRaw(BigInt(info.balance), KEI_DECIMALS) : 0,
      tokens,
      items,
      locked,
      keiLocked: fromRaw(keiLockedRaw, KEI_DECIMALS),
      pending,
    }
  }

  // ------------------------------------------------------------ change events

  interface Subscription {
    listener: (summary: WalletSummary) => void
  }
  const listeners = new Map<(summary: WalletSummary) => void, Subscription>()
  let unsubscribeUpdates: (() => void) | undefined
  let refreshing = false
  let refreshAgain = false
  /**
   * Bumped when the last listener leaves. A refresh that started under an older
   * generation has nobody to tell even if somebody subscribes again while it is
   * still in flight, because the snapshot it is carrying was read before that
   * subscription existed.
   */
  let generation = 0

  const deliver = (snapshot: WalletSummary, audience: readonly Subscription[]): void => {
    for (const subscription of audience) {
      try {
        subscription.listener(snapshot)
      } catch {
        // A listener that throws is the listener's bug. It must not stop the
        // other panels on the page from rendering, and it must not take down
        // the loop that later updates depend on.
      }
    }
  }

  /**
   * One refresh at a time, and never more than one queued behind it.
   *
   * Updates arrive in bursts — claiming a drop, or collecting a batch of
   * arrivals, writes a block each — and a summary per block would put several
   * full scans on the wire at once and then deliver them in completion order,
   * which is not their real order. Collapsing a burst to "the one running, then
   * one more" keeps the last update honoured (whatever landed during the
   * current pass is covered by the pass after it) without ever launching a
   * second scan alongside the first. Running them one after another is also
   * what makes a stale delivery impossible rather than unlikely: there is never
   * an older snapshot in flight to overtake a newer one.
   */
  const refresh = async (): Promise<void> => {
    const mine = generation
    refreshing = true
    try {
      do {
        refreshAgain = false
        // Freeze this pass's audience before its first read. New listeners get
        // only updates whose refresh began after they subscribed.
        const audience = [...listeners.values()]
        // A failed refresh is nobody's to catch — no caller awaited it — so it
        // is dropped rather than left as an unhandled rejection, and the
        // follow-up pass still runs. `summary()` itself still rejects for a
        // caller who did await it, and nothing about the failure is cached, so
        // the next update recovers on its own.
        const snapshot = await summary().then(
          (value) => value,
          () => null,
        )
        if (mine !== generation) return
        if (snapshot) {
          // Decide liveness once, at completion. Subscription identity keeps a
          // removed instance out even when the same callback was added again.
          // Taking this second snapshot also preserves delivery to everyone who
          // was subscribed at completion if one listener removes another while
          // callbacks are being invoked.
          deliver(
            snapshot,
            audience.filter(
              (subscription) => listeners.get(subscription.listener) === subscription,
            ),
          )
        }
      } while (refreshAgain)
    } finally {
      refreshing = false
      const rerun = refreshAgain && listeners.size > 0
      refreshAgain = false
      // The last listener can leave while a refresh is in flight, then a new
      // generation can subscribe and receive an update before the abandoned
      // pass settles. That update belongs to the new generation: start its pass
      // now instead of letting the old pass's cleanup swallow it.
      if (rerun) void refresh()
    }
  }

  return {
    summary,
    // The key stays inside the client, which is the whole point of routing this
    // through the wallet rather than handing a game the seed to derive one.
    signOwnershipChallenge: (challenge) => client.signOwnershipChallenge(challenge),
    on(event, listener) {
      if (event !== 'change') return () => undefined
      // Match the SDK emitter contract: registering the same callback twice is
      // one listener. The subscription object is still an incarnation token,
      // so unsubscribe/re-subscribe cannot revive an older refresh audience.
      const subscription = listeners.get(listener) ?? { listener }
      listeners.set(listener, subscription)
      // Every block this wallet writes, and every arrival it collects, can move
      // one of the numbers above. Subscribed to once for the whole wallet,
      // however many panels are mounted on it.
      unsubscribeUpdates ??= client.on('update', () => {
        if (refreshing) {
          refreshAgain = true
          return
        }
        void refresh()
      })

      return () => {
        if (listeners.get(listener) !== subscription) return
        listeners.delete(listener)
        if (listeners.size > 0) return
        // Nobody left to tell. Stop listening to the client, and let any
        // refresh already in flight finish without delivering to anyone.
        generation++
        unsubscribeUpdates?.()
        unsubscribeUpdates = undefined
      }
    },
  }
}

export { WalletPanel } from './panel.js'
export {
  DEFAULT_ASSET_CACHE_LIMIT,
  DEFAULT_ASSET_CONCURRENCY,
  MAX_ASSET_CACHE_LIMIT,
  MAX_ASSET_CONCURRENCY,
} from './assets.js'
export type {
  WalletPanelCustody,
  WalletPanelHandle,
  WalletPanelKei,
  WalletPanelOptions,
  WalletPanelSection,
  WalletPanelTheme,
  WalletPanelThemeVars,
} from './panel.js'
