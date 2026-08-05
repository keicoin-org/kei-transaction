/**
 * The two promises a market store has to keep: what a restart still knows, and
 * what an unbounded discovery feed cannot make it retain forever.
 *
 * Restart is simulated the way it actually happens — the process is gone, and
 * only the bytes the adapter wrote are still there. `restart()` below rebuilds a
 * fresh adapter from a JSON string, so nothing in-process can carry a page
 * cursor, a checkpoint, or a signing secret across the boundary for free.
 */

import { describe, expect, test } from 'bun:test'
import { addressFromPublicKey } from '@keicoin/core'
import {
  createAccountChainIngestor,
  createMarketCatalog,
  createMarketStore,
  createMemoryMarketStorage,
  MARKET_STORAGE_SCHEMA_VERSION,
  type MarketStorageAdapter,
  type MarketStorageCapabilities,
  type MarketStorageEnvelope,
  type StoredMarketOfferInput,
} from '@keicoin/market'

const ALICE = addressFromPublicKey('1'.repeat(64))
const BOB = addressFromPublicKey('2'.repeat(64))
const CAROL = addressFromPublicKey('3'.repeat(64))
const SWORD = 'A'.repeat(64)
const KEI = '0'.repeat(64)

const DURABLE: MarketStorageCapabilities = {
  durability: 'durable',
  scope: 'json-text:kei-market-test',
  atomicCompareAndSwap: true,
  migrations: [1, MARKET_STORAGE_SCHEMA_VERSION],
}

/**
 * A durable adapter whose whole state is one JSON string, which is the only
 * thing a restart is allowed to inherit.
 */
function jsonStorage(initial: string | null = null) {
  let bytes = initial
  const adapter: MarketStorageAdapter & { bytes(): string | null } = {
    capabilities: DURABLE,
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

function announcement(address: string, id: string, at: number) {
  return {
    network: 'testnet',
    address,
    source: 'carpet',
    observedAt: at,
    observationId: id,
    instrument: { base: SWORD, quote: KEI },
  } as const
}

function offer(overrides: Partial<StoredMarketOfferInput> = {}): StoredMarketOfferInput {
  return {
    network: 'testnet',
    hash: 'D'.repeat(64),
    author: ALICE,
    give: { asset: SWORD, raw: '9007199254740992' },
    want: { asset: KEI, raw: '9007199254740993' },
    counterparty: null,
    state: 'open',
    acceptedBy: null,
    settledBy: null,
    height: 7,
    seenAt: 10,
    settledAt: null,
    source: 'node-a',
    observedAt: 20,
    ...overrides,
  }
}

function settled(hash: string, at: number, observedAt: number): StoredMarketOfferInput {
  return offer({
    hash,
    state: 'accepted',
    acceptedBy: BOB,
    settledBy: 'E'.repeat(63) + hash[0],
    settledAt: at,
    observedAt,
  })
}

function checkpoint(account = ALICE, observedAt = 20) {
  return {
    network: 'testnet',
    source: 'node-a',
    account,
    adapterVersion: 1,
    generation: 1,
    observedAt,
    newestHash: null,
    providerCursor: null,
    exhausted: false,
    stopReason: 'unsupported_pagination' as const,
  }
}

describe('durable market storage', () => {
  test('a restart reopens the same rows, checkpoints, and page cursors', async () => {
    const first = jsonStorage()
    const catalog = createMarketCatalog({ storage: first })
    const store = createMarketStore({ storage: first })
    for (const [index, address] of [ALICE, BOB, CAROL].entries()) {
      const receipt = await catalog.announce(announcement(address, `obs-${index}`, 10 + index))
      expect(receipt).toMatchObject({ inserted: true, durability: 'durable' })
    }
    await store.materialize({ offers: [offer()], checkpoint: checkpoint() })
    const before = await catalog.participants({ network: 'testnet', limit: 2 })
    expect(before.rows.map((row) => row.address)).toEqual([ALICE, BOB])
    expect(before.nextCursor).not.toBeNull()

    // Nothing but the bytes crosses the restart: new adapter, new catalog, new
    // store, and a cursor the previous process handed out.
    const restarted = jsonStorage(first.bytes())
    const resumed = createMarketCatalog({ storage: restarted })
    const page = await resumed.participants({ network: 'testnet', limit: 2, cursor: before.nextCursor! })
    expect(page.rows.map((row) => row.address)).toEqual([CAROL])
    expect(page.complete).toBe(true)

    const resumedStore = createMarketStore({ storage: restarted })
    expect((await resumedStore.offers({ network: 'testnet' })).rows[0]?.give.raw).toBe('9007199254740992')
    expect(await resumedStore.checkpoint({ network: 'testnet', source: 'node-a', account: ALICE, adapterVersion: 1 }))
      .toMatchObject({ observedAt: 20, exhausted: false, stopReason: 'unsupported_pagination' })
    expect((await resumedStore.coverage()).durability).toBe('durable')
  })

  test('exact raw quantities survive the JSON round trip that a restart is', async () => {
    const storage = jsonStorage()
    const store = createMarketStore({ storage })
    await store.materialize({ offers: [offer()], checkpoint: checkpoint() })
    const restarted = createMarketStore({ storage: jsonStorage(storage.bytes()) })
    const [row] = (await restarted.offers({ network: 'testnet' })).rows
    // 9007199254740993 is the first integer a double cannot hold, and the pair
    // is the #102 reproduction: neither leg may arrive rounded to its neighbour.
    expect(row?.give.raw).toBe('9007199254740992')
    expect(row?.want.raw).toBe('9007199254740993')
    expect(BigInt(row!.want.raw) - BigInt(row!.give.raw)).toBe(1n)
  })

  test('a durable claim the adapter cannot read back is refused, not reported', async () => {
    let committed = 0
    const forgetful: MarketStorageAdapter = {
      capabilities: DURABLE,
      async load() {
        return null
      },
      async compareAndSwap() {
        committed += 1
        return true
      },
    }
    const catalog = createMarketCatalog({ storage: forgetful })
    await expect(catalog.announce(announcement(ALICE, 'obs', 1))).rejects.toMatchObject({
      code: 'market-durability-unconfirmed',
    })
    expect(committed).toBe(1)
  })

  test('an adapter that does not accept this schema version cannot be opened', async () => {
    const older: MarketStorageAdapter = {
      capabilities: { ...DURABLE, migrations: [1] },
      async load() {
        return null
      },
      async compareAndSwap() {
        return true
      },
    }
    await expect(createMarketStore({ storage: older }).coverage()).rejects.toMatchObject({ code: 'bad-market-storage' })
  })

  test('a version 1 envelope reads through and is replaced whole by the next commit', async () => {
    const legacy = {
      schema: 'kei-market-storage',
      version: 1,
      revision: 4,
      catalogRevision: 4,
      offerRevision: 0,
      observations: [
        { network: 'testnet', address: ALICE, source: 'carpet', observedAt: 10, observationId: 'obs-0', base: SWORD, quote: KEI },
      ],
      offers: [],
      checkpoints: [],
      quarantine: [],
    }
    const storage = jsonStorage(JSON.stringify(legacy))
    const catalog = createMarketCatalog({ storage })
    const migrated = await catalog.participants({ network: 'testnet' })
    expect(migrated.rows[0]).toMatchObject({
      address: ALICE,
      firstObservedAt: 10,
      lastObservedAt: 10,
      observationCount: 1,
      compactedObservations: 0,
    })

    await catalog.announce(announcement(BOB, 'obs-1', 20))
    const stored = JSON.parse(storage.bytes()!) as MarketStorageEnvelope
    expect(stored.version).toBe(MARKET_STORAGE_SCHEMA_VERSION)
    expect(stored.revision).toBe(5)
    expect(stored.observations).toHaveLength(2)
    expect(stored.retention.foldedObservations).toBe(0)
    expect((await catalog.participants({ network: 'testnet' })).rows).toHaveLength(2)
  })
})

describe('market store retention', () => {
  test('folding bounds the discovery table without losing a participant or its times', async () => {
    const storage = jsonStorage()
    const catalog = createMarketCatalog({ storage, retention: { maxObservations: 4 } })
    // Three participants announced repeatedly by one source: 12 announcements,
    // three surviving rows, and no roster entry may go missing.
    for (let round = 0; round < 4; round += 1) {
      for (const [index, address] of [ALICE, BOB, CAROL].entries()) {
        await catalog.announce(announcement(address, `obs-${round}-${index}`, 100 + round * 10 + index))
      }
    }
    const stored = JSON.parse(storage.bytes()!) as MarketStorageEnvelope
    expect(stored.observations.length).toBeLessThanOrEqual(4)
    expect(stored.retention.foldedObservations).toBeGreaterThan(0)
    expect(stored.retention.droppedObservations).toBe(0)

    const page = await catalog.participants({ network: 'testnet' })
    expect(page.rows.map((row) => row.address)).toEqual([ALICE, BOB, CAROL])
    expect(page.rows[0]).toMatchObject({
      firstObservedAt: 100,
      lastObservedAt: 130,
      observationCount: 4,
      compactedObservations: 4,
      sources: ['carpet'],
      instruments: [{ base: SWORD, quote: KEI }],
    })
    expect(page.retention.foldedObservations).toBe(stored.retention.foldedObservations)
    // The pair a folded participant traded is still discoverable by instrument.
    expect((await catalog.instruments({ network: 'testnet' })).rows[0]).toMatchObject({
      base: SWORD,
      quote: KEI,
      participantCount: 3,
      firstObservedAt: 100,
      lastObservedAt: 132,
    })
    expect((await catalog.participants({ network: 'testnet', instrument: { base: SWORD, quote: KEI } })).rows).toHaveLength(3)
  })

  test('folded rows are evicted oldest first once folding cannot reach the bound', async () => {
    const storage = jsonStorage()
    const catalog = createMarketCatalog({ storage, retention: { maxObservations: 2 } })
    for (const [index, address] of [ALICE, BOB, CAROL].entries()) {
      await catalog.announce(announcement(address, `obs-${index}`, 10 + index))
    }
    const stored = JSON.parse(storage.bytes()!) as MarketStorageEnvelope
    expect(stored.observations).toHaveLength(2)
    expect(stored.retention.droppedObservations).toBe(1)
    const page = await catalog.participants({ network: 'testnet' })
    // The oldest announcement went, and the page says so rather than implying
    // the roster was always these two.
    expect(page.rows.map((row) => row.address)).toEqual([BOB, CAROL])
    expect(page.retention.droppedObservations).toBe(1)
  })

  test('settled offers compact before open ones, and the table stays bounded', async () => {
    const storage = jsonStorage()
    const store = createMarketStore({ storage, retention: { maxOffers: 2 } })
    await store.materialize({
      offers: [settled('A'.repeat(64), 30, 30), settled('B'.repeat(64), 40, 40), offer({ hash: 'C'.repeat(64) })],
      checkpoint: checkpoint(),
    })
    const page = await store.offers({ network: 'testnet' })
    expect(page.rows.map((row) => row.hash)).toEqual(['B'.repeat(64), 'C'.repeat(64)])
    expect(page.retention.droppedOffers).toBe(1)
    const coverage = await store.coverage({ network: 'testnet' })
    expect(coverage).toMatchObject({
      scope: 'stored-observations',
      storageScope: 'json-text:kei-market-test',
      offers: { total: 2, open: 1, settled: 1 },
      sourceBackfill: { complete: false, reason: 'unsupported_pagination' },
    })
    expect(coverage.retention).toMatchObject({ maxOffers: 2, droppedOffers: 1 })
  })

  test('checkpoints and quarantine rows are bounded by the same commit', async () => {
    const storage = jsonStorage()
    const store = createMarketStore({ storage, retention: { maxCheckpoints: 1, maxQuarantine: 1 } })
    await store.materialize({
      offers: [],
      checkpoint: checkpoint(ALICE, 20),
      rejected: [{ network: 'testnet', source: 'node-a', account: ALICE, observedAt: 20, reason: 'first' }],
    })
    await store.materialize({
      offers: [],
      checkpoint: checkpoint(BOB, 40),
      rejected: [{ network: 'testnet', source: 'node-a', account: BOB, observedAt: 40, reason: 'second' }],
    })
    expect(await store.checkpoint({ network: 'testnet', source: 'node-a', account: ALICE, adapterVersion: 1 })).toBeNull()
    expect(await store.checkpoint({ network: 'testnet', source: 'node-a', account: BOB, adapterVersion: 1 }))
      .toMatchObject({ observedAt: 40 })
    const quarantined = await store.quarantine()
    expect(quarantined.map((row) => row.reason)).toEqual(['second'])
    const coverage = await store.coverage()
    expect(coverage.retention).toMatchObject({ droppedCheckpoints: 1, droppedQuarantine: 1 })
  })

  test('an invalid retention bound is refused before any adapter call', async () => {
    let loads = 0
    const counted: MarketStorageAdapter = {
      capabilities: DURABLE,
      async load() {
        loads += 1
        return null
      },
      async compareAndSwap() {
        return true
      },
    }
    expect(() => createMarketStore({ storage: counted, retention: { maxOffers: 0 } })).toThrow(/retention maxOffers/)
    expect(() => createMarketCatalog({ storage: counted, retention: { maxObservations: 1.5 } })).toThrow(/retention maxObservations/)
    expect(loads).toBe(0)
  })

  test('an ingestor reports the durability its store proved, and resumes after a restart', async () => {
    const storage = jsonStorage()
    const catalog = createMarketCatalog({ storage })
    const store = createMarketStore({ storage })
    for (const [index, address] of [ALICE, BOB, CAROL].entries()) {
      await catalog.announce(announcement(address, `obs-${index}`, 10 + index))
    }
    const provider = { network: 'testnet', async accountSwaps() { return [] } }
    const source = createAccountChainIngestor({ id: 'node-a', provider, catalog, store, now: () => 100 })
    expect(source.capabilities.storage).toBe('durable')
    const first = await source.ingest({ budget: { maxAccounts: 1, maxRequests: 1 } })
    expect(first.stopReason).toBe('account_limit')
    expect(first.cursor).not.toBeNull()

    // The catalog cursor is stored-key signed, so the next process can finish
    // the roster the previous one started.
    const reopened = jsonStorage(storage.bytes())
    const resumed = createAccountChainIngestor({
      id: 'node-a',
      provider,
      catalog: createMarketCatalog({ storage: reopened }),
      store: createMarketStore({ storage: reopened }),
      now: () => 200,
    })
    const second = await resumed.ingest({ cursor: first.cursor!, budget: { maxAccounts: 2, maxRequests: 2 } })
    expect(second.cursor).toBeNull()
    expect(second.consumed.accounts).toBe(2)
    expect(second.sourceBackfill).toMatchObject({ complete: false, reason: 'unsupported_pagination' })
  })

  test('a memory store keeps saying memory, and a compacted store never says complete history', async () => {
    const storage = createMemoryMarketStorage()
    const store = createMarketStore({ storage, retention: { maxOffers: 1 } })
    await store.materialize({ offers: [settled('A'.repeat(64), 30, 30), offer({ hash: 'C'.repeat(64) })], checkpoint: checkpoint() })
    const coverage = await store.coverage()
    expect(coverage).toMatchObject({
      durability: 'memory',
      storageScope: 'process-memory-reference',
      offers: { total: 1, open: 1, settled: 0 },
      sourceBackfill: { complete: false, reason: 'unsupported_pagination' },
    })
    expect(coverage.retention.droppedOffers).toBe(1)
  })
})
