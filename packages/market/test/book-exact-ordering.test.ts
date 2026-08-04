import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { KEI_ASSET, type AssetId } from '@keicoin/core'

import { compareExactBookPrices, type ExactBookPrice } from '../src/book.js'
import { World, type Actor } from './harness/world.js'

let world: World
let worse: Actor
let better: Actor
let reader: Actor
let asset: AssetId

beforeEach(async () => {
  world = await World.create()
  worse = await world.actor('worse')
  better = await world.actor('better')
  reader = await world.actor('reader')
  asset = await world.issue({ symbol: 'PX' })
  await world.mint(asset, worse, 10)
  await world.mint(asset, better, 10)
})

afterEach(() => {
  world.close()
})

describe('exact book ranking', () => {
  test('asks use the lower raw ratio when both display prices round to one', async () => {
    const high = await worse.market.sell({ asset, price: '1.000000000000000002' })
    const low = await better.market.sell({ asset, price: '1.000000000000000001' })

    const book = await reader.market.book({ from: [worse.address, better.address], asset })

    expect([high.hash, low.hash].sort((a, b) => a.localeCompare(b))).not.toEqual([low.hash, high.hash])
    expect(book.asks.map(({ unitPrice }) => unitPrice)).toEqual([1, 1])
    expect(book.asks.map(({ hash }) => hash)).toEqual([low.hash, high.hash])
    expect(book.bestAsk?.hash).toBe(low.hash)
  })

  test('bids use the higher raw ratio when both display prices round to one', async () => {
    const high = await worse.market.bid({ asset, price: '1.000000000000000002' })
    const low = await better.market.bid({ asset, price: '1.000000000000000001' })
    const highRaw = await world.node.swapOffer(high.hash)
    const lowRaw = await world.node.swapOffer(low.hash)
    const highHash = 'F'.repeat(64)
    const lowHash = '0'.repeat(64)
    const accountSwaps = spyOn(reader.client.node, 'accountSwaps').mockImplementation(async (address) => {
      if (address === worse.address && highRaw) return [{ ...highRaw, hash: highHash }]
      if (address === better.address && lowRaw) return [{ ...lowRaw, hash: lowHash }]
      return []
    })

    try {
      const book = await reader.market.book({ from: [worse.address, better.address], asset })

      expect(book.bids.map(({ unitPrice }) => unitPrice)).toEqual([1, 1])
      expect(book.bids.map(({ hash }) => hash)).toEqual([highHash, lowHash])
      expect(book.bestBid?.hash).toBe(highHash)
    } finally {
      accountSwaps.mockRestore()
    }
  })

  test('hash is the final tie-break for equivalent exact fractions', async () => {
    const half = await worse.market.sell({ asset, amount: 1, price: '0.5' })
    const twoQuarters = await better.market.sell({ asset, amount: 2, price: '1' })

    const book = await reader.market.book({ from: [worse.address, better.address], asset })
    const hashes = [half.hash, twoQuarters.hash].sort((a, b) => a.localeCompare(b))

    expect(book.asks.map(({ unitPrice }) => unitPrice)).toEqual([0.5, 0.5])
    expect(book.asks.map(({ hash }) => hash)).toEqual(hashes)
  })

  test('whole-shelf asks include each base asset decimal scale', async () => {
    const dust = await world.issue({ symbol: 'DUST', decimals: 18 })
    await world.mint(dust, better, '1000000000000000000')
    const slightlyHigher = await worse.market.sell({ asset, price: '1.000000000000000002' })
    const slightlyLower = await better.market.sell({ asset: dust, price: '1.000000000000000001' })

    const book = await reader.market.book({ from: [worse.address, better.address] })

    expect(book.asks.map(({ unitPrice }) => unitPrice)).toEqual([1, 1])
    expect(book.asks.map(({ hash }) => hash)).toEqual([slightlyLower.hash, slightlyHigher.hash])
    expect(book.asks.map(({ base }) => base)).toEqual([dust, asset])
  })

  test('display-tied spread stays display-only while both best levels are exact', async () => {
    const ask = await worse.market.sell({ asset, price: '1.000000000000000002' })
    const bid = await better.market.bid({ asset, price: '1.000000000000000001' })

    const book = await reader.market.book({ from: [worse.address, better.address], asset })

    expect(book.bestAsk?.hash).toBe(ask.hash)
    expect(book.bestBid?.hash).toBe(bid.hash)
    expect(book.bestAsk?.unitPrice).toBe(1)
    expect(book.bestBid?.unitPrice).toBe(1)
    expect(book.spread).toBe(0)
  })
})

describe('exact rational comparator', () => {
  const price = (overrides: Partial<ExactBookPrice> = {}): ExactBookPrice => ({
    quoteRaw: 1n,
    baseRaw: 1n,
    quoteDecimals: 0,
    baseDecimals: 0,
    ...overrides,
  })

  test('recognises equal fractions across different decimal scales', () => {
    expect(compareExactBookPrices(price({ quoteRaw: 1n, baseRaw: 2n }), price({ quoteRaw: 2n, baseRaw: 4n }))).toBe(0)
    expect(compareExactBookPrices(
      price({ quoteRaw: 1n, baseRaw: 1n, quoteDecimals: 0, baseDecimals: 0 }),
      price({ quoteRaw: 10n, baseRaw: 1n, quoteDecimals: 1, baseDecimals: 0 }),
    )).toBe(0)
  })

  test('is overflow-safe at the maximum 128-bit raw amount', () => {
    const maxRaw = (1n << 128n) - 1n
    expect(compareExactBookPrices(
      price({ quoteRaw: maxRaw, baseRaw: maxRaw - 1n, quoteDecimals: 18, baseDecimals: 18 }),
      price({ quoteRaw: maxRaw - 1n, baseRaw: maxRaw, quoteDecimals: 18, baseDecimals: 18 }),
    )).toBe(1)
  })

  test('handles a defensive zero denominator deterministically as display zero', () => {
    expect(compareExactBookPrices(price({ quoteRaw: 5n, baseRaw: 0n }), price({ quoteRaw: 1n, baseRaw: 2n }))).toBe(-1)
    expect(compareExactBookPrices(price({ quoteRaw: 5n, baseRaw: 0n }), price({ quoteRaw: 9n, baseRaw: 0n }))).toBe(0)
  })
})
