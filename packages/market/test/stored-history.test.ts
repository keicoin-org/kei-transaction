/**
 * Exact item price history off the store.
 *
 * The values in here are the #102 reproduction and the 18-decimal dust case,
 * because the whole point of an exact read model is that the two settlements a
 * double cannot tell apart stay apart.
 */

import { describe, expect, test } from 'bun:test'
import { addressFromPublicKey } from '@keicoin/core'
import {
  createMarketStore,
  createMemoryMarketStorage,
  createStoredHistory,
  MARKET_STORAGE_SCHEMA_VERSION,
  type MarketStorageAdapter,
  type MarketStorageEnvelope,
  type StoredAssetIdentity,
  type StoredMarketOfferInput,
} from '@keicoin/market'

const ALICE = addressFromPublicKey('1'.repeat(64))
const BOB = addressFromPublicKey('2'.repeat(64))
const SWORD = 'A'.repeat(64)
const KEI = '0'.repeat(64)
const GOLD = 'B'.repeat(64)

const NAMES: Record<string, StoredAssetIdentity> = {
  [SWORD]: { asset: SWORD, symbol: 'SWORD', name: 'Iron Sword', decimals: 0 },
  [KEI]: { asset: KEI, symbol: 'KEI', name: 'Kei', decimals: 0 },
  [GOLD]: { asset: GOLD, symbol: 'GOLD', name: 'Gold', decimals: 18 },
}

function assets(asset: string): StoredAssetIdentity {
  const found = NAMES[asset]
  if (!found) throw new Error(`test lookup has no asset ${asset}`)
  return found
}

/** A durable adapter whose entire state is one JSON string, as in the store suite. */
function jsonStorage(initial: string | null = null) {
  let bytes = initial
  const adapter: MarketStorageAdapter & { bytes(): string | null } = {
    capabilities: {
      durability: 'durable',
      scope: 'json-text:kei-market-test',
      atomicCompareAndSwap: true,
      migrations: [1, MARKET_STORAGE_SCHEMA_VERSION],
    },
    async load() {
      return bytes === null ? null : JSON.parse(bytes)
    },
    async compareAndSwap(expectedRevision, next) {
      const current = bytes === null ? null : (JSON.parse(bytes) as MarketStorageEnvelope).revision
      if (current !== expectedRevision) return false
      bytes = JSON.stringify(next)
      return true
    },
    bytes() {
      return bytes
    },
  }
  return adapter
}

interface TradeSpec {
  hash: string
  baseRaw: string
  quoteRaw: string
  settledAt: number
  base?: string
  quote?: string
  side?: 'ask' | 'bid'
}

function trade(spec: TradeSpec): StoredMarketOfferInput {
  const base = spec.base ?? SWORD
  const quote = spec.quote ?? KEI
  const ask = (spec.side ?? 'ask') === 'ask'
  return {
    network: 'testnet',
    hash: spec.hash,
    author: ALICE,
    give: ask ? { asset: base, raw: spec.baseRaw } : { asset: quote, raw: spec.quoteRaw },
    want: ask ? { asset: quote, raw: spec.quoteRaw } : { asset: base, raw: spec.baseRaw },
    counterparty: null,
    state: 'accepted',
    acceptedBy: BOB,
    settledBy: `${spec.hash[0]}${'F'.repeat(63)}`,
    height: 3,
    seenAt: spec.settledAt - 5,
    settledAt: spec.settledAt,
    source: 'node-a',
    observedAt: spec.settledAt + 1,
  }
}

function checkpoint(observedAt = 100) {
  return {
    network: 'testnet',
    source: 'node-a',
    account: ALICE,
    adapterVersion: 1,
    generation: 1,
    observedAt,
    newestHash: null,
    providerCursor: null,
    exhausted: false,
    stopReason: 'unsupported_pagination' as const,
  }
}

async function storeWith(rows: readonly StoredMarketOfferInput[], storage = createMemoryMarketStorage()) {
  const store = createMarketStore({ storage })
  await store.materialize({ offers: [...rows], checkpoint: checkpoint() })
  return store
}

function history(store: Awaited<ReturnType<typeof storeWith>>, base = SWORD, quote = KEI) {
  return createStoredHistory({ store, network: 'testnet', base, quote, assets, now: () => 1_000_000 })
}

describe('exact stored history', () => {
  test('keeps the raw pair a double collapses, and names the assets', async () => {
    // The #102 reproduction: 9007199254740993 is the first integer a double
    // cannot hold, so both legs and the ratio land on 1 in the numeric path.
    const store = await storeWith([
      trade({ hash: 'D'.repeat(64), baseRaw: '9007199254740992', quoteRaw: '9007199254740993', settledAt: 500 }),
    ])
    const page = await history(store).history()
    const [point] = page.points
    expect(page.instrument).toMatchObject({ id: 'SWORD/KEI', priceUnit: 'quote-per-base' })
    expect(page.instrument.base).toMatchObject({ symbol: 'SWORD', name: 'Iron Sword' })
    expect(point?.baseQuantity.raw).toBe('9007199254740992')
    expect(point?.quoteTotal.raw).toBe('9007199254740993')
    expect(point?.unitPrice).toMatchObject({
      numerator: '9007199254740993',
      denominator: '9007199254740992',
      priceUnit: 'quote-per-base',
    })
    // The two quantities are the same double and different raws, which is the
    // whole bug: only the exact fields can still tell the legs apart.
    expect(Number(point!.baseQuantity.raw)).toBe(Number(point!.quoteTotal.raw))
    expect(BigInt(point!.quoteTotal.raw) - BigInt(point!.baseQuantity.raw)).toBe(1n)
    expect(BigInt(point!.unitPrice.numerator) > BigInt(point!.unitPrice.denominator)).toBe(true)
    // And it survives being persisted, sent over a wire, or snapshotted.
    expect(JSON.parse(JSON.stringify(page.points))).toEqual(page.points)
  })

  test('distinguishes 18-decimal dust that shares one double', async () => {
    const store = await storeWith([
      trade({ hash: 'A'.repeat(64), baseRaw: '1000000000000000000', quoteRaw: '1000000000000000001', settledAt: 100, quote: GOLD }),
      trade({ hash: 'B'.repeat(64), baseRaw: '1000000000000000000', quoteRaw: '1000000000000000002', settledAt: 200, quote: GOLD }),
    ])
    const page = await history(store, SWORD, GOLD).history()
    const [low, high] = page.points.map((point) => point.unitPrice)
    expect(low?.display).toBe(high?.display)
    expect(low?.numerator).not.toBe(high?.numerator)
    expect(page.summary?.low.numerator).toBe(low!.numerator)
    expect(page.summary?.high.numerator).toBe(high!.numerator)
    // Rising by one raw unit of an 18-decimal quote is still a rise.
    expect(BigInt(page.summary!.change.numerator) > 0n).toBe(true)
  })

  test('a lot total is never read back as a per-unit price', async () => {
    const store = await storeWith([
      trade({ hash: 'C'.repeat(64), baseRaw: '5', quoteRaw: '50', settledAt: 300 }),
    ])
    const [point] = (await history(store).trades()).points
    expect(point?.baseQuantity.raw).toBe('5')
    expect(point?.quoteTotal.raw).toBe('50')
    expect(point?.quoteTotal.display).toBe(50)
    // Ten Kei per sword, not fifty.
    expect(point?.unitPrice).toMatchObject({ numerator: '10', denominator: '1', display: 10 })
  })

  test('orients a bid the same way as an ask', async () => {
    const store = await storeWith([
      trade({ hash: 'A'.repeat(64), baseRaw: '2', quoteRaw: '30', settledAt: 100, side: 'ask' }),
      trade({ hash: 'B'.repeat(64), baseRaw: '2', quoteRaw: '30', settledAt: 200, side: 'bid' }),
    ])
    const page = await history(store).history()
    expect(page.points.map((point) => point.side)).toEqual(['ask', 'bid'])
    for (const point of page.points) {
      expect(point.baseQuantity.asset.symbol).toBe('SWORD')
      expect(point.quoteTotal.asset.symbol).toBe('KEI')
      expect(point.unitPrice).toMatchObject({ numerator: '15', denominator: '1' })
    }
    expect(page.summary).toMatchObject({ trades: 2 })
    expect(page.summary?.baseVolume.raw).toBe('4')
    expect(page.summary?.quoteTurnover.raw).toBe('60')
  })

  test('candles and totals aggregate above safe integer precision', async () => {
    const store = await storeWith([
      trade({ hash: 'A'.repeat(64), baseRaw: '9007199254740993', quoteRaw: '9007199254740993', settledAt: 1_000 }),
      trade({ hash: 'B'.repeat(64), baseRaw: '9007199254740993', quoteRaw: '18014398509481986', settledAt: 2_000 }),
    ])
    const page = await history(store).history({ interval: '1h' })
    expect(page.candles).toHaveLength(1)
    const [candle] = page.candles
    expect(candle?.baseVolume.raw).toBe('18014398509481986')
    expect(candle?.quoteTurnover.raw).toBe('27021597764222979')
    expect(candle?.open).toMatchObject({ numerator: '1', denominator: '1' })
    expect(candle?.close).toMatchObject({ numerator: '2', denominator: '1' })
    expect(candle?.high).toMatchObject({ numerator: '2', denominator: '1' })
    expect(candle?.low).toMatchObject({ numerator: '1', denominator: '1' })
    expect(candle?.trades).toBe(2)
    // An even count medians to the reduced rational average, not to a double.
    expect(page.summary?.median).toMatchObject({ numerator: '3', denominator: '2', display: 1.5 })
    expect(page.summary?.changeRatio).toMatchObject({ numerator: '1', denominator: '1' })
  })

  test('buckets by the requested interval and orders oldest first', async () => {
    const store = await storeWith([
      trade({ hash: 'A'.repeat(64), baseRaw: '1', quoteRaw: '10', settledAt: 3_600_000 }),
      trade({ hash: 'B'.repeat(64), baseRaw: '1', quoteRaw: '20', settledAt: 3_600_001 }),
      trade({ hash: 'C'.repeat(64), baseRaw: '1', quoteRaw: '30', settledAt: 7_200_001 }),
    ])
    const page = await history(store).history({ interval: '1h' })
    expect(page.points.map((point) => point.index)).toEqual([0, 1, 2])
    expect(page.candles.map((candle) => candle.at)).toEqual([3_600_000, 7_200_000])
    expect(page.candles[0]).toMatchObject({ trades: 2, every: 3_600_000 })
    expect(page.candles[0]?.close.display).toBe(20)
    expect(page.observed).toEqual({ from: 3_600_000, to: 7_200_001 })
    expect(page.time).toMatchObject({ basis: 'node-first-seen', timed: 3 })
  })

  test('pages across a boundary and resumes the cursor after a restart', async () => {
    const storage = jsonStorage()
    const store = await storeWith(
      [
        trade({ hash: 'A'.repeat(64), baseRaw: '1', quoteRaw: '10', settledAt: 100 }),
        trade({ hash: 'B'.repeat(64), baseRaw: '1', quoteRaw: '20', settledAt: 200 }),
        trade({ hash: 'C'.repeat(64), baseRaw: '1', quoteRaw: '30', settledAt: 300 }),
      ],
      storage,
    )
    const first = await history(store).history({ limit: 2 })
    expect(first.points.map((point) => point.quoteTotal.raw)).toEqual(['10', '20'])
    expect(first.pagination.complete).toBe(false)
    expect(first.pagination.cursor).not.toBeNull()

    // Nothing but the adapter's bytes crosses the restart.
    const reopened = createMarketStore({ storage: jsonStorage(storage.bytes()) })
    const second = await history(reopened).history({ limit: 2, cursor: first.pagination.cursor! })
    expect(second.points.map((point) => point.quoteTotal.raw)).toEqual(['30'])
    expect(second.pagination).toMatchObject({ complete: true, cursor: null })
    expect(second.coverage).toMatchObject({ scope: 'stored-observations', durability: 'durable' })
  })

  test('newest-first paging walks the same rows backwards', async () => {
    const store = await storeWith([
      trade({ hash: 'A'.repeat(64), baseRaw: '1', quoteRaw: '10', settledAt: 100 }),
      trade({ hash: 'B'.repeat(64), baseRaw: '1', quoteRaw: '20', settledAt: 200 }),
      trade({ hash: 'C'.repeat(64), baseRaw: '1', quoteRaw: '30', settledAt: 300 }),
    ])
    const api = history(store)
    const first = await api.trades({ order: 'newest', limit: 2 })
    expect(first.points.map((point) => point.quoteTotal.raw)).toEqual(['30', '20'])
    const second = await api.trades({ order: 'newest', limit: 2, cursor: first.pagination.cursor! })
    expect(second.points.map((point) => point.quoteTotal.raw)).toEqual(['10'])
  })

  test('a window selects on the advisory clock and keeps the request visible', async () => {
    const store = await storeWith([
      trade({ hash: 'A'.repeat(64), baseRaw: '1', quoteRaw: '10', settledAt: 100 }),
      trade({ hash: 'B'.repeat(64), baseRaw: '1', quoteRaw: '20', settledAt: 999_000 }),
    ])
    const page = await history(store).history({ window: '10s' })
    expect(page.requested).toEqual({ from: 990_000, to: 1_000_000 })
    expect(page.points.map((point) => point.quoteTotal.raw)).toEqual(['20'])
    expect(page.summary?.trades).toBe(1)
    expect(page.summary?.change).toMatchObject({ numerator: '0', denominator: '1' })
  })

  test('a cursor cannot cross into another pair, order, or window', async () => {
    const store = await storeWith([
      trade({ hash: 'A'.repeat(64), baseRaw: '1', quoteRaw: '10', settledAt: 100 }),
      trade({ hash: 'B'.repeat(64), baseRaw: '1', quoteRaw: '20', settledAt: 200 }),
    ])
    const api = history(store)
    const page = await api.trades({ limit: 1 })
    const cursor = page.pagination.cursor!
    await expect(api.trades({ limit: 1, order: 'newest', cursor })).rejects.toMatchObject({ code: 'bad-market-cursor' })
    await expect(api.trades({ limit: 1, from: 150, cursor })).rejects.toMatchObject({ code: 'bad-market-cursor' })
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('0') ? '1' : '0'}`
    await expect(api.trades({ limit: 1, cursor: tampered })).rejects.toMatchObject({ code: 'bad-market-cursor' })
  })

  test('an unnamed asset is refused rather than charted as a 64-hex id', async () => {
    const store = await storeWith([
      trade({ hash: 'A'.repeat(64), baseRaw: '1', quoteRaw: '10', settledAt: 100 }),
    ])
    const nameless = createStoredHistory({
      store,
      network: 'testnet',
      base: SWORD,
      quote: KEI,
      assets: (asset) => ({ asset, symbol: '', name: '', decimals: 0 }),
    })
    await expect(nameless.trades()).rejects.toMatchObject({ code: 'bad-asset-metadata' })
  })

  test('open and cancelled rows are not price history, and the pair is scoped', async () => {
    const storage = createMemoryMarketStorage()
    const store = createMarketStore({ storage })
    await store.materialize({
      offers: [
        trade({ hash: 'A'.repeat(64), baseRaw: '1', quoteRaw: '10', settledAt: 100 }),
        {
          ...trade({ hash: 'B'.repeat(64), baseRaw: '1', quoteRaw: '99', settledAt: 200 }),
          state: 'open',
          acceptedBy: null,
          settledBy: null,
          settledAt: null,
        },
      ],
      checkpoint: checkpoint(),
    })
    const page = await history(store).history()
    expect(page.points.map((point) => point.quoteTotal.raw)).toEqual(['10'])
    // Another pair's settlements belong to another chart.
    expect((await history(store, SWORD, GOLD).history()).points).toEqual([])
  })

  test('an invalid interval or range is refused before the store is read', async () => {
    let reads = 0
    const counted = {
      durability: 'memory' as const,
      async materialize() { throw new Error('unused') },
      async offers() { throw new Error('unused') },
      async trades() { reads += 1; throw new Error('touched') },
      async checkpoint() { return null },
      async quarantine() { return [] },
      async coverage() { throw new Error('unused') },
    }
    const api = createStoredHistory({ store: counted, network: 'testnet', base: SWORD, quote: KEI, assets })
    await expect(api.history({ interval: 'every fortnight' })).rejects.toMatchObject({ code: 'bad-duration' })
    await expect(api.history({ from: 500, window: '1h' })).rejects.toMatchObject({ code: 'bad-duration' })
    await expect(api.history({ from: 900, to: 100 })).rejects.toMatchObject({ code: 'bad-market-time' })
    expect(reads).toBe(0)
  })
})
