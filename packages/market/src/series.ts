/**
 * Prices against time, for something that draws them.
 *
 * A chart wants an ordered list. A block-lattice cannot give it one, and the
 * gap between those two sentences is the whole content of this file — so read
 * the honesty section before shipping anything built on it.
 *
 * ## What is consensus and what is not
 *
 * **Consensus, identical on every node, forever:** that a trade happened, who
 * the two parties were, which assets moved, how many units, and therefore the
 * price. Every statistic derived from those numbers alone — median, low, high,
 * volume, count, and the open/high/low/close *of a given set of trades* — is a
 * fact anybody can recompute and get the same answer.
 *
 * **Not consensus:** *when*. The block-lattice has no clock (SPEC §5.5), and
 * that is deliberate — every deadline in the design was replaced by a signed act
 * by the party whose asset was at stake, precisely so that no block type has to
 * carry a time anybody has to agree on. `settledAt` and `seenAt` are the node's
 * own first-seen times, which is what Nano's `local_timestamp` is: two nodes
 * will disagree, and a restarted node forgets. They are good enough to hide last
 * month's listings and never good enough to settle a dispute.
 *
 * **Ordering is the consequence.** A settled trade is an offer block on one
 * chain and an accept block on another; `height` orders blocks *within* one
 * chain and says nothing across two. So there is no total order over trades, and
 * a series has to pick one. This picks advisory time, says so in the returned
 * value rather than in a comment, and counts the points that had to fall back —
 * because a chart drawn from a node that forgot half its timestamps should be
 * able to admit it.
 *
 * A candle is the same bargain with a bucket around it. The OHLC of a bucket is
 * exact for the trades in that bucket; *which* trades are in it is advisory.
 */

import { fail, type AssetId } from '@keicoin/core'

import type { Duration, PriceSummary, Trade } from './types.js'
import { assetIdOf, durationMs } from './util.js'
import { summarise } from './history.js'
import { coverageOf, withCoverage, withCoverageOn, type Coverage, type Covered } from './walk.js'

/** One settled trade, reduced to the numbers a chart needs. */
export interface PricePoint {
  /** Position in this series, oldest first. Stable for a given set of trades. */
  index: number
  /** Quote units per one unit of the asset. Consensus-derived. */
  price: number
  /** Units of the asset that changed hands. Consensus-derived. */
  units: number
  /** What was paid, in quote units. Consensus-derived. */
  paid: number
  /** The offer block's hash, which is the trade's id. */
  hash: string
  seller: string
  buyer: string
  /**
   * Node-local advisory time in ms, or null when the node has no time for it.
   * **Not consensus** — see the header. Never compare across nodes.
   */
  at: number | null
  /** True when `at` came from `seenAt` because `settledAt` was missing. */
  estimated: boolean
}

/** How a series was put in order, and what that order is worth. */
export interface Ordering {
  /** The only ordering available across two chains, and it is advisory. */
  by: 'advisory-time'
  /** True when every point carried a settlement time of its own. */
  exact: boolean
  /** Points whose time came from `seenAt`, or from nothing at all. */
  estimated: number
  note: string
}

export interface Series {
  asset: AssetId
  quote: AssetId
  /** Oldest first, which is left-to-right on a chart. */
  points: PricePoint[]
  ordering: Ordering
  /** The oldest price in the series, or null when it is empty. */
  first: number | null
  /** The newest. */
  last: number | null
  /** `last - first`. Null on an empty series; zero on a series of one. */
  change: number | null
  /** `change / first`. Null when `first` is zero or the series is empty. */
  changeRatio: number | null
  /** The same numbers `market.price()` gives, over exactly these trades. */
  summary: PriceSummary | null
  /**
   * What the walk behind these trades could not see, or null when they did not
   * come from one.
   *
   * Null is a real answer and not a missing one: `toSeries` is pure, so a caller
   * that built the trades by hand has nothing to be told about coverage. A chart
   * drawn from `market.series()` always has it, and `complete: false` means the
   * line is a floor rather than the whole market's history.
   */
  coverage: Coverage | null
}

export interface SeriesOptions {
  /** The asset the series is about. */
  asset: AssetId | { id: AssetId }
  /** What it is priced in. Default Kei. */
  quote?: AssetId | { id: AssetId }
  /** Keep only the most recent n points, after ordering. */
  last?: number
}

const ORDERING_NOTE =
  'Ordered by the node\'s own first-seen time, which is not consensus — the block-lattice has no clock (SPEC §5.5). Prices, units, and every statistic over them are consensus-derived and identical everywhere; the order and the buckets are this node\'s opinion.'

/**
 * Turn settled trades into an ordered price series.
 *
 * Pure: it takes the trades `market.trades()` already read and does arithmetic.
 * Nothing here touches the network, so a view that already has the trades draws
 * a chart and a table off one walk instead of two.
 */
export function toSeries(trades: readonly Trade[], options: SeriesOptions): Series {
  const asset = assetIdOf(options.asset)
  const quote = options.quote === undefined ? undefined : assetIdOf(options.quote)

  const matched: Trade[] = []
  const points: Omit<PricePoint, 'index'>[] = []

  for (const trade of trades) {
    const sells = trade.give.asset === asset && (quote === undefined || trade.want.asset === quote)
    const buys = trade.want.asset === asset && (quote === undefined || trade.give.asset === quote)
    if (!sells && !buys) continue
    const units = sells ? trade.give.amount : trade.want.amount
    const paid = sells ? trade.want.amount : trade.give.amount
    if (units <= 0) continue

    matched.push(trade)
    points.push({
      price: paid / units,
      units,
      paid,
      hash: trade.hash,
      seller: trade.seller,
      buyer: trade.buyer,
      at: trade.settledAt ?? trade.seenAt,
      estimated: trade.settledAt === null,
    })
  }

  // Oldest first — a chart reads left to right, and `market.trades()` answers
  // newest first because a list reads top down. The hash breaks ties so two
  // trades the node saw in the same millisecond at least draw in a stable order.
  points.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.hash.localeCompare(b.hash))
  const kept = options.last === undefined ? points : points.slice(Math.max(0, points.length - options.last))

  const ordered: PricePoint[] = kept.map((point, index) => ({ ...point, index }))
  const first = ordered[0]?.price ?? null
  const last = ordered[ordered.length - 1]?.price ?? null
  const estimated = ordered.filter((point) => point.estimated).length

  const keptHashes = new Set(ordered.map((point) => point.hash))
  // The summary is over a locally-filtered copy, so it has no coverage of its
  // own — but it is a statement about the same walk, and it says so.
  const carried = coverageOf(trades)
  const computed = summarise(
    matched.filter((trade) => keptHashes.has(trade.hash)),
    asset,
    quote ?? (ordered.length > 0 ? quoteOf(matched, asset) : asset),
  )
  const summary = computed === null ? null : { ...computed, coverage: carried }

  return {
    asset,
    quote: quote ?? summary?.quote ?? asset,
    points: ordered,
    ordering: {
      by: 'advisory-time',
      exact: estimated === 0,
      estimated,
      note: ORDERING_NOTE,
    },
    first,
    last,
    change: first === null || last === null ? null : last - first,
    changeRatio: first === null || last === null || first === 0 ? null : (last - first) / first,
    summary,
    coverage: carried,
  }
}

export interface Candle {
  /** Bucket start, in node-local advisory ms. Not consensus — see the header. */
  at: number
  /** Bucket width in ms, so a renderer needs no second argument. */
  every: number
  open: number
  high: number
  low: number
  close: number
  /** Units of the asset that changed hands in this bucket. */
  volume: number
  trades: number
}

/**
 * Candles `fill: true` may emit when the caller names no `maxCandles`.
 *
 * Dense filling is the one thing in this file whose output is not proportional
 * to its input. It materialises every empty bucket between the first trade and
 * the last, so the size is decided by two advisory timestamps and `every`
 * rather than by how many trades were read: one millisecond across one day is
 * 86,400,001 objects, and thirty days is two and a half billion. Two trades are
 * enough to ask for either, and a browser or Worker that starts building them
 * has already lost the frame.
 *
 * Ten thousand is past the pixel columns of any screen a chart is drawn on, so
 * a request above it is asking for data rather than a picture — which is a
 * decision worth making on purpose, through `maxCandles`, rather than by
 * default. Sparse output is not subject to this at all: `fill: false` stays
 * proportional to the buckets that actually traded.
 */
export const DEFAULT_MAX_CANDLES = 10_000

/**
 * The largest `maxCandles` a caller may ask for.
 *
 * A raised budget is still a budget. A hundred times the default is a large
 * array that a Node or Worker caller can decide to hold, and it is still a
 * finite number reached deliberately — which is the whole distance between
 * this and the unbounded allocation the bound exists to refuse. Past it,
 * bucket wider or page the window; the answer is not a longer array.
 */
export const MAX_CANDLES = 1_000_000

export interface CandleOptions extends SeriesOptions {
  /** Bucket width: `'1h'`, `'15m'`, `'7d'`, or a number of milliseconds. */
  every: Duration
  /** Emit empty buckets between trades, so the x-axis is even. Default false. */
  fill?: boolean
  /**
   * Most candles `fill: true` may emit. Whole number from 1 through
   * `MAX_CANDLES`; `DEFAULT_MAX_CANDLES` by default. A dense request projected
   * past it throws `too-many-candles` before anything is allocated.
   *
   * This bounds *generated* output. `limit` bounds the rows read from each
   * account, and no read limit bounds this: two trades already carry the two
   * timestamps that decide the span.
   */
  maxCandles?: number
}

/** `every` as a bucket width the arithmetic below can actually count in. */
function candleWidthOf(value: Duration): number {
  const every = durationMs(value, 'every')
  // `durationMs` floors, so a positive fraction — `0.5`, or `'0.1ms'` — arrives
  // here as zero, and a unit multiplication can leave safe integer range
  // outright. Both used to reach the bucket arithmetic and draw `at: NaN`.
  if (!Number.isSafeInteger(every) || every < 1) {
    fail(
      'bad-duration',
      `every is a bucket width, so it has to be a whole number of milliseconds a bucket can be counted in — at least 1ms, and no wider than ${Number.MAX_SAFE_INTEGER}ms. Got ${String(value)}, which normalises to ${String(every)}ms.`,
    )
  }
  return every
}

/** Resolve the dense-fill budget without letting an option make it unbounded. */
function candleBudgetOf(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_MAX_CANDLES
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > MAX_CANDLES) {
    fail(
      'bad-max-candles',
      `maxCandles is how many candles fill: true may emit — a whole number from 1 through ${MAX_CANDLES}, and ${DEFAULT_MAX_CANDLES} by default. Got ${String(requested)}.`,
    )
  }
  return requested
}

const MIN_SAFE_TIME = BigInt(Number.MIN_SAFE_INTEGER)
const MAX_SAFE_TIME = BigInt(Number.MAX_SAFE_INTEGER)

/** A safe bucket start, using mathematical floor rather than truncation toward zero. */
function candleStartOf(at: number, every: number): number {
  if (!Number.isSafeInteger(at)) {
    fail(
      'bad-candle-time',
      `A candle's advisory time must be a safe whole number of milliseconds — got ${String(at)}. Use a timestamp from ${Number.MIN_SAFE_INTEGER} through ${Number.MAX_SAFE_INTEGER}.`,
    )
  }
  const time = BigInt(at)
  const width = BigInt(every)
  const quotient = time < 0n ? -((-time + width - 1n) / width) : time / width
  const start = quotient * width
  if (start < MIN_SAFE_TIME || start > MAX_SAFE_TIME) {
    fail(
      'bad-candle-time',
      `Advisory time ${at}ms at ${every}ms starts a bucket outside JavaScript's safe whole-millisecond range. Use a timestamp and interval whose bucket start stays from ${Number.MIN_SAFE_INTEGER} through ${Number.MAX_SAFE_INTEGER}.`,
    )
  }
  return Number(start)
}

/**
 * How many candles a dense fill would emit, exactly.
 *
 * `BigInt` because the count is the number being trusted: the span between two
 * advisory times can be the whole safe integer range, and `lastAt - firstAt` in
 * doubles stops being exact well before the fill loop would stop running — so a
 * projection computed the obvious way could under-report the very allocation it
 * is there to refuse. Both bounds are already exact multiples of `every`, so
 * the division loses nothing and truncation never rounds a bucket away.
 */
function projectedCandles(firstAt: number, lastAt: number, every: number): bigint {
  if (!Number.isSafeInteger(firstAt) || !Number.isSafeInteger(lastAt)) {
    fail(
      'too-many-candles',
      `Cannot safely project filled candles across advisory bucket times ${String(firstAt)}..${String(lastAt)} at ${every}ms: the span and projected count are outside safe integer time. Use fill: false, a wider interval, or a smaller window/last.`,
    )
  }
  const width = BigInt(every)
  return BigInt(lastAt) / width - BigInt(firstAt) / width + 1n
}

/**
 * OHLCV buckets.
 *
 * The values inside a bucket are exact. Which trades land in which bucket is
 * advisory, for the reason in the header, so a candle chart here is an honest
 * summary of what the node saw rather than a market data feed. `fill` exists
 * because an uneven x-axis reads as missing data; empty buckets carry the
 * previous close on all four prices and zero volume, which is what "nothing
 * traded" actually looks like — and it is bounded, for the reason on
 * `DEFAULT_MAX_CANDLES`.
 */
export function toCandles(trades: readonly Trade[], options: CandleOptions): Candle[] {
  // Both options are checked before a trade is read, so a malformed width or
  // budget is a refusal about the call rather than about the data behind it.
  const every = candleWidthOf(options.every)
  const budget = candleBudgetOf(options.maxCandles)
  const series = toSeries(trades, options)
  const carried = coverageOf(trades)
  if (series.points.length === 0) {
    const empty: Candle[] = []
    return carried === null ? empty : withCoverage(empty, carried)
  }

  const buckets = new Map<number, Candle>()
  for (const point of series.points) {
    // A point with no time at all cannot be bucketed, and putting it at the
    // epoch would draw a candle in 1970. Dropping it is the honest loss.
    if (point.at === null) continue
    const at = candleStartOf(point.at, every)
    const bucket = buckets.get(at)
    if (!bucket) {
      buckets.set(at, {
        at,
        every,
        open: point.price,
        high: point.price,
        low: point.price,
        close: point.price,
        volume: point.units,
        trades: 1,
      })
      continue
    }
    bucket.high = Math.max(bucket.high, point.price)
    bucket.low = Math.min(bucket.low, point.price)
    bucket.close = point.price
    bucket.volume += point.units
    bucket.trades += 1
  }

  const filled = [...buckets.values()].sort((a, b) => a.at - b.at)
  if (options.fill !== true || filled.length < 2) {
    return carried === null ? filled : withCoverage(filled, carried)
  }

  const firstAt = (filled[0] as Candle).at
  const lastAt = (filled[filled.length - 1] as Candle).at
  const projected = projectedCandles(firstAt, lastAt, every)
  if (projected > BigInt(budget)) {
    const span = BigInt(lastAt) - BigInt(firstAt)
    fail(
      'too-many-candles',
      `Filling the ${span}ms span at ${every}ms would emit ${projected} candles, above maxCandles (${budget}). Use fill: false, a wider interval, a smaller read window/last, or explicitly raise maxCandles no higher than MAX_CANDLES (${MAX_CANDLES}).`,
    )
  }

  const even: Candle[] = []
  for (const candle of filled) {
    const previous = even[even.length - 1]
    if (previous) {
      for (let at = previous.at + every; at < candle.at; at += every) {
        even.push({
          at,
          every,
          open: previous.close,
          high: previous.close,
          low: previous.close,
          close: previous.close,
          volume: 0,
          trades: 0,
        })
      }
    }
    even.push(candle)
  }
  return carried === null ? even : withCoverage(even, carried)
}

export interface PriceIndexOptions {
  /** What everything is priced in. Default: whatever each trade's other leg was. */
  quote?: AssetId | { id: AssetId }
  /** Only these assets. Default: every asset that appears in the trades. */
  assets?: Iterable<AssetId | { id: AssetId }>
}

/**
 * Every traded asset's summary, and what the walk behind them could not see.
 *
 * A `Map` first and foremost — `get`, `has`, `size` and iteration are unchanged.
 * `coverage` is null when the trades did not come from a walk, on the same terms
 * as `Series.coverage`.
 */
export type PriceIndex = Map<AssetId, PriceSummary> & { readonly coverage: Coverage | null }

/**
 * Every asset's price summary, out of one walk.
 *
 * `market.price()` answers for one asset, and a hall with fifteen archetypes on
 * the board asking it fifteen times re-reads the same chains fifteen times. The
 * trades are the same set either way, so this groups them once — which is
 * exactly the loop `world-of-wonder` wrote by hand in its auction house, for
 * exactly this reason.
 */
export function priceIndex(trades: readonly Trade[], options: PriceIndexOptions = {}): PriceIndex {
  const quote = options.quote === undefined ? undefined : assetIdOf(options.quote)
  const only =
    options.assets === undefined ? undefined : new Set([...options.assets].map((asset) => assetIdOf(asset)))

  const grouped = new Map<AssetId, Trade[]>()
  for (const trade of trades) {
    for (const [asset, against] of [
      [trade.give.asset, trade.want.asset],
      [trade.want.asset, trade.give.asset],
    ] as const) {
      if (asset === against) continue
      if (quote !== undefined && against !== quote) continue
      if (only !== undefined && !only.has(asset)) continue
      const list = grouped.get(asset)
      if (list) list.push(trade)
      else grouped.set(asset, [trade])
    }
  }

  const carried = coverageOf(trades)
  const index = new Map<AssetId, PriceSummary>()
  for (const [asset, matched] of grouped) {
    const against = quote ?? quoteOf(matched, asset)
    const summary = summarise(matched, asset, against)
    // Every row is a statement about the same walk, so every row carries it.
    if (summary) index.set(asset, { ...summary, coverage: carried })
  }
  return withCoverageOn(index, carried)
}

/** The other leg of the first trade that names this asset. */
function quoteOf(trades: readonly Trade[], asset: AssetId): AssetId {
  for (const trade of trades) {
    if (trade.give.asset === asset) return trade.want.asset
    if (trade.want.asset === asset) return trade.give.asset
  }
  return asset
}
