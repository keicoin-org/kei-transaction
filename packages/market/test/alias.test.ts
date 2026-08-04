/**
 * Charting aliases stay true to their primary methods.
 *
 * The market API exposes `history`, `ohlc`, and `chart` aliases to match how
 * game builders describe their charts. They must remain simple passthroughs so
 * SDK users can switch from raw ledger names to domain names without changing
 * behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AssetId } from '@keicoin/core'
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
