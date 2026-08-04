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
 */

import type { AssetId, KeiClient } from '@keicoin/core'
import { KEI_DECIMALS, fail, fromRaw } from '@keicoin/core'
import type { ItemStats } from '@keicoin/tokens'
import type { ClaimsApi, PendingClaim } from '@keicoin/claims'
import {
  AssetFactsCache,
  DEFAULT_ASSET_CACHE_LIMIT,
  DEFAULT_ASSET_CONCURRENCY,
  MAX_ASSET_CACHE_LIMIT,
  MAX_ASSET_CONCURRENCY,
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

export interface WalletSummary {
  address: string
  kei: number
  /** Ascending by `asset` id — see `WalletApi.summary`. */
  tokens: TokenBalance[]
  /** Ascending by `asset` id — see `WalletApi.summary`. */
  items: ItemHolding[]
  pending: PendingClaim[]
}

export interface WalletApi {
  /**
   * A fresh read of the account: balance, holdings, and pending claims are
   * fetched every time. Only the assets' issuance metadata is remembered
   * between calls, and none of that can change (SPEC §5.3, §5.4).
   *
   * `tokens` and `items` are each **ascending by asset id**. That is the order
   * regardless of the order the node listed the holdings in and regardless of
   * which metadata lookup answered first, so two refreshes that found the same
   * things render the same way round.
   */
  summary(): Promise<WalletSummary>
  on(event: 'change', listener: (summary: WalletSummary) => void): () => void
}

export interface WalletOptions {
  claims?: ClaimsApi
  /**
   * How many asset-metadata lookups this wallet may have in flight at once,
   * counted across every `summary()` call and refresh it is running rather than
   * per call. Defaults to 8.
   *
   * Raise it when talking to a node you run yourself; the default is sized for
   * the shared public one (see assets.ts). Must be a whole number from 1
   * through 32.
   */
  assetConcurrency?: number
  /**
   * How many assets' immutable metadata this wallet remembers before evicting
   * the least recently used. Defaults to 2,048 — twice SPEC §7's hard cap of
   * 1,024 distinct assets per account. Must be a whole number from 1 through
   * 8,192; there is no unbounded setting.
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

export function createWallet(client: KeiClient, options: WalletOptions = {}): WalletApi {
  const assets = new AssetFactsCache(
    client.node,
    positiveInteger(
      options.assetCacheLimit,
      DEFAULT_ASSET_CACHE_LIMIT,
      'assetCacheLimit',
      MAX_ASSET_CACHE_LIMIT,
    ),
    positiveInteger(
      options.assetConcurrency,
      DEFAULT_ASSET_CONCURRENCY,
      'assetConcurrency',
      MAX_ASSET_CONCURRENCY,
    ),
  )

  const summary = async (): Promise<WalletSummary> => {
    // Everything mutable, read fresh every time: the Kei balance, what the
    // account holds, and what it has yet to claim. None of this is ever served
    // from a cache — only the issuance metadata below is.
    const [info, holdings, pending] = await Promise.all([
      client.node.accountInfo(client.address),
      client.node.holdings(client.address),
      options.claims ? options.claims.pending() : Promise.resolve<PendingClaim[]>([]),
    ])

    const facts = await assets.resolve(holdings.map((holding) => holding.asset))

    const tokens: TokenBalance[] = []
    const items: ItemHolding[] = []
    for (const holding of holdings) {
      const asset = facts.get(holding.asset)
      if (!asset) continue
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
    tokens.sort(byAssetId)
    items.sort(byAssetId)

    return {
      address: client.address,
      kei: info ? fromRaw(BigInt(info.balance), KEI_DECIMALS) : 0,
      tokens,
      items,
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
