/**
 * The asset metadata behind `wallet.summary()`.
 *
 * A wallet holding N assets used to ask the node about them one at a time, so a
 * hundred items cost a hundred round trips end to end. Items are a first-class
 * Kei use case (SPEC §7), so a hundred of them is the ordinary case rather than
 * the pathological one. Two things fix that, and both are in this file: fetch
 * the ones that are not known yet a few at a time, and never ask twice for
 * something that cannot change.
 *
 * **What may be cached, and why.** An asset's issuance record is immutable:
 * "Issuance is permanent and its parameters immutable" (SPEC §5.3), every token
 * "declares its policy at issuance, and the policy is immutable" (§5.4), and
 * name, description, and the image pointer are "carried on the issuance record"
 * (§7). So an asset's id, issuer, name, symbol, decimals, image, and
 * description answer the same forever, and a second question about them is a
 * wasted request.
 *
 * `AssetInfo` also carries `circulating` — "raw units currently in existence"
 * (§5.6.6) — which every mint and burn moves. `AssetFacts` deliberately has no
 * such field. Narrowing at the fetch, rather than caching the whole record and
 * being careful at each read, is what makes a stale supply number
 * unrepresentable here rather than merely avoided. Balances, holdings, account
 * info, and pending claims are mutable in the same way and are never cached at
 * all: `summary()` re-reads them every time.
 */

import type { AssetId, AssetInfo, KeiNode } from '@keicoin/core'
import { decodeDescription, looksLikeItem } from '@keicoin/tokens'
import type { ItemStats } from '@keicoin/tokens'

/**
 * How many uncached asset lookups one wallet keeps in flight at once.
 *
 * The bound is here because nothing below it imposes one. `HttpNode` bounds how
 * long a single request may take and how often a subscription may poll, but it
 * has no cap on how many requests are outstanding at once, and neither `fetch`
 * in Node nor in Bun imposes a useful per-origin ceiling of its own. So the
 * number of sockets a wallet opens the moment a player looks at their inventory
 * is decided here or nowhere.
 *
 * What it is protecting is stated in the SPEC rather than guessed: "the project
 * runs one public testnet node, rate-limited, explicitly best-effort, with no
 * uptime promise" (§15, settled decisions), on the one-box budget of §5.9. An
 * inventory scan that fans out to a socket per item is a request storm dressed
 * as an optimisation, and the account cap in §7 puts the worst case at 1,024 of
 * them.
 *
 * The win is in the shape rather than the size. N uncached lookups take
 * `ceil(N / limit)` waves instead of N, so the per-request latency stops
 * multiplying by inventory size:
 *
 * | holdings | serial | limit 4 | limit 8 | limit 16 |
 * |---|---|---|---|---|
 * | 25 | 25 | 7 | 4 | 2 |
 * | 100 | 100 | 25 | 13 | 7 |
 * | 1,024 (§7 cap) | 1,024 | 256 | 128 | 64 |
 *
 * Eight is the point where that table has already done its work — it turns the
 * hundred-item case into thirteen waves, and doubling it again saves six more
 * while doubling what one page aims at one rate-limited box. It is a deliberate
 * default rather than a measured optimum, which is why `assetConcurrency` on
 * `createWallet` exists: a game talking to its own node can raise it, and the
 * number that is right for a dedicated node is not knowable from here.
 */
export const DEFAULT_ASSET_CONCURRENCY = 8

/** Highest supported metadata concurrency for one wallet. */
export const MAX_ASSET_CONCURRENCY = 32

/**
 * How many assets' metadata one wallet remembers.
 *
 * SPEC §7 sets "a hard cap of 1,024 distinct assets per account", so twice that
 * is always more than everything a wallet can hold at one instant; the cap only
 * ever bites on a session that has churned through more assets than it holds.
 * Eviction is least-recently-used, so nothing a player is currently looking at
 * falls out, and an evicted asset costs exactly one request to learn again. The
 * cap exists because a session that runs for days should not grow a map for
 * ever, not because anything here is expected to reach it.
 */
export const DEFAULT_ASSET_CACHE_LIMIT = 2_048

/**
 * Everything the summary needs from an asset, and nothing that can change.
 *
 * `item` is `looksLikeItem` resolved once at the fetch: it reads `kind`,
 * `decimals` and `image`, all of them issuance metadata, so the answer is as
 * permanent as the fields behind it.
 */
export interface AssetFacts {
  asset: AssetId
  name: string
  symbol: string
  issuer: string
  decimals: number
  /** Whether this shows as an item rather than a currency. */
  item: boolean
  image?: string
  /** Prose only: the stat block packed in alongside it is split out. */
  description?: string
  stats?: ItemStats
}

export function assetFactsFrom(info: AssetInfo): AssetFacts {
  const base = {
    asset: info.id,
    name: info.name,
    symbol: info.symbol,
    issuer: info.issuer,
    decimals: info.decimals,
  }
  if (!looksLikeItem(info)) return { ...base, item: false }
  const { description, stats } = decodeDescription(info.description)
  return {
    ...base,
    item: true,
    ...(info.image === undefined ? {} : { image: info.image }),
    ...(description === undefined ? {} : { description }),
    ...(stats === undefined ? {} : { stats }),
  }
}

/**
 * Lets at most `limit` pieces of work run at once, first come first served.
 *
 * A slot is handed straight from the task releasing it to the next task
 * waiting, rather than freed and re-taken, so there is no window in which a
 * task that arrived later can take a slot ahead of one already queued for it.
 */
class Gate {
  private held = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.held < this.limit) this.held++
    else await new Promise<void>((take) => this.waiting.push(take))
    try {
      return await work()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.held--
    }
  }
}

/**
 * One wallet's memory of the assets it has looked at.
 *
 * Lifetime is the wallet object's: it is created with the wallet and goes away
 * with it, which for a player is the page. There is no expiry and no
 * invalidation step, because there is no event that could make an entry wrong —
 * the chain has no operation that edits an issuance record, so an entry that
 * was right when it was written stays right. Eviction is capacity only, least
 * recently used first.
 *
 * The concurrency bound belongs to the cache rather than to one `resolve()`
 * call, and that is the whole point of it living here. Two overlapping
 * summaries asking about *different* assets are still two sets of requests from
 * one wallet at one node, so a per-call bound would let them add up; a wallet
 * that promises at most eight outstanding lookups has to count them somewhere
 * that outlives the call.
 *
 * An asset the node cannot resolve is **not** remembered as absent, and neither
 * is one whose lookup failed. A holding whose asset does not answer is a node
 * that is behind or a request that broke, not a fact about the chain, so the
 * next summary asks again and the wallet recovers on its own.
 */
export class AssetFactsCache {
  private readonly known = new Map<AssetId, AssetFacts>()
  /** In-flight lookups, so overlapping summaries share one request per asset. */
  private readonly asking = new Map<AssetId, Promise<AssetFacts | null>>()
  private readonly gate: Gate

  constructor(
    private readonly node: Pick<KeiNode, 'assetInfo'>,
    private readonly limit: number = DEFAULT_ASSET_CACHE_LIMIT,
    concurrency: number = DEFAULT_ASSET_CONCURRENCY,
  ) {
    this.gate = new Gate(concurrency)
  }

  /** How many assets are currently remembered. */
  get size(): number {
    return this.known.size
  }

  /**
   * Facts for every asset given, minus any the node did not answer for.
   * Duplicates ask once, cached ids cost nothing, and the rest queue behind the
   * wallet-wide concurrency bound.
   *
   * Rejects if a lookup rejects, which is what `summary()` did before any of
   * this existed: a network error is the caller's to see, not something to
   * quietly render as an empty inventory.
   */
  async resolve(assets: readonly AssetId[]): Promise<ReadonlyMap<AssetId, AssetFacts>> {
    const out = new Map<AssetId, AssetFacts>()
    const missing: AssetId[] = []
    for (const asset of new Set(assets)) {
      const known = this.recall(asset)
      if (known) out.set(asset, known)
      else missing.push(asset)
    }

    const fetched = await Promise.all(missing.map((asset) => this.lookUp(asset)))
    for (const [index, facts] of fetched.entries()) {
      if (facts) out.set(missing[index] as AssetId, facts)
    }
    return out
  }

  private recall(asset: AssetId): AssetFacts | undefined {
    const facts = this.known.get(asset)
    if (!facts) return undefined
    // Re-inserting moves it to the end of the Map's own insertion order, which
    // is what makes the eviction below least-recently-used rather than oldest.
    this.known.delete(asset)
    this.known.set(asset, facts)
    return facts
  }

  private lookUp(asset: AssetId): Promise<AssetFacts | null> {
    const asking = this.asking.get(asset)
    if (asking) return asking

    const request = this.gate
      .run(() => this.node.assetInfo(asset))
      .then((info) => {
        if (!info) return null
        const facts = assetFactsFrom(info)
        this.remember(asset, facts)
        return facts
      })
      .finally(() => {
        this.asking.delete(asset)
      })

    this.asking.set(asset, request)
    return request
  }

  private remember(asset: AssetId, facts: AssetFacts): void {
    this.known.set(asset, facts)
    while (this.known.size > this.limit) {
      const oldest = this.known.keys().next()
      if (oldest.done) break
      this.known.delete(oldest.value)
    }
  }
}
