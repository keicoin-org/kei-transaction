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

  test('chart returns the same series and candles payload', async () => {
    const seller = await world.actor('seller')
    const buyer = await world.actor('buyer')
    await world.mint(asset, seller, 1)

    const listing = await seller.market.sell({ asset, amount: 1, price: 2 })
    await buyer.market.accept(listing)

    const chart = await seller.market.chart({ from: [seller.address, buyer.address], asset, every: '1m' })
    const series = await seller.market.series({ from: [seller.address, buyer.address], asset, every: '1m' })
    const candles = await seller.market.candles({ from: [seller.address, buyer.address], asset, every: '1m' })

    expect(chart.series).toEqual(series)
    expect(chart.candles).toEqual(candles)
  })
})
