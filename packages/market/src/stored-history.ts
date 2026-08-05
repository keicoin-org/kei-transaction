/**
 * Item price history off the store, without rounding on the way out.
 *
 * `market.series()` and `market.candles()` answer the same question from a live
 * account walk, and every number they hand back is a JavaScript `double`
 * because that is what a chart library takes. That is fine for drawing and
 * wrong for accounting: two settlements one raw unit apart are the same double
 * (#102), and a store exists precisely so somebody can audit a chart back to
 * ledger terms months later.
 *
 * So everything here is a raw integer string or an exact rational, and every
 * lossy number is called `display` and documented as one. The rule is worth
 * stating once: **a `display` field is for rendering, and never the value you
 * pass back into a call.** `raw`, `numerator` and `denominator` are.
 *
 * The second rule this file exists to keep is that a per-unit price and a lot
 * total are different quantities (#132, world-of-wonder#14). A settled row has
 * both: `baseQuantity` is how many units moved, `quoteTotal` is what the whole
 * lot cost, and `unitPrice` is the second divided by the first. No field that
 * reads as per-unit was ever written from a total.
 *
 * What it cannot fix: *when*. Times are the node's own observations, the store
 * says so on every page, and `sourceBackfill` stays incomplete because today's
 * `account_swaps` cannot prove an older trade does not exist (kei-node#27).
 */

import { fail, fromRaw, type AssetId } from '@keicoin/core'

import { candleStartOf } from './series.js'
import type { MarketStore, StoredMarketCoverage, StoredMarketOffer } from './store.js'
import type { Duration } from './types.js'
import { assetDecimalsOf, assetIdOf, durationMs, parseMarketTime, rawAmountOf } from './util.js'

const DEFAULT_STORED_INTERVAL: Duration = '1h'
/** Significant scale for every `display` conversion of an exact ratio. */
const DISPLAY_SCALE = 10n ** 18n

/** An asset as the chain names it. The id is present; it is never the only thing shown (#130). */
export interface StoredAssetIdentity {
  readonly asset: AssetId
  readonly symbol: string
  readonly name: string
  readonly decimals: number
}

/** Resolve an asset id to its on-chain name. `market.stored()` passes the client's own. */
export type StoredAssetLookup = (asset: AssetId) => StoredAssetIdentity | Promise<StoredAssetIdentity>

/** An exact rational. `numerator` may be negative; `denominator` never is. */
export interface ExactRatio {
  readonly numerator: string
  readonly denominator: string
  /** Lossy decimal for rendering. Never pass this back into a call. */
  readonly display: number
}

export interface ExactUnitPrice extends ExactRatio {
  /** Quote units for one whole unit of base. Both legs are display-scaled. */
  readonly priceUnit: 'quote-per-base'
}

export interface ExactAmount {
  readonly asset: StoredAssetIdentity
  /** Exact ledger units, and the value that round-trips. */
  readonly raw: string
  /** Lossy decimal for rendering. Never pass this back into a call. */
  readonly display: number
}

export interface StoredTradePoint {
  /** Position within this page, in the requested order. */
  readonly index: number
  /** The offer block's hash, which is the trade's id. */
  readonly hash: string
  readonly seller: string
  readonly buyer: string
  /** `ask` when the seller gave base, `bid` when they gave quote. */
  readonly side: 'ask' | 'bid'
  /** Units of base that changed hands. A lot size, never a price. */
  readonly baseQuantity: ExactAmount
  /** What the whole lot cost, in quote units. A total, never a per-unit price. */
  readonly quoteTotal: ExactAmount
  /** `quoteTotal` per one unit of base. Derived from the two above, exactly. */
  readonly unitPrice: ExactUnitPrice
  /** Node-local advisory settlement time in ms. Not consensus; never compare across nodes. */
  readonly at: number
  readonly settledBy: string | null
  readonly provenance: StoredMarketOffer['provenance']
}

export interface StoredCandle {
  /** Bucket start in node-local advisory ms. */
  readonly at: number
  readonly every: number
  readonly open: ExactUnitPrice
  readonly high: ExactUnitPrice
  readonly low: ExactUnitPrice
  readonly close: ExactUnitPrice
  /** Base units traded in this bucket, summed as integers. */
  readonly baseVolume: ExactAmount
  /** Quote units paid in this bucket, summed as integers. A turnover, not a price. */
  readonly quoteTurnover: ExactAmount
  readonly trades: number
}

export interface StoredPriceSummary {
  readonly first: ExactUnitPrice
  readonly last: ExactUnitPrice
  readonly low: ExactUnitPrice
  readonly high: ExactUnitPrice
  /**
   * Exact median unit price. An even count averages the two middle prices as a
   * reduced rational, so the answer is defined rather than nearly right.
   */
  readonly median: ExactUnitPrice
  /** `last - first`, exactly. Negative numerator means the price fell. */
  readonly change: ExactRatio
  /** `change / first`, exactly. */
  readonly changeRatio: ExactRatio
  readonly baseVolume: ExactAmount
  readonly quoteTurnover: ExactAmount
  readonly trades: number
}

export interface StoredInstrumentIdentity {
  /** `SYMBOL/SYMBOL`, from the chain's own asset names. */
  readonly id: string
  readonly base: StoredAssetIdentity
  readonly quote: StoredAssetIdentity
  readonly priceUnit: 'quote-per-base'
}

export interface StoredHistoryPagination {
  /** Round-trip this to read the next page. Opaque, and it survives a restart. */
  readonly cursor: string | null
  /** True when this page reached the end of the stored rows for the query. */
  readonly complete: boolean
  readonly note: string
}

export interface StoredTimeQuality {
  readonly basis: 'node-first-seen'
  /** Points placed in this page's order and buckets. */
  readonly timed: number
  readonly note: string
}

export interface StoredTrades {
  readonly instrument: StoredInstrumentIdentity
  readonly order: 'oldest' | 'newest'
  readonly points: readonly StoredTradePoint[]
  readonly requested: { readonly from: number | null; readonly to: number | null }
  readonly observed: { readonly from: number | null; readonly to: number | null }
  readonly time: StoredTimeQuality
  readonly coverage: StoredMarketCoverage
  readonly pagination: StoredHistoryPagination
}

export interface StoredHistory extends StoredTrades {
  readonly interval: { readonly input: Duration; readonly milliseconds: number }
  readonly candles: readonly StoredCandle[]
  readonly summary: StoredPriceSummary | null
}

export interface StoredHistoryQuery {
  /** Candle width. Default `'1h'`. */
  readonly interval?: Duration
  /** Inclusive advisory lower bound. */
  readonly from?: number | Date
  /** Inclusive advisory upper bound. Defaults to the clock when `window` is given. */
  readonly to?: number | Date
  /** Width backwards from `to`, when no `from` is given. */
  readonly window?: Duration
  /** Rows on this page. 1 through 256; default 50. */
  readonly limit?: number
  /** A cursor from a previous page's `pagination.cursor`. */
  readonly cursor?: string
  /** `oldest` reads left to right, which is what a chart wants. Default `oldest`. */
  readonly order?: 'oldest' | 'newest'
  readonly deadlineMs?: number
  readonly signal?: AbortSignal
}

export interface StoredHistoryOptions {
  readonly store: MarketStore
  /** Canonical network namespace. Identities from another network are other keys. */
  readonly network: string
  readonly base: AssetId | { id: AssetId }
  readonly quote: AssetId | { id: AssetId }
  /** How an asset id becomes a name. Required: a 64-hex id is not a label (#130). */
  readonly assets: StoredAssetLookup
  readonly now?: () => number
}

export interface StoredHistoryApi {
  /** One page of settled rows as exact points. */
  trades(query?: StoredHistoryQuery): Promise<StoredTrades>
  /** The same page, plus exact candles and an exact summary over it. */
  history(query?: StoredHistoryQuery): Promise<StoredHistory>
}

const PAGE_NOTE =
  'Candles and the summary describe the rows on this page only, so the bucket at a page edge can still gain trades from the next page. Read on with pagination.cursor until complete is true.'
const TIME_NOTE =
  "Times are this node's own settlement observations, not consensus time (SPEC §5.5): two nodes disagree, and a restarted node forgets. Prices and quantities are consensus-derived; the order and the buckets are one node's opinion."

/**
 * Bind one store, one pair, and one asset-naming function.
 *
 * `market.stored({ store, base })` is the same thing with the client's network
 * and its own asset cache already filled in.
 */
export function createStoredHistory(options: StoredHistoryOptions): StoredHistoryApi {
  if (typeof options !== 'object' || options === null) {
    fail('bad-account-source', 'Stored history needs { store, network, base, quote, assets }.')
  }
  const store = options.store
  if (!store || typeof store.trades !== 'function') {
    fail('bad-account-source', 'Stored history needs a MarketStore with trades(); see createMarketStore.')
  }
  if (typeof options.assets !== 'function') {
    fail('bad-asset', 'Stored history needs an assets(id) lookup so a price is labelled with the asset the chain named, not a 64-hex id.')
  }
  const base = assetIdOf(options.base)
  const quote = assetIdOf(options.quote)
  if (base === quote) fail('same-asset', `A stored instrument ${base}/${quote} needs different base and quote assets.`)
  const network = options.network
  const now = options.now ?? Date.now

  const read = async (query: StoredHistoryQuery): Promise<StoredTrades> => {
    const range = resolvedRange(query, now)
    const [baseAsset, quoteAsset] = await Promise.all([named(options.assets, base), named(options.assets, quote)])
    const instrument: StoredInstrumentIdentity = {
      id: `${baseAsset.symbol}/${quoteAsset.symbol}`,
      base: baseAsset,
      quote: quoteAsset,
      priceUnit: 'quote-per-base',
    }
    const page = await store.trades({
      network,
      base,
      quote,
      order: query.order ?? 'oldest',
      ...(range.from === null ? {} : { from: range.from }),
      ...(range.to === null ? {} : { to: range.to }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.deadlineMs === undefined ? {} : { deadlineMs: query.deadlineMs }),
      ...(query.signal === undefined ? {} : { signal: query.signal }),
    })
    const coverage = await store.coverage({
      network,
      ...(query.deadlineMs === undefined ? {} : { deadlineMs: query.deadlineMs }),
      ...(query.signal === undefined ? {} : { signal: query.signal }),
    })
    const points = page.rows.map((row, index) => pointOf(row, index, instrument))
    const times = points.map((point) => point.at)
    return {
      instrument,
      order: query.order ?? 'oldest',
      points,
      requested: { from: range.from, to: range.to },
      observed: {
        from: times.length === 0 ? null : Math.min(...times),
        to: times.length === 0 ? null : Math.max(...times),
      },
      time: { basis: 'node-first-seen', timed: points.length, note: TIME_NOTE },
      coverage,
      pagination: { cursor: page.nextCursor, complete: page.complete, note: PAGE_NOTE },
    }
  }

  return {
    trades(query = {}) {
      return read(query)
    },

    async history(query = {}) {
      const intervalInput = query.interval ?? DEFAULT_STORED_INTERVAL
      // The bucket width is checked before the store is read, so a malformed
      // interval is a refusal about the call rather than about the rows.
      const interval = candleWidthOf(intervalInput)
      const trades = await read(query)
      // Candles need oldest-first regardless of how the page was ordered.
      const ordered = [...trades.points].sort((left, right) => left.at - right.at || compareText(left.hash, right.hash))
      return {
        ...trades,
        interval: { input: intervalInput, milliseconds: interval },
        candles: candlesOf(ordered, interval, trades.instrument),
        summary: summaryOf(ordered, trades.instrument),
      }
    },
  }
}

function pointOf(row: StoredMarketOffer, index: number, instrument: StoredInstrumentIdentity): StoredTradePoint {
  const ask = row.give.asset === instrument.base.asset && row.want.asset === instrument.quote.asset
  if (!ask && !(row.give.asset === instrument.quote.asset && row.want.asset === instrument.base.asset)) {
    fail('wrong-instrument', `Stored trade ${row.hash} is not a ${instrument.id} settlement.`)
  }
  const baseLeg = ask ? row.give : row.want
  const quoteLeg = ask ? row.want : row.give
  const baseRaw = rawAmountOf(baseLeg.raw, `Stored trade ${row.hash} base quantity`)
  const quoteRaw = rawAmountOf(quoteLeg.raw, `Stored trade ${row.hash} quote total`)
  if (baseRaw <= 0n) fail('bad-amount', `Stored trade ${row.hash} moved no base units, so it has no unit price.`)
  const at = row.settledAt
  if (at === null || !Number.isSafeInteger(at)) {
    fail('bad-market-time', `Stored trade ${row.hash} reached the exact history with no advisory settlement time.`)
  }
  return {
    index,
    hash: row.hash,
    seller: row.author,
    buyer: String(row.acceptedBy),
    side: ask ? 'ask' : 'bid',
    baseQuantity: amountOf(baseRaw, instrument.base),
    quoteTotal: amountOf(quoteRaw, instrument.quote),
    // Per unit, from the two exact quantities above — the one place the division
    // happens, so no total can be mistaken for a price downstream.
    unitPrice: unitPriceOf(baseRaw, quoteRaw, instrument),
    at,
    settledBy: row.settledBy,
    provenance: row.provenance,
  }
}

function candlesOf(
  points: readonly StoredTradePoint[],
  every: number,
  instrument: StoredInstrumentIdentity,
): StoredCandle[] {
  // Sparse only. The page limit already bounds this output, and a dense fill is
  // an allocation decided by two advisory timestamps — see series.ts.
  const buckets = new Map<number, {
    at: number
    open: Ratio
    high: Ratio
    low: Ratio
    close: Ratio
    baseVolume: bigint
    quoteTurnover: bigint
    trades: number
  }>()
  for (const point of points) {
    const at = candleStartOf(point.at, every)
    const price = ratioOf(point.unitPrice)
    const bucket = buckets.get(at)
    if (bucket === undefined) {
      buckets.set(at, {
        at,
        open: price,
        high: price,
        low: price,
        close: price,
        baseVolume: BigInt(point.baseQuantity.raw),
        quoteTurnover: BigInt(point.quoteTotal.raw),
        trades: 1,
      })
      continue
    }
    if (compareRatio(price, bucket.high) > 0) bucket.high = price
    if (compareRatio(price, bucket.low) < 0) bucket.low = price
    bucket.close = price
    // Integer addition, so a turnover above Number.MAX_SAFE_INTEGER is still exact.
    bucket.baseVolume += BigInt(point.baseQuantity.raw)
    bucket.quoteTurnover += BigInt(point.quoteTotal.raw)
    bucket.trades += 1
  }
  return [...buckets.values()]
    .sort((left, right) => left.at - right.at)
    .map((bucket) => ({
      at: bucket.at,
      every,
      open: priceOf(bucket.open),
      high: priceOf(bucket.high),
      low: priceOf(bucket.low),
      close: priceOf(bucket.close),
      baseVolume: amountOf(bucket.baseVolume, instrument.base),
      quoteTurnover: amountOf(bucket.quoteTurnover, instrument.quote),
      trades: bucket.trades,
    }))
}

function summaryOf(
  points: readonly StoredTradePoint[],
  instrument: StoredInstrumentIdentity,
): StoredPriceSummary | null {
  if (points.length === 0) return null
  const prices = points.map((point) => ratioOf(point.unitPrice))
  const first = prices[0] as Ratio
  const last = prices[prices.length - 1] as Ratio
  const sorted = [...prices].sort(compareRatio)
  let baseVolume = 0n
  let quoteTurnover = 0n
  for (const point of points) {
    baseVolume += BigInt(point.baseQuantity.raw)
    quoteTurnover += BigInt(point.quoteTotal.raw)
  }
  const change = subtractRatio(last, first)
  return {
    first: priceOf(first),
    last: priceOf(last),
    low: priceOf(sorted[0] as Ratio),
    high: priceOf(sorted[sorted.length - 1] as Ratio),
    median: priceOf(medianRatio(sorted)),
    change: ratioValue(change),
    changeRatio: ratioValue(divideRatio(change, first)),
    baseVolume: amountOf(baseVolume, instrument.base),
    quoteTurnover: amountOf(quoteTurnover, instrument.quote),
    trades: points.length,
  }
}

interface Ratio {
  readonly numerator: bigint
  readonly denominator: bigint
}

function unitPriceOf(baseRaw: bigint, quoteRaw: bigint, instrument: StoredInstrumentIdentity): ExactUnitPrice {
  const baseDecimals = assetDecimalsOf(instrument.base.decimals, `Asset ${instrument.base.asset} decimals`)
  const quoteDecimals = assetDecimalsOf(instrument.quote.decimals, `Asset ${instrument.quote.asset} decimals`)
  // Scaling both legs to display units keeps one orientation — quote per base —
  // for asks and bids alike, whatever decimals the two assets were issued with.
  return priceOf({
    numerator: quoteRaw * 10n ** BigInt(baseDecimals),
    denominator: baseRaw * 10n ** BigInt(quoteDecimals),
  })
}

function priceOf(ratio: Ratio): ExactUnitPrice {
  return { ...ratioValue(ratio), priceUnit: 'quote-per-base' }
}

function ratioValue(ratio: Ratio): ExactRatio {
  const reduced = reduce(ratio)
  return {
    numerator: reduced.numerator.toString(),
    denominator: reduced.denominator.toString(),
    display: displayOf(reduced),
  }
}

function ratioOf(price: ExactRatio): Ratio {
  return { numerator: BigInt(price.numerator), denominator: BigInt(price.denominator) }
}

function reduce(ratio: Ratio): Ratio {
  if (ratio.denominator === 0n) fail('bad-amount', 'An exact price cannot have a zero denominator.')
  const sign = ratio.denominator < 0n ? -1n : 1n
  const numerator = ratio.numerator * sign
  const denominator = ratio.denominator * sign
  const divisor = gcd(numerator < 0n ? -numerator : numerator, denominator)
  return divisor === 0n
    ? { numerator: 0n, denominator: 1n }
    : { numerator: numerator / divisor, denominator: denominator / divisor }
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left
  let b = right
  while (b !== 0n) {
    const next = a % b
    a = b
    b = next
  }
  return a
}

function compareRatio(left: Ratio, right: Ratio): number {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator
  return difference === 0n ? 0 : difference < 0n ? -1 : 1
}

function subtractRatio(left: Ratio, right: Ratio): Ratio {
  return {
    numerator: left.numerator * right.denominator - right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  }
}

function divideRatio(left: Ratio, right: Ratio): Ratio {
  if (right.numerator === 0n) fail('bad-amount', 'An exact change ratio cannot divide by a zero opening price.')
  return { numerator: left.numerator * right.denominator, denominator: left.denominator * right.numerator }
}

/** Exact median: the middle price, or the reduced rational average of the two middles. */
function medianRatio(sorted: readonly Ratio[]): Ratio {
  const middle = sorted.length >> 1
  if (sorted.length % 2 === 1) return sorted[middle] as Ratio
  const low = sorted[middle - 1] as Ratio
  const high = sorted[middle] as Ratio
  return {
    numerator: low.numerator * high.denominator + high.numerator * low.denominator,
    denominator: 2n * low.denominator * high.denominator,
  }
}

/**
 * The one deliberate precision loss in this file.
 *
 * Integer division at a fixed scale first, so a price of `1e-18` does not
 * become zero and a turnover of `1e56` does not become `Infinity`; the `Number`
 * conversion at the end is what keeps ~15 significant digits and nothing more.
 */
function displayOf(ratio: Ratio): number {
  const scaled = (ratio.numerator * DISPLAY_SCALE) / ratio.denominator
  const value = Number(scaled) / Number(DISPLAY_SCALE)
  if (!Number.isFinite(value)) {
    fail('bad-amount', `Exact price ${ratio.numerator}/${ratio.denominator} has no finite display value.`)
  }
  return value
}

function amountOf(raw: bigint, asset: StoredAssetIdentity): ExactAmount {
  const decimals = assetDecimalsOf(asset.decimals, `Asset ${asset.asset} decimals`)
  return { asset, raw: raw.toString(), display: fromRaw(raw, decimals) }
}

async function named(lookup: StoredAssetLookup, asset: AssetId): Promise<StoredAssetIdentity> {
  const found = await lookup(asset)
  if (typeof found !== 'object' || found === null) {
    fail('bad-asset-metadata', `The stored-history asset lookup returned no metadata for ${asset}.`)
  }
  const symbol = String(found.symbol ?? '')
  const name = String(found.name ?? '')
  if (symbol === '' || name === '') {
    fail('bad-asset-metadata', `Asset ${asset} has no symbol or name to label a price with. A 64-hex id is not a label (#130).`)
  }
  return {
    asset,
    symbol,
    name,
    decimals: assetDecimalsOf(found.decimals, `Asset ${asset} decimals`),
  }
}

function resolvedRange(query: StoredHistoryQuery, now: () => number): { from: number | null; to: number | null } {
  if (query.from !== undefined && query.window !== undefined) {
    fail('bad-duration', 'Stored history takes from, or window measured back from to. Not both.')
  }
  const to = query.to === undefined ? undefined : parseMarketTime(query.to, 'stored history to')
  const from = query.from === undefined ? undefined : parseMarketTime(query.from, 'stored history from')
  if (query.window === undefined) {
    if (from !== undefined && to !== undefined && from > to) {
      fail('bad-market-time', 'Stored history from cannot be after to.')
    }
    return { from: from ?? null, to: to ?? null }
  }
  const anchor = to ?? clockTime(now)
  const width = durationMs(query.window, 'stored history window')
  const start = anchor - width
  if (!Number.isSafeInteger(start)) {
    fail('bad-duration', 'The requested stored-history window reaches outside safe whole-number millisecond time.')
  }
  return { from: Math.max(0, start), to: anchor }
}

function clockTime(now: () => number): number {
  let at: unknown
  try {
    at = now()
  } catch (error) {
    fail('bad-market-time', `The stored-history clock threw instead of returning a time: ${error instanceof Error ? error.message : String(error)}.`)
  }
  if (!Number.isSafeInteger(at) || (at as number) < 0) {
    fail('bad-market-time', `The stored-history clock must return a non-negative safe whole-number millisecond time; got ${String(at)}.`)
  }
  return at as number
}

function candleWidthOf(value: Duration): number {
  const every = durationMs(value, 'stored history interval')
  if (!Number.isSafeInteger(every) || every < 1) {
    fail(
      'bad-duration',
      `A stored-history interval is a bucket width, so it has to be a whole number of milliseconds of at least 1; got ${String(value)}.`,
    )
  }
  return every
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
