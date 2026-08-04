import { afterEach, describe, expect, test } from 'bun:test'

import { KEI_ASSET, KeiError } from '@keicoin/core'
import {
  createAccountChainSource,
  toUnixCandles,
  toUnixLine,
  type InstrumentUpdate,
} from '@keicoin/market'

import { GateNode, TwoFacedNode } from './harness/net.js'
import { World, until } from './harness/world.js'

const worlds: World[] = []

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
})
