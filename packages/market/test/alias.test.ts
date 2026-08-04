/**
 * Charting aliases stay true to their primary methods.
 *
 * The market API exposes `history`, `ohlc`, and `chart` aliases to match how
 * game builders describe their charts. They must remain simple passthroughs so
 * SDK users can switch from raw ledger names to domain names without changing
 * behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { KEI_ASSET, type AssetId } from '@keicoin/core'
import { World } from './harness/world.js'

let world: World
let asset: AssetId

beforeEach(async () => {
  world = await World.create()
  asset = await world.issue({ symbol: 'SWORD' })
})

afterEach(() => {
  world.close()
})

describe('chart aliases are strict compatibility wrappers', () => {
  test('history delegates to series with the same arguments', async () => {
    const seller = await world.actor('seller')
    const buyer = await world.actor('buyer')
    await world.mint(asset, seller, 1)

    const listing = await seller.market.sell({ asset, amount: 1, price: 2 })
    await buyer.market.accept(listing)

    const series = await seller.market.series({ from: [seller.address, buyer.address], asset })
    const history = await seller.market.history({ from: [seller.address, buyer.address], asset })

    expect(history).toEqual(series)
  })

  test('ohlc delegates to candles with the same arguments', async () => {
    const seller = await world.actor('seller')
    const buyer = await world.actor('buyer')
    await world.mint(asset, seller, 1)

    const listing = await seller.market.sell({ asset, amount: 1, price: 2 })
    await buyer.market.accept(listing)

    const candles = await seller.market.candles({ from: [seller.address, buyer.address], asset, every: '1m' })
    const ohlc = await seller.market.ohlc({ from: [seller.address, buyer.address], asset, every: '1m' })

    expect(ohlc).toEqual(candles)
  })

  test('ohlc accepts interval as an alias for every', async () => {
    const seller = await world.actor('seller')
    const buyer = await world.actor('buyer')
    await world.mint(asset, seller, 1)

    const listing = await seller.market.sell({ asset, amount: 1, price: 2 })
    await buyer.market.accept(listing)

    const byEvery = await seller.market.ohlc({ from: [seller.address, buyer.address], asset, every: '1m' })
    const byInterval = await seller.market.ohlc({
      from: [seller.address, buyer.address],
      asset,
      interval: '1m',
    })

    expect(byInterval).toEqual(byEvery)
  })

  test('chart returns the same series and candles payload', async () => {
    const seller = await world.actor('seller')
    const buyer = await world.actor('buyer')
    await world.mint(asset, seller, 1)

    const listing = await seller.market.sell({ asset, amount: 1, price: 2 })
    await buyer.market.accept(listing)

    const chart = await seller.market.chart({ from: [seller.address, buyer.address], asset, every: '1m' })
    const series = await seller.market.series({ from: [seller.address, buyer.address], asset })
    const candles = await seller.market.candles({ from: [seller.address, buyer.address], asset, every: '1m' })

    expect(chart.series).toEqual(series)
    expect(chart.candles).toEqual(candles)
  })

  test('chart includes line and unixCandles chart payloads', async () => {
    const seller = await world.actor('seller')
    const buyer = await world.actor('buyer')
    await world.mint(asset, seller, 1)

    const listing = await seller.market.sell({ asset, amount: 1, price: 2 })
    await buyer.market.accept(listing)

    const chart = await seller.market.chart({
      from: [seller.address, buyer.address],
      asset,
      every: '1m',
    })

    const firstPoint = chart.series.points[0]
    if (!firstPoint || firstPoint.at === null) throw new Error('expected a timed series point')

    expect(chart.line).toEqual([{ time: firstPoint.at / 1_000, value: firstPoint.price }])
    expect(chart.unixCandles).toEqual(chart.candles.map((candle) => ({
      time: Math.floor(candle.at / 1_000),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      trades: candle.trades,
    })))
    const firstSeriesPoint = chart.series.points[0]
    const lastSeriesPoint = chart.series.points[chart.series.points.length - 1]
    expect(chart.requested).toMatchObject({
      window: null,
      from: null,
      to: expect.any(Number),
    })
    expect(chart.observed).toMatchObject({
      from: firstSeriesPoint?.at ?? null,
      to: lastSeriesPoint?.at ?? null,
    })
    expect(chart.time).toMatchObject({
      basis: 'node-first-seen',
      timed: expect.any(Number),
      estimated: expect.any(Number),
      untimed: expect.any(Number),
      note: expect.any(String),
    })
    expect(chart.ticker).toMatchObject({
      open: 2,
      last: 2,
      change: 0,
      changeRatio: 0,
      median: 2,
      low: 2,
      high: 2,
      volume: 1,
      trades: 1,
      asset,
      quote: KEI_ASSET,
    })
  })

  test('ticker returns compact market headers from one read', async () => {
    const seller = await world.actor('seller')
    const buyer = await world.actor('buyer')
    await world.mint(asset, seller, 1)

    const listing = await seller.market.sell({ asset, amount: 1, price: 2 })
    await buyer.market.accept(listing)

    const ticker = await seller.market.ticker({
      from: [seller.address, buyer.address],
      asset,
    })

    expect(ticker.asset).toBe(asset)
    expect(ticker.quote).toBe(KEI_ASSET)
    expect(ticker.open).toBe(2)
    expect(ticker.last).toBe(2)
    expect(ticker.change).toBe(0)
    expect(ticker.changeRatio).toBe(0)
    expect(ticker.low).toBe(2)
    expect(ticker.high).toBe(2)
    expect(ticker.median).toBe(2)
    expect(ticker.volume).toBe(1)
    expect(ticker.trades).toBe(1)
    expect(ticker.coverage.complete).toBe(true)
  })

  test('chart defaults candle width to 1h when omitted', async () => {
    const seller = await world.actor('seller')
    const buyer = await world.actor('buyer')
    await world.mint(asset, seller, 1)

    const listing = await seller.market.sell({ asset, amount: 1, price: 2 })
    await buyer.market.accept(listing)

    const chart = await seller.market.chart({ from: [seller.address, buyer.address], asset })
    const candles = await seller.market.candles({
      from: [seller.address, buyer.address],
      asset,
      every: '1h',
    })

    expect(chart.candles).toEqual(candles)
  })

  test('chart accepts explicit range.from and range.to', async () => {
    const seller = await world.actor('seller')
    const buyer = await world.actor('buyer')
    await world.mint(asset, seller, 1)
    const listing = await seller.market.sell({ asset, amount: 1, price: 3 })
    await buyer.market.accept(listing)
    const [trade] = await seller.market.trades({ from: [seller.address, buyer.address], asset })
    if (!trade) throw new Error('expected a trade')

    const secondAt = trade.settledAt ?? trade.seenAt
    if (!Number.isSafeInteger(secondAt)) throw new Error('mock trade time is not safe')
    const firstOnly = await seller.market.chart({
      from: [seller.address, buyer.address],
      asset,
      range: {
        from: secondAt,
        to: secondAt,
      },
    })

    expect(firstOnly.series.points.map((point) => point.price)).toEqual([3])
    expect(firstOnly.requested).toMatchObject({
      window: null,
      from: secondAt,
      to: secondAt,
    })
  })

  test('candles accept interval as an alias for every', async () => {
    const seller = await world.actor('seller')
    const buyer = await world.actor('buyer')
    await world.mint(asset, seller, 1)

    const listing = await seller.market.sell({ asset, amount: 1, price: 2 })
    await buyer.market.accept(listing)

    const byEvery = await seller.market.candles({ from: [seller.address, buyer.address], asset, every: '1m' })
    const byInterval = await seller.market.candles({
      from: [seller.address, buyer.address],
      asset,
      interval: '1m',
    })

    expect(byInterval).toEqual(byEvery)
  })

  test('every and interval cannot both be set on charting methods', async () => {
    const seller = await world.actor('seller')
    const buyer = await world.actor('buyer')
    await world.mint(asset, seller, 1)

    const listing = await seller.market.sell({ asset, amount: 1, price: 2 })
    await buyer.market.accept(listing)

    await expect(
      seller.market.candles({
        from: [seller.address, buyer.address],
        asset,
        every: '1m',
        interval: '1h',
      }),
    ).rejects.toMatchObject({ code: 'bad-duration' })
  })

  test('chart accepts interval as alias for every and rejects both together', async () => {
    const seller = await world.actor('seller')
    const buyer = await world.actor('buyer')
    await world.mint(asset, seller, 1)

    const listing = await seller.market.sell({ asset, amount: 1, price: 2 })
    await buyer.market.accept(listing)

    const byEvery = await seller.market.chart({
      from: [seller.address, buyer.address],
      asset,
      every: '1m',
    })
    const byInterval = await seller.market.chart({
      from: [seller.address, buyer.address],
      asset,
      interval: '1m',
    })

    expect(byInterval).toEqual(byEvery)

    await expect(
      seller.market.chart({
        from: [seller.address, buyer.address],
        asset,
        every: '1m',
        interval: '1h',
      }),
    ).rejects.toMatchObject({ code: 'bad-duration' })
  })

  test('chart line payload preserves every timed row, even with same-second rows', async () => {
    const seller = await world.actor('seller')
    const buyer = await world.actor('buyer')
    await world.mint(asset, seller, 2)

    const fastOne = await seller.market.sell({ asset, amount: 1, price: 3 })
    const fastTwo = await seller.market.sell({ asset, amount: 1, price: 4 })
    await buyer.market.accept(fastOne)
    await buyer.market.accept(fastTwo)

    const chart = await seller.market.chart({ from: [seller.address, buyer.address], asset })
    const timed = chart.series.points.filter((point) => point.at !== null)
    expect(timed.length).toBeGreaterThan(1)
    expect(chart.line).toHaveLength(timed.length)
    expect(new Set(chart.line.map((point) => point.time)).size).toBe(chart.line.length)
  })
})

describe('default trade source in createMarket options', () => {
  test('trade-history reads use market.from when from is omitted', async () => {
    const seller = await world.actor('seller')
    const buyer = await world.actor('buyer')
    const viewer = await world.actor('viewer', {
      market: {
        from: [seller.address, buyer.address],
      },
    })
    await world.mint(asset, seller, 1)

    const listing = await seller.market.sell({ asset, amount: 1, price: 2 })
    await buyer.market.accept(listing)

    const withExplicitFrom = await viewer.market.series({
      from: [seller.address, buyer.address],
      asset,
    })
    const withDefaultSource = await viewer.market.series({
      asset,
    })

    expect(withDefaultSource).toEqual(withExplicitFrom)

    const candlesByDefault = await viewer.market.candles({
      asset,
      interval: '1m',
    })
    const candlesByExplicit = await viewer.market.candles({
      from: [seller.address, buyer.address],
      asset,
      every: '1m',
    })
    expect(candlesByDefault).toEqual(candlesByExplicit)
  })

  test('offers still require explicit source', async () => {
    const seller = await world.actor('seller')
    const buyer = await world.actor('buyer')
    const viewer = await world.actor('viewer', {
      market: {
        from: [seller.address, buyer.address],
      },
    })

    await expect(viewer.market.offers({ from: [] })).rejects.toMatchObject({ code: 'no-accounts' })
  })
})
