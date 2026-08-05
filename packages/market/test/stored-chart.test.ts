/**
 * The whole path #114 asks for, against the mock ledger: announce a roster,
 * ingest it once, and draw an item's chart from the store afterwards — without
 * writing a directory, a cursor, or a price conversion by hand.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { KEI_ASSET, type AssetId } from '@keicoin/core'
import {
  createAccountChainIngestor,
  createMarketCatalog,
  createMarketStore,
  createMemoryMarketStorage,
  type MemoryMarketStorage,
} from '@keicoin/market'

import { World, type Actor } from './harness/world.js'

let world: World
let seller: Actor
let buyer: Actor
let reader: Actor
let sword: AssetId
let storage: MemoryMarketStorage

beforeEach(async () => {
  world = await World.create()
  seller = await world.actor('seller')
  buyer = await world.actor('buyer')
  reader = await world.actor('reader')
  sword = await world.issue({ symbol: 'SWORD', name: 'Iron Sword' })
  await world.mint(sword, seller, 100)
  storage = createMemoryMarketStorage()
})

afterEach(() => {
  world.close()
})

/** Sell `amount` swords for `price` Kei in total, and have the buyer take it. */
async function settle(amount: number, price: number): Promise<void> {
  const offer = await seller.market.sell({ asset: sword, amount, price })
  await buyer.market.accept(offer.hash)
}

async function ingest() {
  const catalog = createMarketCatalog({ storage })
  const store = createMarketStore({ storage })
  await catalog.announce({
    network: world.node.network,
    address: seller.address,
    source: 'harness',
    observedAt: world.clock.at,
    observationId: `seller-${world.clock.at}`,
    instrument: { base: sword, quote: KEI_ASSET },
  })
  const result = await createAccountChainIngestor({
    id: 'mock-node',
    provider: {
      network: world.node.network,
      accountSwaps: (account, options) => world.node.accountSwaps(account, options),
    },
    catalog,
    store,
    now: world.clock.now,
  }).ingest()
  return { store, result }
}

describe('an item chart off the store', () => {
  test('ingest once, then chart the item with names, exact prices, and honest coverage', async () => {
    await settle(2, 30)
    world.clock.tick(60_000)
    await settle(4, 100)

    const { store, result } = await ingest()
    expect(result.stored.inserted).toBeGreaterThan(0)
    // Today's RPC returns a newest window with no exhaustion proof, whatever
    // the ingest found. Nothing downstream may upgrade that to full history.
    expect(result.sourceBackfill).toMatchObject({ complete: false, reason: 'unsupported_pagination' })

    const chart = await reader.market.stored({ store, base: sword }).history({ interval: '1m' })

    expect(chart.instrument.id).toBe('SWORD/KEI')
    expect(chart.instrument.base).toMatchObject({ asset: sword, symbol: 'SWORD', name: 'Iron Sword' })
    expect(chart.points).toHaveLength(2)
    // Two swords for thirty Kei is fifteen Kei each, and the raw legs are what
    // the ledger settled: Kei has 18 decimals, the sword none.
    expect(chart.points[0]).toMatchObject({
      side: 'ask',
      baseQuantity: { raw: '2', display: 2 },
      quoteTotal: { raw: '30000000000000000000', display: 30 },
      unitPrice: { numerator: '15', denominator: '1', display: 15, priceUnit: 'quote-per-base' },
    })
    expect(chart.points[1]?.unitPrice).toMatchObject({ numerator: '25', denominator: '1', display: 25 })
    expect(chart.candles).toHaveLength(2)
    expect(chart.candles[0]).toMatchObject({ trades: 1, every: 60_000 })
    expect(chart.summary).toMatchObject({ trades: 2 })
    expect(chart.summary?.baseVolume.raw).toBe('6')
    expect(chart.summary?.quoteTurnover.raw).toBe('130000000000000000000')
    expect(chart.summary?.low.display).toBe(15)
    expect(chart.summary?.high.display).toBe(25)
    expect(chart.summary?.median).toMatchObject({ numerator: '20', denominator: '1' })
    expect(chart.coverage).toMatchObject({
      scope: 'stored-observations',
      durability: 'memory',
      sourceBackfill: { complete: false, reason: 'unsupported_pagination' },
    })
    expect(chart.pagination).toMatchObject({ complete: true, cursor: null })
    // Everything a view holds on to has to survive being persisted.
    expect(JSON.parse(JSON.stringify(chart))).toEqual(chart)
  })

  test('re-ingesting the same window changes no stored price', async () => {
    await settle(2, 30)
    const first = await ingest()
    const before = await first.store.trades({ network: world.node.network, base: sword, quote: KEI_ASSET })
    world.clock.tick(1_000)
    const second = await ingest()
    const after = await second.store.trades({ network: world.node.network, base: sword, quote: KEI_ASSET })
    expect(after.rows.map((row) => [row.hash, row.give.raw, row.want.raw]))
      .toEqual(before.rows.map((row) => [row.hash, row.give.raw, row.want.raw]))
    expect(second.result.stored.inserted).toBe(0)
    expect(second.result.stored.conflicts).toBe(0)
  })

  test('a store with nothing in it is an empty chart, not a missing one', async () => {
    const { store } = await ingest()
    const chart = await reader.market.stored({ store, base: sword }).history()
    expect(chart.points).toEqual([])
    expect(chart.candles).toEqual([])
    expect(chart.summary).toBeNull()
    expect(chart.observed).toEqual({ from: null, to: null })
    expect(chart.pagination.complete).toBe(true)
  })

  test('market.stored() refuses to invent a store', async () => {
    expect(() => reader.market.stored({ base: sword } as never)).toThrow(/needs \{ store \}/)
  })
})
