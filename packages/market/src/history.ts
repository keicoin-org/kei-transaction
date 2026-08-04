/**
 * Price history, read from the chain (SPEC §9.1).
 *
 * There is no time-series database here and there is not going to be one: a
 * settled offer *is* a trade, the offer block is on its author's chain, and the
 * accept block is on the accepter's. So "what did swords go for?" is a bounded
 * walk of the chains you name, and the caveat §9.1 states plainly holds — the
 * useful history has to be concentrated in a few chains, because nothing here
 * sweeps the ledger.
 *
 * The honest limit is time. **The block-lattice has no clock** (SPEC §5.5), so a
 * block carries no timestamp a swap could be ordered by. `settledAt` is the
 * node's own first-seen time, which is what Nano's `local_timestamp` is: good
 * enough to hide last month's listings, never good enough to settle a dispute.
 * Everything derived from chain data alone — the median, the range, the volume,
 * the count — is identical on every node. The window that selects the trades is
 * not, and a restarted node forgets it.
 *
 * The second honest limit is *which chains answered*. A price built from four
 * sellers when five were asked is not wrong, but it is not the number the caller
 * thinks it is, and until now this walk swallowed the difference: a chain that
 * threw was skipped in silence, so a summary could quietly describe half a
 * market. It still skips — a chart that vanishes on one timeout is worse — but
 * the trades now carry the same `Coverage` the book has always returned, so
 * `price()` and chart views can label a partial read instead of stating it flat.
 */

import type { AssetId, KeiClient, SwapOffer } from '@keicoin/core'

import type { Offer, PriceSummary, Trade, TradeOptions } from './types.js'
import { assetIdOf, durationMs } from './util.js'
import {
  accountLimitOf,
  coverageOf,
  emptyCoverage,
  isAborted,
  mapConcurrent,
  mergeCoverage,
  walkAccounts,
  withCoverage,
  type Coverage,
  type Covered,
} from './walk.js'

export interface LegMeta {
  asset: AssetId
  symbol: string
  name: string
  decimals: number
}

export interface MarketContext {
  client: KeiClient
  meta(asset: AssetId): Promise<LegMeta>
  now(): number
  /** One raw offer as the public shape. Shared so book and lifecycle agree. */
  toOffer(raw: SwapOffer): Promise<Offer>
}

export async function readTrades(context: MarketContext, options: TradeOptions = {}): Promise<Covered<Trade>> {
  const { client } = context
  const limit = accountLimitOf(options.limit, 'trade history limit')
  const asset = options.asset === undefined ? undefined : assetIdOf(options.asset)
  const quote = options.quote === undefined ? undefined : assetIdOf(options.quote)
  const read = {
    signal: options.signal,
    concurrency: options.concurrency,
    what: 'Reading trade history',
  }

  const found = new Map<string, SwapOffer>()

  const walk = await walkAccounts(
    options.from ?? [client.address],
    async (account) => {
      const raws = await client.node.accountSwaps(account, { limit, state: 'accepted' })
      return { rows: raws, truncated: raws.length >= limit }
    },
    read,
  )
  for (const raw of walk.rows) found.set(raw.hash, raw)

  // A trade this wallet was the *buyer* in is an accept block on its own chain
  // and an offer on somebody else's, so it is invisible to the walk above. It is
  // still this wallet's history, and asking for "my trades" should return it.
  const bought = options.from === undefined ? await readOwnPurchases(context, limit, read) : null

  for (const raw of bought?.rows ?? []) found.set(raw.hash, raw)
  const coverage = mergeCoverage(walk.coverage, bought?.coverage)

  let windowTo: number | undefined
  let since: number | undefined
  if (options.window !== undefined) {
    windowTo = context.now()
    since = windowTo - durationMs(options.window, 'window')
  }

  const matched: SwapOffer[] = []
  for (const raw of found.values()) {
    if (raw.state !== 'accepted') continue
    if (asset !== undefined && raw.asset !== asset && raw.wantAsset !== asset) continue
    if (quote !== undefined && raw.asset !== quote && raw.wantAsset !== quote) continue
    const at = advisoryTimeOf(raw)
    // `settledAt` is preferable, but older or degraded nodes may only retain
    // the first-seen observation. A row with neither usable advisory time is
    // still an observed trade: keep it so callers can report the temporal gap
    // instead of turning partial knowledge into an apparently empty window.
    if (since !== undefined && windowTo !== undefined && at !== null && (at < since || at > windowTo)) continue
    matched.push(raw)
  }

  // Newest first, by the node's local clock — the only ordering available across
  // two chains. The hash breaks ties so the answer is at least stable.
  matched.sort((a, b) => (advisoryTimeOf(b) ?? Number.MIN_SAFE_INTEGER)
    - (advisoryTimeOf(a) ?? Number.MIN_SAFE_INTEGER) || a.hash.localeCompare(b.hash))
  const trimmed = options.last === undefined ? matched : matched.slice(0, Math.max(0, options.last))

  const trades = await mapConcurrent(
    trimmed,
    async (raw): Promise<Trade> => {
      const offer = await context.toOffer(raw)
      return {
        ...offer,
        seller: raw.from,
        buyer: String(raw.acceptedBy),
        state: 'accepted',
        mine: offer.mine || raw.acceptedBy === client.address,
      }
    },
    read,
  )
  return withCoverage(trades, coverage)
}

/** Best usable node-local observation for windowing and advisory ordering. */
function advisoryTimeOf(raw: Pick<SwapOffer, 'settledAt' | 'seenAt'>): number | null {
  if (Number.isSafeInteger(raw.settledAt)) return raw.settledAt as number
  if (Number.isSafeInteger(raw.seenAt)) return raw.seenAt
  return null
}

/**
 * The accepts this wallet wrote, resolved back to the offers they settled.
 *
 * One history read plus one `swap_offer` per accept found — which was a
 * sequential chain of up to `limit` round trips and is now bounded fan-out. A
 * history that came back full is reported as truncated for the same reason a
 * full page of offers is: the chain may hold more purchases than were read.
 */
async function readOwnPurchases(
  context: MarketContext,
  limit: number,
  read: { signal?: AbortSignal; concurrency?: number; what: string },
): Promise<{ rows: SwapOffer[]; coverage: Coverage }> {
  const { client } = context
  const account = client.address
  try {
    const [history = []] = await mapConcurrent(
      [account],
      () => client.node.accountHistory(account, { limit }),
      read,
    )
    const hashes = new Set<string>()
    for (const block of history) {
      if (block.type !== 'asset' || block.op.kind !== 'swap_accept') continue
      hashes.add(block.op.offer)
    }
    const offers = await mapConcurrent([...hashes], (hash) => client.node.swapOffer(hash), read)
    const truncated = history.length >= limit ? [account] : []
    return {
      rows: offers.filter((raw): raw is SwapOffer => raw !== null && raw.state === 'accepted'),
      coverage: {
        ...emptyCoverage(),
        asked: 1,
        read: 1,
        truncated,
        complete: truncated.length === 0,
      },
    }
  } catch (error) {
    if (isAborted(error)) throw error
    // Same bargain as an unreachable seller's chain: the trades this wallet made
    // as a buyer are missing from the answer, and the answer says so.
    return {
      rows: [],
      coverage: {
        ...emptyCoverage(),
        asked: 1,
        read: 0,
        failed: [{ account, reason: error instanceof Error ? error.message : String(error) }],
        complete: false,
      },
    }
  }
}

/**
 * The §9.1 query. `null` when the asset has never traded against this quote,
 * because "no price" and "a price of zero" are different answers.
 */
export function summarise(trades: readonly Trade[], asset: AssetId, quote: AssetId): PriceSummary | null {
  const prices: number[] = []
  let volume = 0
  let last: number | undefined

  for (const trade of trades) {
    const sells = trade.give.asset === asset && trade.want.asset === quote
    const buys = trade.want.asset === asset && trade.give.asset === quote
    if (!sells && !buys) continue
    const units = sells ? trade.give.amount : trade.want.amount
    const paid = sells ? trade.want.amount : trade.give.amount
    if (units <= 0) continue
    prices.push(paid / units)
    volume += units
    // `trades` arrives newest first, so the first match is the latest price.
    last ??= paid / units
  }

  if (prices.length === 0 || last === undefined) return null
  const sorted = [...prices].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2

  return {
    asset,
    quote,
    median,
    last,
    low: sorted[0] as number,
    high: sorted[sorted.length - 1] as number,
    trades: prices.length,
    volume,
    coverage: coverageOf(trades),
  }
}
