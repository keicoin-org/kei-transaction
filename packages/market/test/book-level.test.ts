import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { KEI_ASSET, type AssetId } from '@keicoin/core'
import { bidPrice, type BookLevel, type Offer } from '@keicoin/market'

import { World, type Actor } from './harness/world.js'

let world: World
let seller: Actor
let bidder: Actor
let reader: Actor
let sword: AssetId
let shield: AssetId

beforeEach(async () => {
  world = await World.create()
  seller = await world.actor('seller')
  bidder = await world.actor('bidder')
  reader = await world.actor('reader')
  sword = await world.issue({ symbol: 'SWORD' })
  shield = await world.issue({ symbol: 'SHIELD' })
  await world.mint(sword, seller, 100_000)
  await world.mint(shield, seller, 100)
})

afterEach(() => {
  world.close()
})

describe('BookLevel orientation', () => {
  test('asks and bids expose one quote-per-base price without changing Offer.price', async () => {
    const ask = await seller.market.sell({ asset: sword, amount: 10_000, price: 4 })
    const bid = await bidder.market.bid({ asset: sword, amount: 10_000, price: 3 })

    const book = await reader.market.book({
      from: [seller.address, bidder.address],
      asset: sword,
    })

    expect(book.bestAsk).toMatchObject({
      hash: ask.hash,
      side: 'ask',
      base: sword,
      quote: KEI_ASSET,
      price: 0.0004,
      unitPrice: 0.0004,
    })
    expect(book.bestBid).toMatchObject({
      hash: bid.hash,
      side: 'bid',
      base: sword,
      quote: KEI_ASSET,
      price: 10_000 / 3,
      unitPrice: 0.0003,
    })
    const bestAsk = book.bestAsk as BookLevel
    const bestBid = book.bestBid as BookLevel
    expect(bidPrice(bestBid)).toBe(bestBid.unitPrice)
    expect(book.spread).toBe(bestAsk.unitPrice - bestBid.unitPrice)

    // Structural extension keeps generic offer-row components source compatible.
    const compatibleOffer: Offer | null = book.bestBid
    expect(compatibleOffer?.hash).toBe(bid.hash)
  })

  test('bids sort highest unit price first', async () => {
    await bidder.market.bid({ asset: sword, amount: 10_000, price: 2 })
    await bidder.market.bid({ asset: sword, amount: 10_000, price: 4 })
    await bidder.market.bid({ asset: sword, amount: 10_000, price: 3 })

    const book = await reader.market.book({ from: [bidder.address], asset: sword })
    expect(book.bids.map((level) => level.unitPrice)).toEqual([0.0004, 0.0003, 0.0002])
    expect(book.bestBid).toBe(book.bids[0] ?? null)
  })

  test('a whole shelf orients each row with the non-quote asset as base', async () => {
    await seller.market.sell({ asset: sword, amount: 2, price: 8 })
    await seller.market.sell({ asset: shield, amount: 3, price: 6 })
    await bidder.market.bid({ asset: sword, amount: 4, price: 10 })

    const book = await reader.market.book({ from: [seller.address, bidder.address] })

    expect(book.asset).toBeNull()
    expect(book.asks.map(({ side, base, quote, unitPrice }) => ({ side, base, quote, unitPrice }))).toEqual([
      { side: 'ask', base: shield, quote: KEI_ASSET, unitPrice: 2 },
      { side: 'ask', base: sword, quote: KEI_ASSET, unitPrice: 4 },
    ])
    expect(book.bids).toHaveLength(1)
    expect(book.bids[0]).toMatchObject({
      side: 'bid',
      base: sword,
      quote: KEI_ASSET,
      unitPrice: 2.5,
    })
    expect(book.spread).toBeNull()
  })

  test('offers outside the selected quote remain bare in other', async () => {
    const barter = await seller.market.offer({
      give: { asset: sword, amount: 2 },
      want: { asset: shield, amount: 6 },
    })

    const book = await reader.market.book({ from: [seller.address], asset: sword })
    expect(book.other).toHaveLength(1)
    expect(book.other[0]?.hash).toBe(barter.hash)
    expect('side' in (book.other[0] as Offer)).toBe(false)
    expect('base' in (book.other[0] as Offer)).toBe(false)
    expect('quote' in (book.other[0] as Offer)).toBe(false)
    expect('unitPrice' in (book.other[0] as Offer)).toBe(false)
  })
})

describe('bare Offer compatibility', () => {
  test('publish, get, offers, mine, and trades do not invent an orientation', async () => {
    const published = await seller.market.sell({ asset: sword, amount: 2, price: 8 })
    const fetched = await reader.market.get(published.hash)
    const listed = await reader.market.offers({ from: [seller.address], asset: sword })
    const mine = await seller.market.mine()

    await reader.market.accept(published)
    const trades = await reader.market.trades({ from: [seller.address], asset: sword })

    const rows: Offer[] = [published, fetched as Offer, listed[0] as Offer, mine[0] as Offer, trades[0] as Offer]
    for (const row of rows) {
      expect(row.price).toBe(row.want.amount / row.give.amount)
      expect('side' in row).toBe(false)
      expect('base' in row).toBe(false)
      expect('quote' in row).toBe(false)
      expect('unitPrice' in row).toBe(false)
    }
  })
})
