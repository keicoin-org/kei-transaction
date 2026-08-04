/**
 * A market product surface bound to one base/quote pair and one explicit source.
 *
 * The legacy account-chain reader is intentionally the first source adapter,
 * not a claim that one wallet or one node is a global history service. Its
 * coverage, node-local time, durability, and lack of pagination travel with
 * every snapshot as ordinary JSON.
 */

import type { AssetId } from '@keicoin/core'
import { fail } from '@keicoin/core'

import type { Book, BookLevel, BookOptions } from './book.js'
import { isDirectory, type AccountDirectory, type AccountSource } from './directory.js'
import { expectationFrom } from './lifecycle.js'
import { MAX_CANDLES, toCandles, toSeries, type Candle, type PricePoint } from './series.js'
import type {
  AcceptOptions,
  Duration,
  ExpiryOptions,
  Offer,
  OfferOptions,
  Settlement,
  Trade,
  TradeOptions,
} from './types.js'
import { assetIdOf, durationMs } from './util.js'
import { accountLimitOf, type Coverage, type Covered, type ReadOptions } from './walk.js'

const DEFAULT_HISTORY_INTERVAL: Duration = '1h'
const DEFAULT_POLL_INTERVAL: Duration = '2s'
const MAX_TIMER_DELAY = 2_147_483_647

/** A named account-chain source. Durable/indexed providers can join this union later. */
export interface MarketDataSource {
  readonly kind: 'account-chain'
  /** Stable application identity, e.g. `eu-testnet-catalog`. */
  readonly id: string
  readonly accounts: AccountSource
}

export interface AccountChainSourceOptions {
  id: string
  accounts: AccountSource
}

/** Name an account source so provenance survives logs, JSON, and provider swaps. */
export function createAccountChainSource(options: AccountChainSourceOptions): MarketDataSource {
  const id = String(options?.id ?? '').trim()
  if (id === '') {
    fail('bad-account-source', 'An account-chain market source needs a stable non-empty id and an explicit accounts source.')
  }
  if (options?.accounts === undefined || options.accounts === null) {
    fail('no-accounts', `Market data source ${id} needs the accounts whose chains it will read.`)
  }
  return Object.freeze({ kind: 'account-chain' as const, id, accounts: options.accounts })
}

export interface InstrumentIdentity {
  /** Stable pair key, always `BASE/QUOTE`. */
  id: string
  /** Stable venue key when the source was named; null for an anonymous direct source. */
  key: string | null
  base: AssetId
  quote: AssetId
  priceUnit: 'quote-per-base'
}

export interface InstrumentOptions {
  base: AssetId | { id: AssetId }
  quote: AssetId | { id: AssetId }
  /** Required market scope. A wallet-only implicit default would not be a market. */
  source: AccountSource | MarketDataSource
  /** Identity for a direct AccountSource. Prefer `createAccountChainSource` for reusable providers. */
  sourceId?: string
}

export type DataState = 'empty' | 'available'
export type DataCompleteness = 'complete' | 'partial'

export interface SourceProvenance {
  id: string
  /** False means `id` deliberately labels an anonymous direct source. */
  identified: boolean
  kind: 'account-chain'
  network: string
  scope: 'explicit-account-chains'
  durability: 'node-local'
  authority: 'untrusted-discovery'
  accountsAsked: number
  accountsRead: number
}

export interface PaginationLimitation {
  supported: false
  cursor: null
  reason: string
}

export interface ExactPriceRatio {
  /** Exact ledger quantities for the displayed pair orientation. */
  baseRaw: string
  quoteRaw: string
  baseDecimals: number
  quoteDecimals: number
  /** Exact quote-per-base display ratio is numerator / denominator. */
  numerator: string
  denominator: string
}

export interface InstrumentPricePoint extends PricePoint {
  side: 'ask' | 'bid'
  exact: ExactPriceRatio
}

export interface InstrumentBookLevel extends BookLevel {
  exact: ExactPriceRatio
}

export interface InstrumentBook {
  instrument: InstrumentIdentity
  state: DataState
  completeness: DataCompleteness
  asks: InstrumentBookLevel[]
  bids: InstrumentBookLevel[]
  bestAsk: InstrumentBookLevel | null
  bestBid: InstrumentBookLevel | null
  spread: number | null
  coverage: Coverage
}

export interface RequestedRange {
  window: Duration | null
  from: number | null
  to: number
}

export interface ObservedRange {
  from: number | null
  to: number | null
}

export interface TimeQuality {
  basis: 'node-first-seen'
  timed: number
  estimated: number
  untimed: number
  note: string
}

export interface InstrumentHistory {
  instrument: InstrumentIdentity
  state: DataState
  completeness: DataCompleteness
  /** Whether every retained trade can participate in a time chart. */
  temporalCompleteness: DataCompleteness
  interval: { input: Duration; milliseconds: number }
  requested: RequestedRange
  observed: ObservedRange
  /** Oldest first. Untimed rows stay present with `at: null`. */
  points: InstrumentPricePoint[]
  candles: Candle[]
  summary: {
    first: number | null
    last: number | null
    change: number | null
    changeRatio: number | null
    median: number | null
    low: number | null
    high: number | null
    volume: number
    trades: number
  }
  ordering: ReturnType<typeof toSeries>['ordering']
  time: TimeQuality
  coverage: Coverage
  provenance: SourceProvenance
  pagination: PaginationLimitation
}

export interface InstrumentTicker {
  state: DataState
  completeness: DataCompleteness
  last: number | null
  open: number | null
  high: number | null
  low: number | null
  change: number | null
  changeRatio: number | null
  volume: number
  trades: number
  bestAsk: number | null
  bestBid: number | null
  spread: number | null
}

export interface SnapshotCoverage {
  book: Coverage
  history: Coverage
  complete: boolean
}

export interface InstrumentSnapshot {
  instrument: InstrumentIdentity
  asOf: number
  state: DataState
  completeness: DataCompleteness
  ticker: InstrumentTicker
  book: InstrumentBook
  history: InstrumentHistory
  coverage: SnapshotCoverage
  provenance: SourceProvenance
  pagination: PaginationLimitation
}

export interface HistoryRangeOptions {
  /** Node-local observation window, such as `30d`. */
  window?: Duration
}

export interface InstrumentHistoryOptions extends ReadOptions {
  interval?: Duration
  range?: HistoryRangeOptions
  last?: number
  limit?: number
  fill?: boolean
  maxCandles?: number
}

export interface InstrumentSnapshotOptions extends ReadOptions {
  /** Rows retained on each side after exact ranking. Default 20. */
  depth?: number
  /** Open rows read per account before ranking. Default 100; distinct from output depth. */
  bookLimit?: number
  history?: InstrumentHistoryOptions
}

export interface InstrumentOrderOptions extends ExpiryOptions {
  units: number | string
  unitPrice: number | string
  to?: string
}

export interface UnixLinePoint {
  time: number
  value: number
}

export interface UnixCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  trades: number
}

/** Common library-neutral epoch-second line rows. Untimed points cannot be drawn. */
export function toUnixLine(history: Pick<InstrumentHistory, 'points'>): UnixLinePoint[] {
  return history.points
    .filter((point): point is InstrumentPricePoint & { at: number } => point.at !== null)
    .map((point) => ({ time: Math.floor(point.at / 1_000), value: point.price }))
}

/** Common library-neutral epoch-second OHLCV rows. History metadata stays on the DTO. */
export function toUnixCandles(history: Pick<InstrumentHistory, 'candles'>): UnixCandle[] {
  return history.candles.map((candle) => ({
    time: Math.floor(candle.at / 1_000),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    trades: candle.trades,
  }))
}

export type SubscriptionStatus = 'opening' | 'live' | 'stale' | 'error'

export interface MarketReadError {
  name: string
  message: string
  code: string | null
}

export interface InstrumentUpdate {
  status: SubscriptionStatus
  at: number
  age: number | null
  stale: boolean
  snapshot: InstrumentSnapshot | null
  /** Alias that makes the retention contract explicit at the call site. */
  lastGood: InstrumentSnapshot | null
  error: MarketReadError | null
}

export interface InstrumentSubscribeOptions {
  every?: Duration
  /** Age at which a failed refresh changes from `error` to `stale`. Default 2x `every`. */
  staleAfter?: Duration
  signal?: AbortSignal
  snapshot?: Omit<InstrumentSnapshotOptions, 'signal'>
}

export type StopSubscription = () => void

export interface InstrumentApi {
  readonly instrument: InstrumentIdentity
  readonly source: { id: string; identified: boolean; kind: 'account-chain' }
  snapshot(options?: InstrumentSnapshotOptions): Promise<InstrumentSnapshot>
  history(options?: InstrumentHistoryOptions): Promise<InstrumentHistory>
  subscribe(options: InstrumentSubscribeOptions, listener: (update: InstrumentUpdate) => void): StopSubscription
  sell(options: InstrumentOrderOptions): Promise<Offer>
  bid(options: InstrumentOrderOptions): Promise<Offer>
  /** Revalidates every displayed term, including raw quantities, before signing. */
  accept(level: InstrumentBookLevel): Promise<Settlement>
  /** Stops this instrument's subscriptions. It does not close the parent market. */
  close(): void
}

export interface InstrumentFactoryContext {
  network: string
  now(): number
  readBook(options: BookOptions): Promise<Book>
  readTrades(options: TradeOptions): Promise<Covered<Trade>>
  offer(options: OfferOptions): Promise<Offer>
  accept(offer: string | Offer, options?: AcceptOptions): Promise<Settlement>
}

export interface InstrumentFactory {
  instrument(options: InstrumentOptions): InstrumentApi
  close(): void
}

export function createInstrumentFactory(context: InstrumentFactoryContext): InstrumentFactory {
  const instruments = new Set<InstrumentApi>()

  return {
    instrument(options) {
      const api = createInstrument(context, options, () => instruments.delete(api))
      instruments.add(api)
      return api
    },
    close() {
      for (const instrument of [...instruments]) instrument.close()
      instruments.clear()
    },
  }
}

function createInstrument(
  context: InstrumentFactoryContext,
  options: InstrumentOptions,
  onClose: () => void,
): InstrumentApi {
  if (!options || options.source === undefined || options.source === null) {
    fail('no-accounts', 'market.instrument() requires an explicit source. Bind a directory, account list, or named account-chain source.')
  }
  const base = assetIdOf(options.base)
  const quote = assetIdOf(options.quote)
  if (base === quote) fail('same-asset', `Instrument ${base}/${quote} needs different base and quote assets.`)

  const bound = bindSource(options.source, options.sourceId)
  const identity: InstrumentIdentity = Object.freeze({
    id: `${base}/${quote}`,
    key: bound.identified ? `${context.network}:${bound.id}:${base}/${quote}` : null,
    base,
    quote,
    priceUnit: 'quote-per-base',
  })
  const stops = new Set<StopSubscription>()
  const refreshers = new Set<() => void>()
  let closed = false

  const history = async (historyOptions: InstrumentHistoryOptions = {}): Promise<InstrumentHistory> => {
    const asOf = marketTime(context.now)
    const intervalInput = historyOptions.interval ?? DEFAULT_HISTORY_INTERVAL
    const interval = durationMs(intervalInput, 'history interval')
    const last = historyLastOf(historyOptions.last)
    const limit = historyOptions.limit === undefined
      ? undefined
      : accountLimitOf(historyOptions.limit, 'instrument history limit')
    validateCandleBudget(historyOptions.maxCandles)
    const window = historyOptions.range?.window
    const requested: RequestedRange = {
      window: window ?? null,
      from: window === undefined ? null : safeSubtract(asOf, durationMs(window, 'history range window')),
      to: asOf,
    }
    const trades = await context.readTrades({
      from: bound.accounts,
      asset: base,
      quote,
      ...(window === undefined ? {} : { window }),
      ...(last === undefined ? {} : { last }),
      ...(limit === undefined ? {} : { limit }),
      signal: historyOptions.signal,
      concurrency: historyOptions.concurrency,
    })
    return historyFromTrades(context, identity, bound, asOf, trades, {
      intervalInput,
      interval,
      requested,
      last,
      fill: historyOptions.fill,
      maxCandles: historyOptions.maxCandles,
    })
  }

  const snapshot = async (snapshotOptions: InstrumentSnapshotOptions = {}): Promise<InstrumentSnapshot> => {
    const asOf = marketTime(context.now)
    const depth = depthOf(snapshotOptions.depth)
    const historyOptions = snapshotOptions.history ?? {}
    const intervalInput = historyOptions.interval ?? DEFAULT_HISTORY_INTERVAL
    const interval = durationMs(intervalInput, 'history interval')
    const last = historyLastOf(historyOptions.last)
    const historyLimit = historyOptions.limit === undefined
      ? undefined
      : accountLimitOf(historyOptions.limit, 'instrument history limit')
    const bookLimit = snapshotOptions.bookLimit === undefined
      ? undefined
      : accountLimitOf(snapshotOptions.bookLimit, 'instrument book limit')
    validateCandleBudget(historyOptions.maxCandles)
    const window = historyOptions.range?.window
    const requested: RequestedRange = {
      window: window ?? null,
      from: window === undefined ? null : safeSubtract(asOf, durationMs(window, 'history range window')),
      to: asOf,
    }
    const signal = snapshotOptions.signal ?? historyOptions.signal
    const concurrency = snapshotOptions.concurrency ?? historyOptions.concurrency
    const readSource = coherentSource(bound.accounts)

    // Open listings and accepted trades are distinct node pages, but line,
    // candles, ticker, and summary all reuse this one accepted-trade page.
    const [rawBook, trades] = await Promise.all([
      context.readBook({
        from: readSource,
        asset: base,
        quote,
        ...(bookLimit === undefined ? {} : { limit: bookLimit }),
        signal,
        concurrency,
      }),
      context.readTrades({
        from: readSource,
        asset: base,
        quote,
        ...(window === undefined ? {} : { window }),
        ...(last === undefined ? {} : { last }),
        ...(historyLimit === undefined ? {} : { limit: historyLimit }),
        signal,
        concurrency,
      }),
    ])

    const book = bookFrom(rawBook, identity, depth)
    const historical = historyFromTrades(context, identity, bound, asOf, trades, {
      intervalInput,
      interval,
      requested,
      last,
      fill: historyOptions.fill,
      maxCandles: historyOptions.maxCandles,
    })
    const coverage = {
      book: book.coverage,
      history: historical.coverage,
      complete: book.coverage.complete && historical.coverage.complete,
    }
    const provenance = provenanceOf(context, bound.id, bound.identified, mergeCounts(book.coverage, historical.coverage))
    const state: DataState = book.state === 'available' || historical.state === 'available' ? 'available' : 'empty'
    const completeness: DataCompleteness = book.completeness === 'complete' && historical.completeness === 'complete'
      ? 'complete'
      : 'partial'
    const ticker = tickerFrom(book, historical, completeness)

    return {
      instrument: identity,
      asOf,
      state,
      completeness,
      ticker,
      book,
      history: historical,
      coverage,
      provenance,
      pagination: paginationLimitation(),
    }
  }

  const wake = (): void => {
    for (const refresh of refreshers) refresh()
  }

  const api: InstrumentApi = {
    instrument: identity,
    source: Object.freeze({ id: bound.id, identified: bound.identified, kind: 'account-chain' as const }),
    snapshot,
    history,
    subscribe(subscribeOptions, listener) {
      if (typeof listener !== 'function') fail('bad-subscription', 'instrument.subscribe() needs an update listener.')
      const every = pollDuration(subscribeOptions?.every ?? DEFAULT_POLL_INTERVAL, 'subscription every')
      const defaultStale = every > Math.floor(Number.MAX_SAFE_INTEGER / 2) ? Number.MAX_SAFE_INTEGER : every * 2
      const staleAfter = durationMs(subscribeOptions?.staleAfter ?? defaultStale, 'subscription staleAfter')
      const external = subscribeOptions?.signal
      if (closed || external?.aborted) return () => undefined

      const controller = new AbortController()
      let stopped = false
      let running = false
      let pending = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let lastGood: InstrumentSnapshot | null = null

      const emit = (update: InstrumentUpdate): void => {
        if (stopped) return
        try {
          listener(update)
        } catch {
          // A view throwing while rendering must not create overlapping reads
          // or permanently kill the refresh loop.
        }
      }
      const schedule = (delay: number): void => {
        if (stopped) return
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = undefined
          void run()
        }, delay)
        ;(timer as unknown as { unref?: () => void }).unref?.()
      }
      const run = async (): Promise<void> => {
        if (stopped) return
        if (running) {
          pending = true
          return
        }
        running = true
        try {
          const current = await snapshot({ ...(subscribeOptions.snapshot ?? {}), signal: controller.signal })
          if (stopped) return
          lastGood = current
          emit({
            status: 'live',
            at: marketTime(context.now),
            age: 0,
            stale: false,
            snapshot: current,
            lastGood: current,
            error: null,
          })
        } catch (error) {
          if (stopped || controller.signal.aborted) return
          const at = marketTime(context.now)
          const age = lastGood === null ? null : Math.max(0, at - lastGood.asOf)
          const stale = age !== null && age >= staleAfter
          emit({
            status: stale ? 'stale' : 'error',
            at,
            age,
            stale,
            snapshot: lastGood,
            lastGood,
            error: readError(error),
          })
        } finally {
          running = false
          if (!stopped) {
            if (pending) {
              pending = false
              schedule(0)
            } else schedule(every)
          }
        }
      }
      const refresh = (): void => {
        if (stopped) return
        if (running) pending = true
        else schedule(0)
      }
      const stop = (): void => {
        if (stopped) return
        stopped = true
        controller.abort()
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        refreshers.delete(refresh)
        stops.delete(stop)
        external?.removeEventListener?.('abort', stop)
      }

      stops.add(stop)
      refreshers.add(refresh)
      external?.addEventListener('abort', stop, { once: true })
      const at = marketTime(context.now)
      emit({ status: 'opening', at, age: null, stale: false, snapshot: null, lastGood: null, error: null })
      schedule(0)
      return stop
    },
    async sell(order) {
      const offer = await context.offer({
        give: { asset: base, amount: order.units },
        want: { asset: quote, amount: decimalProduct(order.units, order.unitPrice) },
        to: order.to,
        expiresAt: order.expiresAt,
        expiresIn: order.expiresIn,
      })
      wake()
      return offer
    },
    async bid(order) {
      const offer = await context.offer({
        give: { asset: quote, amount: decimalProduct(order.units, order.unitPrice) },
        want: { asset: base, amount: order.units },
        to: order.to,
        expiresAt: order.expiresAt,
        expiresIn: order.expiresIn,
      })
      wake()
      return offer
    },
    async accept(level) {
      assertInstrumentLevel(identity, level)
      const settlement = await context.accept(level, { expect: expectationFrom(level) })
      wake()
      return settlement
    },
    close() {
      if (closed) return
      closed = true
      for (const stop of [...stops]) stop()
      onClose()
    },
  }

  return api
}

interface BoundSource {
  id: string
  identified: boolean
  accounts: AccountSource
}

function bindSource(source: AccountSource | MarketDataSource, directId?: string): BoundSource {
  if (isMarketDataSource(source)) return { id: source.id, identified: true, accounts: source.accounts }
  const named = directId === undefined ? inferredSourceId(source) : String(directId).trim()
  if (named === '') fail('bad-account-source', 'An instrument source id cannot be empty.')
  return { id: named, identified: directId !== undefined, accounts: source }
}

function isMarketDataSource(source: AccountSource | MarketDataSource): source is MarketDataSource {
  return typeof source === 'object' && source !== null && (source as MarketDataSource).kind === 'account-chain'
    && typeof (source as MarketDataSource).id === 'string' && 'accounts' in source
}

function inferredSourceId(source: AccountSource): string {
  void source
  return 'anonymous:account-chain'
}

/** Resolve a custom directory once so one snapshot cannot span two rosters. */
function coherentSource(source: AccountSource): AccountSource {
  if (!isDirectory(source)) return source
  const size = source.size
  const dropped = source.dropped
  let accounts: Promise<readonly string[]> | undefined
  const fixed: AccountDirectory = {
    ...(size === undefined ? {} : { size }),
    ...(dropped === undefined ? {} : { dropped }),
    accounts() {
      accounts ??= Promise.resolve().then(() => source.accounts())
      return accounts
    },
  }
  return fixed
}

interface HistoryBuildOptions {
  intervalInput: Duration
  interval: number
  requested: RequestedRange
  last?: number
  fill?: boolean
  maxCandles?: number
}

function historyFromTrades(
  context: InstrumentFactoryContext,
  instrument: InstrumentIdentity,
  source: Pick<BoundSource, 'id' | 'identified'>,
  _asOf: number,
  trades: Covered<Trade>,
  options: HistoryBuildOptions,
): InstrumentHistory {
  const series = toSeries(trades, { asset: instrument.base, quote: instrument.quote, last: options.last })
  const byHash = new Map(trades.map((trade) => [trade.hash, trade]))
  const points = series.points.map((point): InstrumentPricePoint => {
    const trade = byHash.get(point.hash)
    if (!trade) fail('bad-offer', `Trade ${point.hash} disappeared while one instrument history was being assembled.`)
    const exact = exactPrice(trade, instrument)
    return { ...point, side: trade.give.asset === instrument.base ? 'ask' : 'bid', exact }
  })
  const candles = toCandles(trades, {
    asset: instrument.base,
    quote: instrument.quote,
    every: options.interval,
    last: options.last,
    fill: options.fill,
    maxCandles: options.maxCandles,
  })
  const observedTimes = points.flatMap((point) => point.at === null ? [] : [point.at])
  const timed = points.filter((point) => !point.estimated && point.at !== null).length
  const untimed = points.filter((point) => point.at === null).length
  const estimated = points.length - timed - untimed
  const coverage = trades.coverage
  const temporalCompleteness: DataCompleteness = untimed === 0 ? 'complete' : 'partial'
  const completeness: DataCompleteness = coverage.complete && temporalCompleteness === 'complete' ? 'complete' : 'partial'
  const summary = series.summary

  return {
    instrument,
    state: points.length === 0 ? 'empty' : 'available',
    completeness,
    temporalCompleteness,
    interval: { input: options.intervalInput, milliseconds: options.interval },
    requested: options.requested,
    observed: {
      from: observedTimes.length === 0 ? null : Math.min(...observedTimes),
      to: observedTimes.length === 0 ? null : Math.max(...observedTimes),
    },
    points,
    candles: [...candles],
    summary: {
      first: series.first,
      last: series.last,
      change: series.change,
      changeRatio: series.changeRatio,
      median: summary?.median ?? null,
      low: summary?.low ?? null,
      high: summary?.high ?? null,
      volume: summary?.volume ?? 0,
      trades: summary?.trades ?? 0,
    },
    ordering: series.ordering,
    time: {
      basis: 'node-first-seen',
      timed,
      estimated,
      untimed,
      note: 'Times are this node\'s first-seen observations, not consensus time. A fresh node may not reproduce them.',
    },
    coverage,
    provenance: provenanceOf(context, source.id, source.identified, coverage),
    pagination: paginationLimitation(),
  }
}

function bookFrom(book: Book, instrument: InstrumentIdentity, depth: number): InstrumentBook {
  const asks = book.asks.slice(0, depth).map((level) => ({ ...level, exact: exactPrice(level, instrument) }))
  const bids = book.bids.slice(0, depth).map((level) => ({ ...level, exact: exactPrice(level, instrument) }))
  const bestAsk = asks[0] ?? null
  const bestBid = bids[0] ?? null
  return {
    instrument,
    state: asks.length === 0 && bids.length === 0 ? 'empty' : 'available',
    completeness: book.coverage.complete ? 'complete' : 'partial',
    asks,
    bids,
    bestAsk,
    bestBid,
    spread: bestAsk && bestBid ? bestAsk.unitPrice - bestBid.unitPrice : null,
    coverage: book.coverage,
  }
}

function tickerFrom(
  book: InstrumentBook,
  history: InstrumentHistory,
  completeness: DataCompleteness,
): InstrumentTicker {
  return {
    state: book.state === 'available' || history.state === 'available' ? 'available' : 'empty',
    completeness,
    last: history.summary.last,
    open: history.summary.first,
    high: history.summary.high,
    low: history.summary.low,
    change: history.summary.change,
    changeRatio: history.summary.changeRatio,
    volume: history.summary.volume,
    trades: history.summary.trades,
    bestAsk: book.bestAsk?.unitPrice ?? null,
    bestBid: book.bestBid?.unitPrice ?? null,
    spread: book.spread,
  }
}

function exactPrice(offer: Offer, instrument: InstrumentIdentity): ExactPriceRatio {
  const ask = offer.give.asset === instrument.base && offer.want.asset === instrument.quote
  const bid = offer.want.asset === instrument.base && offer.give.asset === instrument.quote
  if (!ask && !bid) {
    fail('wrong-instrument', `Offer ${offer.hash} is not a ${instrument.id} level.`)
  }
  const baseLeg = ask ? offer.give : offer.want
  const quoteLeg = ask ? offer.want : offer.give
  const baseRaw = rawQuantity(baseLeg.raw, offer.hash, 'base')
  const quoteRaw = rawQuantity(quoteLeg.raw, offer.hash, 'quote')
  return {
    baseRaw,
    quoteRaw,
    baseDecimals: baseLeg.decimals,
    quoteDecimals: quoteLeg.decimals,
    numerator: (BigInt(quoteRaw) * 10n ** BigInt(baseLeg.decimals)).toString(),
    denominator: (BigInt(baseRaw) * 10n ** BigInt(quoteLeg.decimals)).toString(),
  }
}

function rawQuantity(raw: string | undefined, hash: string, leg: string): string {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
    fail('bad-offer', `Offer ${hash} has no valid exact raw ${leg} quantity, so it cannot enter an instrument snapshot or be accepted safely.`)
  }
  return raw
}

function assertInstrumentLevel(instrument: InstrumentIdentity, level: InstrumentBookLevel): void {
  if (!level || level.base !== instrument.base || level.quote !== instrument.quote) {
    fail('wrong-instrument', `This ${instrument.id} instrument can only accept a level whose base is ${instrument.base} and quote is ${instrument.quote}.`)
  }
  // This also refuses hand-authored levels that lack the raw terms required for
  // a precision-safe expectation. The chain is re-read by context.accept next.
  const exact = exactPrice(level, instrument)
  const shown = level.exact
  if (!shown || shown.baseRaw !== exact.baseRaw || shown.quoteRaw !== exact.quoteRaw
    || shown.numerator !== exact.numerator || shown.denominator !== exact.denominator) {
    fail('offer-changed', `Offer ${level.hash} has display ratio metadata that disagrees with its displayed raw terms. Refresh the instrument before accepting it.`)
  }
  const expectedUnitPrice = level.side === 'ask'
    ? level.want.amount / level.give.amount
    : level.give.amount / level.want.amount
  if (level.unitPrice !== expectedUnitPrice) {
    fail('offer-changed', `Offer ${level.hash} was displayed at ${String(level.unitPrice)} ${instrument.quote} per ${instrument.base}, but its displayed quantities say ${String(expectedUnitPrice)}. Refresh before accepting it.`)
  }
}

function provenanceOf(
  context: InstrumentFactoryContext,
  sourceId: string,
  identified: boolean,
  coverage: Pick<Coverage, 'asked' | 'read'>,
): SourceProvenance {
  return {
    id: sourceId,
    identified,
    kind: 'account-chain',
    network: context.network,
    scope: 'explicit-account-chains',
    durability: 'node-local',
    authority: 'untrusted-discovery',
    accountsAsked: coverage.asked,
    accountsRead: coverage.read,
  }
}

function paginationLimitation(): PaginationLimitation {
  return {
    supported: false,
    cursor: null,
    reason: 'The account-chain adapter has bounded per-account pages but the current node RPC returns no cursor or exhaustion proof.',
  }
}

function mergeCounts(a: Coverage, b: Coverage): Pick<Coverage, 'asked' | 'read'> {
  return { asked: Math.max(a.asked, b.asked), read: Math.min(a.read, b.read) }
}

function depthOf(requested: number | undefined): number {
  const depth = requested ?? 20
  if (!Number.isSafeInteger(depth) || depth < 1) {
    fail('bad-limit', `Instrument depth must be a positive safe whole number; got ${String(requested)}.`)
  }
  return depth
}

function historyLastOf(requested: number | undefined): number | undefined {
  if (requested === undefined) return undefined
  if (!Number.isSafeInteger(requested) || requested < 0) {
    fail('bad-limit', `Instrument history last must be a non-negative safe whole number; got ${String(requested)}.`)
  }
  return requested
}

function validateCandleBudget(requested: number | undefined): void {
  if (requested === undefined) return
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > MAX_CANDLES) {
    fail('bad-max-candles', `Instrument history maxCandles must be a positive safe whole number from 1 through ${MAX_CANDLES}; got ${String(requested)}.`)
  }
}

function marketTime(now: () => number): number {
  const at = now()
  if (!Number.isSafeInteger(at)) {
    fail('bad-market-time', `The market clock must return a safe whole-number millisecond time; got ${String(at)}.`)
  }
  return at
}

function safeSubtract(at: number, duration: number): number {
  const answer = at - duration
  if (!Number.isSafeInteger(answer)) {
    fail('bad-duration', `The requested history window reaches outside safe whole-number millisecond time.`)
  }
  return answer
}

function pollDuration(value: Duration, label: string): number {
  const milliseconds = durationMs(value, label)
  if (milliseconds > MAX_TIMER_DELAY) {
    fail('bad-subscription', `${label} must fit one JavaScript timer (1..${MAX_TIMER_DELAY}ms); got ${milliseconds}ms.`)
  }
  return milliseconds
}

function readError(error: unknown): MarketReadError {
  const candidate = error as { name?: unknown; message?: unknown; code?: unknown }
  return {
    name: typeof candidate?.name === 'string' ? candidate.name : 'Error',
    message: typeof candidate?.message === 'string' ? candidate.message : String(error),
    code: typeof candidate?.code === 'string' ? candidate.code : null,
  }
}

interface DecimalParts {
  digits: bigint
  scale: number
}

/** Exact decimal multiplication: unit price becomes a total once, without a float round-trip. */
function decimalProduct(units: number | string, unitPrice: number | string): string {
  const left = decimalParts(units, 'units')
  const right = decimalParts(unitPrice, 'unitPrice')
  const digits = left.digits * right.digits
  if (digits <= 0n) fail('bad-amount', 'Instrument units and unitPrice must both be positive.')
  const scale = left.scale + right.scale
  const padded = digits.toString().padStart(scale + 1, '0')
  if (scale === 0) return padded
  const whole = padded.slice(0, -scale)
  const fraction = padded.slice(-scale).replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

function decimalParts(value: number | string, label: string): DecimalParts {
  const text = typeof value === 'number' ? expandNumber(value, label) : String(value).trim()
  const match = /^\+?(\d*)(?:\.(\d*))?$/.exec(text)
  if (!match || (match[1] === '' && (match[2] ?? '') === '')) {
    fail('bad-amount', `${label} must be a positive decimal number like 1.5; got "${text}".`)
  }
  const whole = match[1] === '' ? '0' : match[1] as string
  const fraction = match[2] ?? ''
  const digits = BigInt((whole + fraction) || '0')
  if (digits <= 0n) fail('bad-amount', `${label} must be greater than zero; got ${text}.`)
  return { digits, scale: fraction.length }
}

function expandNumber(value: number, label: string): string {
  if (!Number.isFinite(value) || value <= 0) fail('bad-amount', `${label} must be a positive finite number; got ${String(value)}.`)
  const text = String(value)
  if (!/[eE]/.test(text)) return text
  const [mantissa = '0', exponentText = '0'] = text.toLowerCase().split('e')
  const exponent = Number(exponentText)
  const [whole = '0', fraction = ''] = mantissa.split('.')
  const flat = whole + fraction
  const point = whole.length + exponent
  if (point <= 0) return `0.${'0'.repeat(-point)}${flat}`
  if (point >= flat.length) return `${flat}${'0'.repeat(point - flat.length)}`
  return `${flat.slice(0, point)}.${flat.slice(point)}`
}
