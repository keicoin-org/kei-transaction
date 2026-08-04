import { afterEach, describe, expect, test } from 'bun:test'

import type { AssetId, AssetInfo, SwapOffer, SwapState } from '@keicoin/core'
import { KEI_ASSET, KeiError } from '@keicoin/core'
import {
  createAccountChainSource,
  emptyCoverage,
  toUnixCandles,
  toUnixLine,
  withCoverage,
  type InstrumentUpdate,
  type MarketDataSource,
  type Trade,
  type TradeOptions,
} from '@keicoin/market'

import { createInstrumentFactory } from '../src/instrument.js'

import { DelegateNode, GateNode, TwoFacedNode } from './harness/net.js'
import { World, until } from './harness/world.js'

const worlds: World[] = []

class ComplementaryFailureNode extends DelegateNode {
  constructor(
    inner: ConstructorParameters<typeof DelegateNode>[0],
    private readonly bookFailure: string,
    private readonly historyFailure: string,
  ) {
    super(inner)
  }

  override accountSwaps(
    address: string,
    options?: { limit?: number; state?: SwapState },
  ): Promise<SwapOffer[]> {
    if (options?.state === 'open' && address === this.bookFailure) throw new Error('book missed A')
    if (options?.state === 'accepted' && address === this.historyFailure) throw new Error('history missed B')
    return super.accountSwaps(address, options)
  }
}

class MutableDecimalsNode extends DelegateNode {
  poison: number | null = null

  constructor(inner: ConstructorParameters<typeof DelegateNode>[0], private readonly target: AssetId) {
    super(inner)
  }

  override async assetInfo(asset: AssetId): Promise<AssetInfo | null> {
    const info = await super.assetInfo(asset)
    return info && asset === this.target && this.poison !== null ? { ...info, decimals: this.poison } : info
  }
}

afterEach(() => {
  for (const world of worlds.splice(0)) world.close()
})

async function marketWorld() {
  const world = await World.create()
  worlds.push(world)
  const seller = await world.actor('seller')
  const buyer = await world.actor('buyer')
  const sword = await world.issue({ symbol: 'SWORD', decimals: 0, swap: 'two-way' })
  await world.mint(sword, seller, 20)
  return { world, seller, buyer, sword }
}

describe('instrument market product surface', () => {
  test('one bound call returns a serializable ticker, book, line, OHLCV, exact terms, and honest limits', async () => {
    const { world, seller, buyer, sword } = await marketWorld()
    const source = createAccountChainSource({
      id: 'test-sword-market',
      accounts: [seller.address, buyer.address, 'not-an-address'],
    })
    const sellerSword = seller.market.instrument({ base: sword, quote: KEI_ASSET, source })
    const buyerSword = buyer.market.instrument({ base: sword, quote: KEI_ASSET, source })

    const first = await sellerSword.sell({ units: 2, unitPrice: '1.25' })
    expect(first.give.raw).toBe('2')
    expect(first.want.raw).toBe('2500000000000000000')
    world.clock.tick(1_000)

    const shown = await buyerSword.snapshot({
      depth: 20,
      history: { interval: '1s', range: { window: '30d' } },
    })
    expect(shown.book.bestAsk?.unitPrice).toBe(1.25)
    await buyerSword.accept(shown.book.bestAsk!)
    world.clock.tick(1_000)
    await sellerSword.sell({ units: 3, unitPrice: 2 })

    const snapshot = await buyerSword.snapshot({
      depth: 20,
      history: { interval: '1s', range: { window: '30d' } },
    })
    expect(snapshot.instrument).toEqual({
      id: `${sword}/${KEI_ASSET}`,
      key: `mock:test-sword-market:${sword}/${KEI_ASSET}`,
      base: sword,
      quote: KEI_ASSET,
      priceUnit: 'quote-per-base',
    })
    expect(snapshot.state).toBe('available')
    expect(snapshot.completeness).toBe('partial')
    expect(snapshot.ticker).toMatchObject({
      state: 'available',
      last: 1.25,
      volume: 2,
      trades: 1,
      bestAsk: 2,
    })
    expect(snapshot.book.asks).toHaveLength(1)
    expect(snapshot.book.bids).toHaveLength(0)
    expect(snapshot.history.points).toHaveLength(1)
    expect(snapshot.history.candles).toHaveLength(1)
    expect(snapshot.history.points[0]?.exact).toEqual({
      baseRaw: '2',
      quoteRaw: '2500000000000000000',
      baseDecimals: 0,
      quoteDecimals: 18,
      numerator: '2500000000000000000',
      denominator: '2000000000000000000',
    })
    expect(snapshot.history.interval).toEqual({ input: '1s', milliseconds: 1_000 })
    expect(snapshot.history.time).toMatchObject({ basis: 'node-first-seen', timed: 1, untimed: 0 })
    expect(snapshot.pagination).toMatchObject({ supported: false, cursor: null })
    expect(snapshot.provenance).toMatchObject({
      id: 'test-sword-market',
      identified: true,
      kind: 'account-chain',
      scope: 'explicit-account-chains',
      durability: 'node-local',
      authority: 'untrusted-discovery',
    })
    expect(snapshot.coverage.book.skipped).toEqual(['not-an-address'])

    const line = toUnixLine(snapshot.history)
    const candles = toUnixCandles(snapshot.history)
    expect(line).toEqual([{ time: Math.floor((snapshot.history.points[0]?.at ?? 0) / 1_000), value: 1.25 }])
    expect(candles[0]).toMatchObject({ time: Math.floor((snapshot.history.candles[0]?.at ?? 0) / 1_000), close: 1.25 })

    const json = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot
    expect(json.history.coverage).toEqual(snapshot.history.coverage)
    expect(json.history.points[0]?.exact).toEqual(snapshot.history.points[0]?.exact)
    expect(json.history.pagination).toEqual(snapshot.history.pagination)
    expect(json.provenance).toEqual(snapshot.provenance)
  })

  test('empty, partial, and available state are independent axes', async () => {
    const { seller, buyer, sword } = await marketWorld()
    const empty = buyer.market.instrument({ base: sword, quote: KEI_ASSET, source: [buyer.address] })
    const emptySnapshot = await empty.snapshot()
    expect(emptySnapshot).toMatchObject({ state: 'empty', completeness: 'complete' })
    expect(emptySnapshot.history).toMatchObject({ state: 'empty', completeness: 'complete' })

    await seller.market.instrument({ base: sword, quote: KEI_ASSET, source: [seller.address] })
      .sell({ units: 1, unitPrice: 3 })
    const partial = buyer.market.instrument({
      base: sword,
      quote: KEI_ASSET,
      source: [seller.address, 'invalid'],
    })
    const partialSnapshot = await partial.snapshot()
    expect(partialSnapshot).toMatchObject({ state: 'available', completeness: 'partial' })
    expect(partialSnapshot.book).toMatchObject({ state: 'available', completeness: 'partial' })
  })

  test('output depth is not a pre-ranking read limit that can hide an older best price', async () => {
    const { seller, buyer, sword } = await marketWorld()
    const instrument = seller.market.instrument({ base: sword, quote: KEI_ASSET, source: [seller.address] })
    const cheapest = await instrument.sell({ units: 1, unitPrice: 1 })
    await instrument.sell({ units: 1, unitPrice: 3 })
    await instrument.sell({ units: 1, unitPrice: 2 })

    const ranked = await buyer.market
      .instrument({ base: sword, quote: KEI_ASSET, source: [seller.address] })
      .snapshot({ depth: 1 })
    expect(ranked.book.asks).toHaveLength(1)
    expect(ranked.book.bestAsk?.hash).toBe(cheapest.hash)
    expect(ranked.book.bestAsk?.unitPrice).toBe(1)
    expect(ranked.book.coverage.truncated).toEqual([])

    const deliberatelyTinyRead = await buyer.market
      .instrument({ base: sword, quote: KEI_ASSET, source: [seller.address] })
      .snapshot({ depth: 1, bookLimit: 1 })
    expect(deliberatelyTinyRead.book.coverage.truncated).toEqual([seller.address])
    expect(deliberatelyTinyRead.completeness).toBe('partial')
  })

  test('a direct source is explicit but does not pretend to have a stable venue identity', async () => {
    const { buyer, sword } = await marketWorld()
    const instrument = buyer.market.instrument({ base: sword, quote: KEI_ASSET, source: [buyer.address] })
    const snapshot = await instrument.snapshot()

    expect(instrument.source).toEqual({ id: 'anonymous:account-chain', identified: false, kind: 'account-chain' })
    expect(instrument.instrument.key).toBeNull()
    expect(snapshot.provenance).toMatchObject({ id: 'anonymous:account-chain', identified: false })
  })

  test('invalid output and read budgets refuse before a custom source is touched', async () => {
    const { buyer, sword } = await marketWorld()
    let touched = 0
    const source = {
      accounts() {
        touched += 1
        return [buyer.address]
      },
    }
    const instrument = buyer.market.instrument({ base: sword, quote: KEI_ASSET, source })

    await expect(instrument.snapshot({ bookLimit: 0 })).rejects.toMatchObject({ code: 'bad-limit' })
    await expect(instrument.snapshot({ history: { limit: Infinity } })).rejects.toMatchObject({ code: 'bad-limit' })
    await expect(instrument.snapshot({ history: { last: -1 } })).rejects.toMatchObject({ code: 'bad-limit' })
    await expect(instrument.snapshot({ history: { maxCandles: Infinity } })).rejects.toMatchObject({ code: 'bad-max-candles' })
    expect(touched).toBe(0)
  })

  test('untimed trades remain visible as data and do not masquerade as an empty history', async () => {
    const { world, seller, buyer, sword } = await marketWorld()
    const sellerInstrument = seller.market.instrument({ base: sword, quote: KEI_ASSET, source: [seller.address] })
    const listed = await sellerInstrument.sell({ units: 1, unitPrice: 4 })
    await buyer.market.accept(listed)

    const lying = new TwoFacedNode(world.node)
    lying.lieAboutSwaps((_address, offers) => offers.map((offer) => offer.state === 'accepted'
      ? { ...offer, settledAt: null, seenAt: null as unknown as number }
      : offer))
    const observer = await world.actor('observer', { node: lying })
    const history = await observer.market
      .instrument({ base: sword, quote: KEI_ASSET, source: [seller.address] })
      .history({ interval: '1h' })

    expect(history.state).toBe('available')
    expect(history.completeness).toBe('partial')
    expect(history.temporalCompleteness).toBe('partial')
    expect(history.points).toHaveLength(1)
    expect(history.points[0]?.at).toBeNull()
    expect(history.time).toMatchObject({ timed: 0, estimated: 0, untimed: 1 })
    expect(history.candles).toEqual([])
  })

  test('requested windows use seenAt, include exact boundaries, and preserve unplaceable time gaps', async () => {
    const { seller, sword } = await marketWorld()
    const coverage = emptyCoverage()
    const trade = (
      hash: string,
      price: number,
      settledAt: number | null,
      seenAt: number | null,
    ): Trade => ({
      hash: hash.repeat(64),
      from: seller.address,
      seller: seller.address,
      buyer: seller.address,
      give: { asset: sword, symbol: 'SWORD', name: 'Sword', decimals: 0, amount: 1, raw: '1' },
      want: { asset: KEI_ASSET, symbol: 'KEI', name: 'Kei', decimals: 0, amount: price, raw: String(price) },
      price,
      to: null,
      expiresAt: null,
      expired: false,
      state: 'accepted',
      mine: false,
      acceptedBy: seller.address,
      settledBy: hash.repeat(64),
      seenAt: seenAt as number,
      settledAt,
    })
    const before = trade('A', 1, 4_999, 4_999)
    const lowerBoundary = trade('B', 2, 5_000, 5_000)
    const seenOnly = trade('C', 3, null, 6_000)
    const upperBoundary = trade('D', 4, 10_000, 10_000)
    const after = trade('E', 5, null, 10_001)
    const untimed = trade('F', 6, null, null)
    let returned = [before, lowerBoundary, seenOnly, upperBoundary, after, untimed]
    const reads: TradeOptions[] = []
    const factory = createInstrumentFactory({
      network: 'mock',
      now: () => 10_000,
      async readBook() {
        return {
          asset: sword,
          quote: KEI_ASSET,
          asks: [],
          bids: [],
          bestAsk: null,
          bestBid: null,
          spread: null,
          other: [],
          coverage,
        }
      },
      async readTrades(options) {
        reads.push(options)
        return withCoverage([...returned], coverage)
      },
      async offer() { throw new Error('not used') },
      async accept() { throw new Error('not used') },
    })
    const instrument = factory.instrument({ base: sword, quote: KEI_ASSET, source: [seller.address] })

    const history = await instrument.history({ interval: 1_000, range: { window: 5_000 } })
    expect(reads[0]).not.toHaveProperty('window')
    expect(reads[0]).not.toHaveProperty('last')
    expect(history.requested).toEqual({ window: 5_000, from: 5_000, to: 10_000 })
    expect(history.state).toBe('available')
    expect(history.completeness).toBe('partial')
    expect(history.temporalCompleteness).toBe('partial')
    expect(history.points.map(({ hash, at, estimated, price }) => ({ hash, at, estimated, price }))).toEqual([
      { hash: lowerBoundary.hash, at: 5_000, estimated: false, price: 2 },
      { hash: seenOnly.hash, at: 6_000, estimated: true, price: 3 },
      { hash: upperBoundary.hash, at: 10_000, estimated: false, price: 4 },
    ])
    expect(history.observed).toEqual({ from: 5_000, to: 10_000 })
    expect(history.time).toMatchObject({ timed: 2, estimated: 1, untimed: 1 })
    expect(history.summary).toMatchObject({ first: 2, last: 4, low: 2, high: 4, volume: 3, trades: 3 })
    expect(history.candles.map(({ at, open, close, trades }) => ({ at, open, close, trades }))).toEqual([
      { at: 5_000, open: 2, close: 2, trades: 1 },
      { at: 6_000, open: 3, close: 3, trades: 1 },
      { at: 10_000, open: 4, close: 4, trades: 1 },
    ])
    expect(history.coverage).toEqual(coverage)
    expect(toUnixLine(history)).toEqual([
      { time: 5, value: 2 },
      { time: 6, value: 3 },
      { time: 10, value: 4 },
    ])

    const latest = await instrument.history({ interval: 1_000, range: { window: 5_000 }, last: 1 })
    expect(latest.points.map(({ hash }) => hash)).toEqual([upperBoundary.hash])
    expect(latest.time).toMatchObject({ timed: 1, estimated: 0, untimed: 1 })
    expect(latest.temporalCompleteness).toBe('partial')

    returned = [untimed]
    const snapshot = await instrument.snapshot({ history: { interval: 1_000, range: { window: 5_000 } } })
    expect(snapshot.state).toBe('available')
    expect(snapshot.completeness).toBe('partial')
    expect(snapshot.ticker).toMatchObject({ state: 'available', completeness: 'partial', trades: 0, last: null })
    expect(snapshot.history).toMatchObject({
      state: 'available',
      completeness: 'partial',
      temporalCompleteness: 'partial',
      points: [],
      candles: [],
      observed: { from: null, to: null },
      time: { timed: 0, estimated: 0, untimed: 1 },
      coverage,
    })
    expect(snapshot.history.summary).toMatchObject({ first: null, last: null, volume: 0, trades: 0 })
    expect(toUnixLine(snapshot.history)).toEqual([])
    expect(toUnixCandles(snapshot.history)).toEqual([])
    expect(snapshot.coverage.history).toEqual(coverage)
    expect(snapshot.coverage.complete).toBe(true)
    factory.close()
  }, 30_000)

  test('unit-priced asks and bids produce exact total terms and displayed levels cannot weaken acceptance', async () => {
    const { seller, buyer, sword } = await marketWorld()
    const source = [seller.address, buyer.address]
    const sell = seller.market.instrument({ base: sword, quote: KEI_ASSET, source })
    const buy = buyer.market.instrument({ base: sword, quote: KEI_ASSET, source })

    const ask = await sell.sell({ units: 2, unitPrice: '1.25' })
    expect(ask.give.raw).toBe('2')
    expect(ask.want.raw).toBe('2500000000000000000')

    const shown = (await buy.snapshot()).book.bestAsk!
    const altered = structuredClone(shown)
    altered.unitPrice = 0.01
    const refused = await buy.accept(altered).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(KeiError)
    expect(refused).toMatchObject({ code: 'offer-changed' })
    expect((await buyer.market.get(ask.hash))?.state).toBe('open')

    await buy.accept(shown)
    const bid = await buy.bid({ units: 2, unitPrice: '1.5' })
    expect(bid.give.raw).toBe('3000000000000000000')
    expect(bid.want.raw).toBe('2')
    const level = (await sell.snapshot()).book.bestBid!
    expect(level.unitPrice).toBe(1.5)
    expect(level.exact).toMatchObject({ baseRaw: '2', quoteRaw: '3000000000000000000' })
  })

  test('subscription never overlaps, aborts cleanly, and emits nothing after stop', async () => {
    const { world, seller, sword } = await marketWorld()
    const gated = new GateNode(world.node)
    gated.hold('accountSwaps', (account) => account === seller.address)
    const observer = await world.actor('observer', { node: gated })
    const instrument = observer.market.instrument({ base: sword, quote: KEI_ASSET, source: [seller.address] })
    const updates: InstrumentUpdate[] = []
    let stop = (): void => undefined
    stop = instrument.subscribe({ every: 1 }, (update) => {
      updates.push(update)
      if (update.status === 'live') stop()
    })

    expect(updates.map((update) => update.status)).toEqual(['opening'])
    const bookRead = await gated.captured()
    const historyRead = await gated.captured()
    await expect(gated.captured(20)).rejects.toThrow('Timed out')
    bookRead.release()
    historyRead.release()
    await until(() => updates.some((update) => update.status === 'live'))
    const stoppedAt = updates.length
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(updates).toHaveLength(stoppedAt)
  })

  test('transient source failure retains last-good data and reports deterministic stale age', async () => {
    const { world, seller, buyer, sword } = await marketWorld()
    await seller.market.instrument({ base: sword, quote: KEI_ASSET, source: [seller.address] })
      .sell({ units: 1, unitPrice: 5 })
    let broken = false
    const source = {
      accounts() {
        if (broken) throw new Error('catalog offline')
        return [seller.address]
      },
    }
    const instrument = buyer.market.instrument({ base: sword, quote: KEI_ASSET, source })
    const updates: InstrumentUpdate[] = []
    const stop = instrument.subscribe({ every: 5, staleAfter: 5 }, (update) => updates.push(update))
    await until(() => updates.some((update) => update.status === 'live'))
    const live = updates.find((update) => update.status === 'live')!
    expect(live.snapshot).not.toBeNull()
    const lastGood = live.snapshot
    broken = true
    world.clock.tick(10)
    await until(() => updates.some((update) => update.status === 'stale'))
    stop()

    const stale = updates.find((update) => update.status === 'stale')!
    expect(stale.age).toBe(10)
    expect(stale.stale).toBe(true)
    expect(stale.snapshot).toEqual(lastGood)
    expect(stale.lastGood).toEqual(lastGood)
    expect(stale.error).toMatchObject({ message: 'catalog offline' })
  })

  test('snapshot coverage is the exact same-roster intersection, not the minimum read count', async () => {
    const { world, seller, buyer, sword } = await marketWorld()
    const split = new ComplementaryFailureNode(world.node, seller.address, buyer.address)
    const observer = await world.actor('coverage-observer', { node: split })
    const snapshot = await observer.market
      .instrument({ base: sword, quote: KEI_ASSET, source: [seller.address, buyer.address] })
      .snapshot()

    expect(snapshot.coverage.book).toMatchObject({ asked: 2, read: 1, complete: false })
    expect(snapshot.coverage.history).toMatchObject({ asked: 2, read: 1, complete: false })
    expect(snapshot.coverage.combined).toMatchObject({ asked: 2, read: 0, complete: false })
    expect(snapshot.coverage.combined.failed.map(({ account }) => account).sort()).toEqual(
      [seller.address, buyer.address].sort(),
    )
    expect(snapshot.provenance).toMatchObject({ accountsAsked: 2, accountsRead: 0 })
  }, 30_000)

  test('pre-aborted reads and subscriptions do not touch hostile directory getters', async () => {
    const { buyer, sword } = await marketWorld()
    let touched = 0
    const source = {
      get size(): number {
        touched += 1
        throw new Error('size touched')
      },
      get dropped(): number {
        touched += 1
        throw new Error('dropped touched')
      },
      accounts(): readonly string[] {
        touched += 1
        throw new Error('accounts touched')
      },
    }
    const instrument = buyer.market.instrument({ base: sword, quote: KEI_ASSET, source })
    const controller = new AbortController()
    controller.abort('already gone')

    await expect(instrument.history({ signal: controller.signal })).rejects.toMatchObject({ code: 'read-aborted' })
    await expect(instrument.snapshot({ signal: controller.signal })).rejects.toMatchObject({ code: 'read-aborted' })
    const updates: InstrumentUpdate[] = []
    instrument.subscribe({ every: 1, readTimeout: 5, signal: controller.signal }, (update) => updates.push(update))
    expect(() => instrument.subscribe({ every: 1, readTimeout: Infinity }, () => undefined)).toThrow()
    expect(updates).toEqual([])
    expect(touched).toBe(0)
  }, 30_000)

  test('structural data sources validate their discriminant, identity, and account source eagerly', async () => {
    const { buyer, sword } = await marketWorld()
    const malformed: unknown[] = [
      { kind: 'account-chain', id: '', accounts: null },
      { kind: 'account-chain', id: 'named', accounts: null },
      { kind: 'future-provider', id: 'named', accounts: [buyer.address] },
      123,
      {},
      () => [buyer.address],
    ]
    for (const source of malformed) {
      const failure = (() => {
        try {
          buyer.market.instrument({ base: sword, quote: KEI_ASSET, source: source as MarketDataSource })
          return null
        } catch (error) {
          return error
        }
      })()
      expect(failure).toMatchObject({ code: 'bad-account-source' })
    }
  }, 30_000)

  test('a clock failure after a successful snapshot is terminal, handled, and does not promote the failed refresh', async () => {
    const { world, buyer, sword } = await marketWorld()
    let clockCalls = 0
    const now = (): number => {
      clockCalls += 1
      if (clockCalls === 5) throw new Error('clock broke after the second read')
      return world.clock.at
    }
    const observer = await world.actor('clock-observer', { market: { now } })
    const updates: InstrumentUpdate[] = []
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      observer.market.instrument({ base: sword, quote: KEI_ASSET, source: [buyer.address] })
        .subscribe({ every: 1, readTimeout: 50 }, (update) => updates.push(update))
      await until(() => updates.some((update) => update.error?.code === 'bad-market-time'))
      await new Promise((resolve) => setTimeout(resolve, 15))
      const live = updates.filter((update) => update.status === 'live')
      const failed = updates.find((update) => update.error?.code === 'bad-market-time')!
      expect(live).toHaveLength(1)
      expect(failed.lastGood).toEqual(live[0]!.snapshot)
      expect(failed.snapshot).toEqual(live[0]!.snapshot)
      expect(clockCalls).toBe(5)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  }, 30_000)

  test('snapshot asOf and feed age use successful refresh completion, while requested range stays at request time', async () => {
    const { world, seller, sword } = await marketWorld()
    const gated = new GateNode(world.node)
    gated.hold('accountSwaps', (account) => account === seller.address)
    const observer = await world.actor('age-observer', { node: gated })
    let broken = false
    const source = {
      accounts() {
        if (broken) throw new Error('source failed immediately after live')
        return [seller.address]
      },
    }
    const updates: InstrumentUpdate[] = []
    const instrument = observer.market.instrument({ base: sword, quote: KEI_ASSET, source })
    const requestedAt = world.clock.at
    const stop = instrument.subscribe({ every: 1, readTimeout: 1_000 }, (update) => {
      updates.push(update)
      if (update.status === 'live') broken = true
    })
    const bookRead = await gated.captured()
    const historyRead = await gated.captured()
    world.clock.tick(1_000)
    bookRead.release()
    historyRead.release()
    await until(() => updates.some((update) => update.status === 'live'))
    await until(() => updates.some((update) => update.status === 'error'))
    stop()

    const live = updates.find((update) => update.status === 'live')!
    const failed = updates.find((update) => update.status === 'error')!
    expect(live.at).toBe(world.clock.at)
    expect(live.snapshot?.asOf).toBe(world.clock.at)
    expect(live.snapshot?.history.requested.to).toBe(requestedAt)
    expect(failed.age).toBe(0)
    expect(failed.lastGood).toEqual(live.snapshot)
  }, 30_000)

  test('a per-refresh deadline leaves opening, retains last-good, and handles a late directory rejection', async () => {
    const { buyer, sword } = await marketWorld()
    let hang = false
    let calls = 0
    let pending = 0
    let maxPending = 0
    let rejectLate: ((reason?: unknown) => void) | undefined
    const source = {
      accounts(): readonly string[] | Promise<readonly string[]> {
        calls += 1
        if (!hang) return [buyer.address]
        pending += 1
        maxPending = Math.max(maxPending, pending)
        return new Promise<readonly string[]>((_resolve, reject) => {
          rejectLate = (reason) => {
            pending -= 1
            reject(reason)
          }
        })
      },
    }
    const instrument = buyer.market.instrument({ base: sword, quote: KEI_ASSET, source })
    const updates: InstrumentUpdate[] = []
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    let stop = (): void => undefined
    try {
      stop = instrument.subscribe({ every: 1, readTimeout: 5 }, (update) => {
        updates.push(update)
        if (update.status === 'live') hang = true
        if (update.error?.code === 'read-timeout') stop()
      })
      await until(() => updates.some((update) => update.error?.code === 'read-timeout'))
      const live = updates.find((update) => update.status === 'live')!
      const timedOut = updates.find((update) => update.error?.code === 'read-timeout')!
      expect(timedOut.lastGood).toEqual(live.snapshot)
      expect(timedOut.snapshot).toEqual(live.snapshot)
      expect(maxPending).toBe(1)
      expect(calls).toBe(2)
      rejectLate?.(new Error('late catalog rejection'))
      await new Promise((resolve) => setTimeout(resolve, 15))
      expect(unhandled).toEqual([])
    } finally {
      stop()
      process.off('unhandledRejection', onUnhandled)
    }
  }, 30_000)

  test('hostile decimal inputs, raw quantities, and asset decimals fail with typed bounded errors', async () => {
    const { world, seller, buyer, sword } = await marketWorld()
    const instrument = seller.market.instrument({ base: sword, quote: KEI_ASSET, source: [seller.address] })
    await expect(instrument.sell({ units: '9'.repeat(100_000), unitPrice: 1 })).rejects.toMatchObject({ code: 'bad-amount' })
    await expect(instrument.sell({ units: 1, unitPrice: '0.0000000000000000001' })).rejects.toMatchObject({ code: 'bad-amount' })
    await expect(instrument.sell({ units: '340282366920938463463374607431768211455', unitPrice: 2 }))
      .rejects.toMatchObject({ code: 'bad-amount' })

    const listed = await instrument.sell({ units: 1, unitPrice: 1 })
    const rawPoison = new TwoFacedNode(world.node)
    rawPoison.lieAboutSwaps((_address, offers) => offers.map((offer) => offer.hash === listed.hash
      ? { ...offer, amount: '9'.repeat(4_000) }
      : offer))
    const rawObserver = await world.actor('raw-observer', { node: rawPoison })
    await expect(rawObserver.market.instrument({ base: sword, quote: KEI_ASSET, source: [seller.address] }).snapshot())
      .rejects.toMatchObject({ code: 'bad-offer' })

    const decimalsPoison = new MutableDecimalsNode(world.node, sword)
    decimalsPoison.poison = Number.POSITIVE_INFINITY
    const metaObserver = await world.actor('meta-observer', { node: decimalsPoison })
    await expect(metaObserver.market.instrument({ base: sword, quote: KEI_ASSET, source: [seller.address] }).snapshot())
      .rejects.toMatchObject({ code: 'bad-asset-metadata' })
  }, 30_000)

  test('overflowing aggregate volume is refused before a history or candle can serialize null', async () => {
    const { seller, sword } = await marketWorld()
    const coverage = emptyCoverage()
    const trade = (hash: string): Trade => ({
      hash,
      from: seller.address,
      seller: seller.address,
      buyer: seller.address,
      give: { asset: sword, symbol: 'SWORD', name: 'Sword', decimals: 0, amount: Number.MAX_VALUE, raw: '1' },
      want: { asset: KEI_ASSET, symbol: 'KEI', name: 'Kei', decimals: 18, amount: Number.MAX_VALUE, raw: '1' },
      price: 1,
      to: null,
      expiresAt: null,
      expired: false,
      state: 'accepted',
      mine: false,
      acceptedBy: seller.address,
      settledBy: hash,
      seenAt: 1,
      settledAt: 1,
    })
    const factory = createInstrumentFactory({
      network: 'mock',
      now: () => 1,
      async readBook() {
        return {
          asset: sword,
          quote: KEI_ASSET,
          asks: [],
          bids: [],
          bestAsk: null,
          bestBid: null,
          spread: null,
          other: [],
          coverage,
        }
      },
      async readTrades() {
        return withCoverage([trade('A'.repeat(64)), trade('B'.repeat(64))], coverage)
      },
      async offer() { throw new Error('not used') },
      async accept() { throw new Error('not used') },
    })
    const instrument = factory.instrument({ base: sword, quote: KEI_ASSET, source: [seller.address] })
    await expect(instrument.history({ interval: 1 })).rejects.toMatchObject({ code: 'bad-offer' })
    factory.close()
  }, 30_000)

  test('instrument acceptance freshly revalidates displayed decimals that bind the exact price ratio', async () => {
    const { world, seller, buyer, sword } = await marketWorld()
    const listed = await seller.market.instrument({ base: sword, quote: KEI_ASSET, source: [seller.address] })
      .sell({ units: 1, unitPrice: 2 })
    const changing = new MutableDecimalsNode(world.node, sword)
    const observer = await world.actor('decimal-observer', { node: changing })
    const instrument = observer.market.instrument({ base: sword, quote: KEI_ASSET, source: [seller.address] })
    const shown = (await instrument.snapshot()).book.bestAsk!
    changing.poison = 1

    await expect(instrument.accept(shown)).rejects.toMatchObject({ code: 'offer-changed' })
    expect((await buyer.market.get(listed.hash))?.state).toBe('open')
  }, 30_000)
})
