import { describe, expect, test } from 'bun:test'
import { addressFromPublicKey, KeiError } from '@keicoin/core'
import {
  createAccountChainIngestor,
  createMarketCatalog,
  createMarketStore,
  createMemoryMarketStorage,
  isMarketError,
  MARKET_STORAGE_SCHEMA_VERSION,
  type MarketMemoryStorageAdapter,
  type MarketStorageEnvelope,
  type StoredMarketOfferInput,
} from '@keicoin/market'

const ALICE = addressFromPublicKey('1'.repeat(64))
const BOB = addressFromPublicKey('2'.repeat(64))
const CAROL = addressFromPublicKey('3'.repeat(64))
const SWORD = 'A'.repeat(64)
const KEI = '0'.repeat(64)

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
    give: { asset: SWORD, raw: '900719925474099300000000000000000001' },
    want: { asset: KEI, raw: '180143985094819860000000000000000002' },
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

function checkpoint(account = ALICE) {
  return {
    network: 'testnet',
    source: 'node-a',
    account,
    adapterVersion: 1,
    generation: 1,
    observedAt: 20,
    newestHash: 'D'.repeat(64),
    providerCursor: null,
    exhausted: false,
    stopReason: 'unsupported_pagination' as const,
  }
}

describe('MarketCatalog', () => {
  test('survives a fresh SDK instance, keeps history, derives instruments, and pages without gaps', async () => {
    const storage = createMemoryMarketStorage()
    const first = createMarketCatalog({ storage })
    await first.announce(announcement(CAROL, '3', 30))
    await first.announce(announcement(ALICE, '1', 10))
    await first.announce(announcement(BOB, '2', 20))
    expect((await first.announce(announcement(ALICE, '1', 10))).inserted).toBe(false)
    await first.announce(announcement(ALICE, '4', 40))

    const restarted = createMarketCatalog({ storage })
    const one = await restarted.participants({ network: 'testnet', limit: 2 })
    expect(one.rows.map((row) => row.address)).toEqual([ALICE, BOB])
    expect(one.rows[0]).toMatchObject({ firstObservedAt: 10, lastObservedAt: 40, observationCount: 2 })
    expect(one.nextCursor).not.toBeNull()
    const two = await restarted.participants({ network: 'testnet', limit: 2, cursor: one.nextCursor! })
    expect(two.rows.map((row) => row.address)).toEqual([CAROL])
    expect(two.complete).toBe(true)

    const instruments = await restarted.instruments({ network: 'testnet' })
    expect(instruments.rows).toEqual([
      {
        network: 'testnet',
        base: SWORD,
        quote: KEI,
        participantCount: 3,
        firstObservedAt: 10,
        lastObservedAt: 40,
        sources: ['carpet'],
      },
    ])
    expect(JSON.parse(JSON.stringify(instruments))).toEqual(instruments)
  })

  test('revision-bound cursors fail closed after a write and bad budgets never touch storage', async () => {
    const storage = createMemoryMarketStorage()
    const catalog = createMarketCatalog({ storage })
    await catalog.announce(announcement(ALICE, '1', 1))
    await catalog.announce(announcement(BOB, '2', 2))
    const page = await catalog.participants({ limit: 1 })
    await catalog.announce(announcement(CAROL, '3', 3))
    await expect(catalog.participants({ limit: 1, cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'stale-market-cursor' })

    let loads = 0
    const hostile: MarketMemoryStorageAdapter = {
      capabilities: { durability: 'memory', scope: 'process-memory-reference', atomicCompareAndSwap: true, migrations: [1, MARKET_STORAGE_SCHEMA_VERSION] },
      async load() {
        loads += 1
        throw new Error('touched')
      },
      async compareAndSwap() {
        throw new Error('touched')
      },
    }
    const guarded = createMarketCatalog({ storage: hostile })
    await expect(guarded.participants({ limit: Number.POSITIVE_INFINITY })).rejects.toMatchObject({ code: 'bad-market-budget' })
    expect(loads).toBe(0)
  })

  test('cursor scope includes adapter revision and rejects stale use after clear+replay', async () => {
    const storage = createMemoryMarketStorage()
    const catalog = createMarketCatalog({ storage })
    await catalog.announce(announcement(ALICE, '1', 1))
    await catalog.announce(announcement(BOB, '2', 2))
    const page = await catalog.participants({ network: 'testnet', limit: 1 })
    storage.clear()
    await catalog.announce(announcement(CAROL, '3', 3))
    await expect(catalog.participants({ network: 'testnet', limit: 1, cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'bad-market-cursor' })
  })

  test('same observation id cannot silently rewrite immutable discovery facts', async () => {
    const catalog = createMarketCatalog({ storage: createMemoryMarketStorage() })
    await catalog.announce(announcement(ALICE, 'same', 1))
    await expect(catalog.announce(announcement(BOB, 'same', 2))).rejects.toMatchObject({ code: 'market-observation-conflict' })
    expect((await catalog.participants()).rows.map((row) => row.address)).toEqual([ALICE])
  })

  test('cursors are integrity-bound to the complete normalized filter', async () => {
    const catalog = createMarketCatalog({ storage: createMemoryMarketStorage() })
    await catalog.announce(announcement(ALICE, '1', 1))
    await catalog.announce(announcement(BOB, '2', 2))
    const page = await catalog.participants({ network: 'testnet', instrument: { base: SWORD, quote: KEI }, limit: 1 })
    const cursor = page.nextCursor!
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('0') ? '1' : '0'}`
    await expect(catalog.participants({ network: 'testnet', instrument: { base: SWORD, quote: KEI }, limit: 1, cursor: tampered })).rejects.toMatchObject({ code: 'bad-market-cursor' })
    await expect(catalog.participants({ network: 'mainnet', instrument: { base: SWORD, quote: KEI }, limit: 1, cursor })).rejects.toMatchObject({ code: 'bad-market-cursor' })
    await expect(catalog.participants({ network: 'testnet', instrument: { base: KEI, quote: SWORD }, limit: 1, cursor })).rejects.toMatchObject({ code: 'bad-market-cursor' })
  })

  test('catalog cursors remain valid across budget changes for the same logical filter', async () => {
    const catalog = createMarketCatalog({ storage: createMemoryMarketStorage() })
    await catalog.announce(announcement(ALICE, '1', 1))
    await catalog.announce(announcement(BOB, '2', 2))
    await catalog.announce(announcement(CAROL, '3', 3))
    const first = await catalog.participants({ network: 'testnet', instrument: { base: SWORD, quote: KEI }, limit: 1 })
    const second = await catalog.participants({
      network: 'testnet',
      instrument: { base: SWORD, quote: KEI },
      limit: 1,
      cursor: first.nextCursor!,
      maxResultBytes: 11_111,
    })
    expect(second.rows[0]?.address).toBe(BOB)
  })

  test('a maximum revision is rejected before commit and leaves the prior snapshot readable', async () => {
    const snapshot: MarketStorageEnvelope = {
      schema: 'kei-market-storage', version: MARKET_STORAGE_SCHEMA_VERSION,
      revision: Number.MAX_SAFE_INTEGER,
      catalogRevision: Number.MAX_SAFE_INTEGER,
      offerRevision: 0,
      cursorKey: 'a'.repeat(32),
      observations: [], offers: [], checkpoints: [], quarantine: [],
      retention: {
        foldedObservations: 0,
        droppedObservations: 0,
        droppedOffers: 0,
        droppedCheckpoints: 0,
        droppedQuarantine: 0,
      },
    }
    let commits = 0
    const storage: MarketMemoryStorageAdapter = {
      capabilities: { durability: 'memory', scope: 'process-memory-reference', atomicCompareAndSwap: true, migrations: [1, MARKET_STORAGE_SCHEMA_VERSION] },
      async load() { return snapshot },
      async compareAndSwap() { commits += 1; return true },
    }
    const catalog = createMarketCatalog({ storage })
    await expect(catalog.announce(announcement(ALICE, 'overflow', 1))).rejects.toMatchObject({ code: 'bad-market-storage' })
    expect(commits).toBe(0)
    expect((await catalog.participants()).rows).toEqual([])
  })
})

describe('MarketStore', () => {
  test('atomically commits exact rows and checkpoints, deduplicates retries, and quarantines immutable conflicts', async () => {
    const storage = createMemoryMarketStorage()
    const store = createMarketStore({ storage })
    const first = await store.materialize({ offers: [offer()], checkpoint: checkpoint() })
    expect(first).toMatchObject({ inserted: 1, unchanged: 0, conflicts: 0, quarantined: 0, durability: 'memory' })

    const retry = await store.materialize({ offers: [offer({ source: 'node-a', observedAt: 30 })], checkpoint: { ...checkpoint(), observedAt: 30 } })
    expect(retry).toMatchObject({ inserted: 0, unchanged: 1, conflicts: 0 })
    const conflicting = offer({ want: { asset: KEI, raw: '999' }, observedAt: 40 })
    const conflict = await store.materialize({ offers: [conflicting], checkpoint: { ...checkpoint(), observedAt: 40 } })
    expect(conflict).toMatchObject({ inserted: 0, unchanged: 0, conflicts: 1, quarantined: 1 })

    const restarted = createMarketStore({ storage })
    const rows = await restarted.offers({ network: 'testnet' })
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.give.raw).toBe('900719925474099300000000000000000001')
    expect(rows.rows[0]?.want.raw).toBe('180143985094819860000000000000000002')
    expect(rows.rows[0]?.provenance).toMatchObject({ firstObservedAt: 20, lastObservedAt: 30 })
    expect(rows.coverage).toEqual({
      scope: 'stored-observations',
      sourceBackfill: { complete: false, reason: 'unsupported_pagination' },
    })
    expect((await restarted.quarantine())[0]?.reason).toBe(`immutable-conflict:${'D'.repeat(64)}`)
    expect(await restarted.checkpoint({ network: 'testnet', source: 'node-a', account: ALICE, adapterVersion: 1 })).toMatchObject({ observedAt: 40, exhausted: false, stopReason: 'unsupported_pagination' })
  })

  test('a failed atomic commit leaves neither rows nor an advanced checkpoint', async () => {
    let persisted: MarketStorageEnvelope | null = null
    let refuse = true
    const reference: MarketMemoryStorageAdapter = {
      capabilities: { durability: 'memory', scope: 'process-memory-reference', atomicCompareAndSwap: true, migrations: [1, MARKET_STORAGE_SCHEMA_VERSION] },
      async load() {
        return persisted
      },
      async compareAndSwap(_revision, next) {
        if (refuse) throw new Error('simulated reference transaction refusal')
        persisted = next
        return true
      },
    }
    const store = createMarketStore({ storage: reference })
    await expect(store.materialize({ offers: [offer()], checkpoint: checkpoint() })).rejects.toThrow('simulated reference transaction refusal')
    expect(persisted).toBeNull()
    refuse = false
    expect((await store.materialize({ offers: [offer()], checkpoint: checkpoint() })).durability).toBe('memory')
    const restarted = createMarketStore({ storage: reference })
    expect((await restarted.offers({ network: 'testnet' })).rows).toHaveLength(1)
    expect(await restarted.checkpoint({ network: 'testnet', source: 'node-a', account: ALICE, adapterVersion: 1 })).not.toBeNull()
  })

  test('advances lifecycle monotonically and never regresses an overlapping checkpoint', async () => {
    const storage = createMemoryMarketStorage()
    const store = createMarketStore({ storage })
    await store.materialize({ offers: [offer()], checkpoint: checkpoint() })
    const accepted = offer({
      state: 'accepted',
      acceptedBy: BOB,
      settledBy: 'E'.repeat(64),
      settledAt: 25,
      observedAt: 50,
    })
    const advanced = await store.materialize({
      offers: [accepted],
      checkpoint: { ...checkpoint(), observedAt: 50, newestHash: accepted.hash },
    })
    expect(advanced.updated).toBe(1)

    // An older observation can merge provenance but cannot reopen the offer or
    // move the account watermark backward.
    await store.materialize({ offers: [offer({ observedAt: 30 })], checkpoint: { ...checkpoint(), observedAt: 30 } })
    expect((await store.offers({ network: 'testnet' })).rows[0]).toMatchObject({ state: 'accepted', acceptedBy: BOB, settledBy: 'E'.repeat(64) })
    expect(await store.checkpoint({ network: 'testnet', source: 'node-a', account: ALICE, adapterVersion: 1 })).toMatchObject({ observedAt: 50 })
  })

  test('invalid pages are rejected before storage and pre-aborted operations do no work', async () => {
    let loads = 0
    const driver: MarketMemoryStorageAdapter = {
      capabilities: { durability: 'memory', scope: 'process-memory-reference', atomicCompareAndSwap: true, migrations: [1, MARKET_STORAGE_SCHEMA_VERSION] },
      async load() {
        loads += 1
        return null
      },
      async compareAndSwap() {
        return true
      },
    }
    const store = createMarketStore({ storage: driver })
    await expect(store.materialize({ offers: [offer({ hash: 'short' })], checkpoint: checkpoint() })).rejects.toMatchObject({ code: 'bad-market-row' })
    expect(loads).toBe(0)
    const controller = new AbortController()
    controller.abort('gone')
    await expect(store.offers({ network: 'testnet', signal: controller.signal })).rejects.toMatchObject({ code: 'read-aborted' })
    expect(loads).toBe(0)
  })

  test('offer cursors fail closed on tamper and cross-filter reuse', async () => {
    const store = createMarketStore({ storage: createMemoryMarketStorage() })
    await store.materialize({
      offers: [offer(), offer({ hash: 'E'.repeat(64) })],
      checkpoint: checkpoint(),
    })
    const page = await store.offers({ network: 'testnet', state: 'open', limit: 1 })
    const cursor = page.nextCursor!
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('0') ? '1' : '0'}`
    await expect(store.offers({ network: 'testnet', state: 'open', limit: 1, cursor: tampered })).rejects.toMatchObject({ code: 'bad-market-cursor' })
    await expect(store.offers({ network: 'testnet', state: 'accepted', limit: 1, cursor })).rejects.toMatchObject({ code: 'bad-market-cursor' })
  })

  test('offer cursors are scoped to adapter revision to protect clear/replay reuse', async () => {
    const storage = createMemoryMarketStorage()
    const store = createMarketStore({ storage })
    await store.materialize({ offers: [offer()], checkpoint: checkpoint() })
    const first = await store.offers({ network: 'testnet', limit: 1 })
    storage.clear()
    await store.materialize({ offers: [offer({ hash: 'E'.repeat(64), observedAt: 30 })], checkpoint: checkpoint() })
    await expect(store.offers({ network: 'testnet', state: 'open', limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'bad-market-cursor' })
  })

  test('stored-offer cursors stay valid when only byte/account/page budgets change', async () => {
    const store = createMarketStore({ storage: createMemoryMarketStorage() })
    await store.materialize({ offers: [offer(), offer({ hash: 'E'.repeat(64) })], checkpoint: checkpoint() })
    const first = await store.offers({ network: 'testnet', state: 'open', limit: 1 })
    const second = await store.offers({
      network: 'testnet',
      state: 'open',
      limit: 1,
      cursor: first.nextCursor!,
      maxResultBytes: 200_000,
    })
    expect(second.rows[0]?.hash).toBe('E'.repeat(64))
  })

  test('quarantines provenance overfull offers as canonical provenance overflow', async () => {
    const storage = createMemoryMarketStorage()
    const store = createMarketStore({ storage })
    let inserted = 0
    let updated = 0
    let unchanged = 0
    let conflicts = 0
    let quarantinedRows = 0
    for (let index = 0; index < 33; index += 1) {
      const source = `node-${String(index).padStart(2, '0')}`
      const result = await store.materialize({
        offers: [offer({ hash: 'D'.repeat(64), source, observedAt: 20 + index })],
        checkpoint: { ...checkpoint(), source },
      })
      inserted += result.inserted
      updated += result.updated
      unchanged += result.unchanged
      conflicts += result.conflicts
      quarantinedRows += result.quarantined
    }
    expect({ inserted, updated, unchanged, conflicts, quarantinedRows }).toEqual({ inserted: 1, updated: 31, unchanged: 0, conflicts: 1, quarantinedRows: 1 })
    const quarantined = await store.quarantine()
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]?.reason).toBe(`provenance-overflow:${'D'.repeat(64)}`)
    const rows = await store.offers({ network: 'testnet', limit: 2 })
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.provenance.sources).toHaveLength(32)
  })

  test('checkpoint filters are isolated and equal-time generations cannot regress', async () => {
    const store = createMarketStore({ storage: createMemoryMarketStorage() })
    const instrument = { base: SWORD, quote: KEI }
    await store.materialize({ offers: [], checkpoint: { ...checkpoint(), instrument, observedAt: 50, generation: 2, newestHash: 'E'.repeat(64) } })
    await store.materialize({ offers: [], checkpoint: { ...checkpoint(), instrument, observedAt: 50, generation: 1, newestHash: 'D'.repeat(64) } })
    expect(await store.checkpoint({ network: 'testnet', source: 'node-a', account: ALICE, adapterVersion: 1, instrument })).toMatchObject({ generation: 2, newestHash: 'E'.repeat(64) })
    expect(await store.checkpoint({ network: 'testnet', source: 'node-a', account: ALICE, adapterVersion: 1 })).toBeNull()

    const reverse = createMarketStore({ storage: createMemoryMarketStorage() })
    await reverse.materialize({ offers: [], checkpoint: { ...checkpoint(), observedAt: 50, generation: 3, newestHash: 'E'.repeat(64) } })
    await reverse.materialize({ offers: [], checkpoint: { ...checkpoint(), observedAt: 50, generation: 3, newestHash: 'D'.repeat(64) } })
    expect(await reverse.checkpoint({ network: 'testnet', source: 'node-a', account: ALICE, adapterVersion: 1 })).toMatchObject({ generation: 3, newestHash: 'E'.repeat(64) })
  })

  test('materialization CAS fails fast when it exceeds deadline', async () => {
    let persisted: MarketStorageEnvelope | null = null
    let nowMs = 0
    let compareAndSwapRuns = 0
    const slowStorage: MarketMemoryStorageAdapter = {
      capabilities: { durability: 'memory', scope: 'process-memory-reference', atomicCompareAndSwap: true, migrations: [1, MARKET_STORAGE_SCHEMA_VERSION] },
      async load() {
        return persisted
      },
      async compareAndSwap(_revision, next) {
        compareAndSwapRuns += 1
        await new Promise((resolve) => setTimeout(resolve, 100))
        persisted = next
        return true
      },
    }
    const store = createMarketStore({ storage: slowStorage, now: () => (nowMs += 1) })
    await expect(store.materialize({ offers: [offer()], checkpoint: checkpoint(), deadlineMs: 20 })).rejects.toMatchObject({ code: 'market-deadline' })
    expect(compareAndSwapRuns).toBe(1)
  })
})

describe('account-chain source', () => {
  test('reports scan budget capability once enabled', async () => {
    const storage = createMemoryMarketStorage()
    const catalog = createMarketCatalog({ storage })
    const ingestor = createAccountChainIngestor({
      id: 'node-a',
      provider: { network: 'testnet', async accountSwaps() { return [] } },
      catalog,
      store: createMarketStore({ storage }),
      now: () => 100,
    })
    expect(ingestor.capabilities).toMatchObject({ scannedBlockBudget: true })
  })
  test('materializes a provider window across restart but never calls it complete history', async () => {
    const storage = createMemoryMarketStorage()
    const catalog = createMarketCatalog({ storage })
    const store = createMarketStore({ storage })
    await catalog.announce(announcement(ALICE, 'alice', 1))
    await catalog.announce(announcement(BOB, 'bob', 2))
    const calls: string[] = []
    const provider = {
      network: 'testnet',
      async accountSwaps(account: string) {
        calls.push(account)
        return account === ALICE
          ? [{
              hash: 'D'.repeat(64),
              from: ALICE,
              asset: SWORD,
              amount: '900719925474099300000000000000000001',
              wantAsset: KEI,
              wantAmount: '2',
              counterparty: null,
              state: 'open',
              acceptedBy: null,
              settledBy: null,
              height: 1,
              seenAt: 5,
              settledAt: null,
            }]
          : []
      },
    }
    const source = createAccountChainIngestor({ id: 'node-a', provider, catalog, store, now: () => 100 })
    const result = await source.ingest({ instrument: { base: SWORD, quote: KEI } })
    expect(calls).toEqual([ALICE, BOB])
    expect(result).toMatchObject({
      status: 'partial',
      stopReason: 'unsupported_pagination',
      cursor: null,
      consumed: { accounts: 2, requests: 2, pages: 1, resultRows: 1 },
      stored: { inserted: 1 },
      sourceBackfill: { supported: false, complete: false, reason: 'unsupported_pagination', scannedBlocks: 'unsupported' },
    })
    const restarted = createMarketStore({ storage })
    expect((await restarted.offers({ network: 'testnet' })).rows[0]?.give.raw).toBe('900719925474099300000000000000000001')
    expect(await restarted.checkpoint({ network: 'testnet', source: 'node-a', account: BOB, adapterVersion: 1, instrument: { base: SWORD, quote: KEI } })).toMatchObject({ newestHash: null, exhausted: false })
  })

  test('enforces total account/request budgets and reports a resumable catalog cursor', async () => {
    const storage = createMemoryMarketStorage()
    const catalog = createMarketCatalog({ storage })
    const store = createMarketStore({ storage })
    for (const [index, address] of [ALICE, BOB, CAROL].entries()) await catalog.announce(announcement(address, String(index), index))
    let calls = 0
    const source = createAccountChainIngestor({
      id: 'node-a',
      provider: { network: 'testnet', async accountSwaps() { calls += 1; return [] } },
      catalog,
      store,
      now: () => 100,
    })
    const first = await source.ingest({ budget: { maxAccounts: 1, maxRequests: 1 } })
    expect(first.stopReason).toBe('account_limit')
    expect(first.cursor).not.toBeNull()
    expect(calls).toBe(1)
    const second = await source.ingest({ cursor: first.cursor!, budget: { maxAccounts: 1, maxRequests: 1 } })
    expect(second.cursor).not.toBeNull()
    const third = await source.ingest({ cursor: second.cursor!, budget: { maxAccounts: 1, maxRequests: 1 } })
    expect(third.cursor).toBeNull()
    expect(calls).toBe(3)
  })

  test('result-row budget stop does not request extra catalog pages after exact consumption', async () => {
    const storage = createMemoryMarketStorage()
    const catalog = createMarketCatalog({ storage })
    await catalog.announce(announcement(ALICE, '1', 1))
    await catalog.announce(announcement(BOB, '2', 2))
    await catalog.announce(announcement(CAROL, '3', 3))

    let catalogCalls = 0
    let providerCalls = 0
    const realCatalog = catalog
    const source = createAccountChainIngestor({
      id: 'node-a',
      provider: {
        network: 'testnet',
        async accountSwaps(address) {
          providerCalls += 1
          return [{
            hash: 'D'.repeat(64),
            from: address,
            asset: SWORD,
            amount: '1',
            wantAsset: KEI,
            wantAmount: '2',
            counterparty: null,
            state: 'open',
            acceptedBy: null,
            settledBy: null,
            height: 1,
            seenAt: 1,
            settledAt: null,
          }]
        },
      },
      catalog: {
        durability: realCatalog.durability,
        async announce(input) { return realCatalog.announce(input) },
        async instruments() { throw new Error('unused') },
        async participants(input) {
          catalogCalls += 1
          return realCatalog.participants(input)
        },
      },
      store: createMarketStore({ storage }),
      now: () => 100,
    })
    const result = await source.ingest({
      budget: { maxResultRows: 1 },
    })
    expect(result.stopReason).toBe('result_limit')
    expect(result.consumed.resultRows).toBe(1)
    expect({ catalogCalls, providerCalls }).toEqual({ catalogCalls: 1, providerCalls: 1 })
  })

  test('enforces scanned block budget and returns measured scanned count', async () => {
    const storage = createMemoryMarketStorage()
    const catalog = createMarketCatalog({ storage })
    await catalog.announce(announcement(ALICE, '1', 1))

    const source = createAccountChainIngestor({
      id: 'node-a',
      provider: {
        network: 'testnet',
        async accountSwaps() {
          return [
            {
              hash: 'A'.repeat(64),
              from: ALICE,
              asset: SWORD,
              amount: '1',
              wantAsset: KEI,
              wantAmount: '2',
              counterparty: null,
              state: 'open',
              acceptedBy: null,
              settledBy: null,
              height: 1,
              seenAt: 1,
              settledAt: null,
            },
            {
              hash: 'B'.repeat(64),
              from: ALICE,
              asset: SWORD,
              amount: '2',
              wantAsset: KEI,
              wantAmount: '3',
              counterparty: null,
              state: 'open',
              acceptedBy: null,
              settledBy: null,
              height: 2,
              seenAt: 2,
              settledAt: null,
            },
          ]
        },
      },
      catalog,
      store: createMarketStore({ storage }),
      now: () => 100,
    })
    const result = await source.ingest({ budget: { maxScannedBlocks: 2, maxResultRows: 10 } })
    expect(result).toMatchObject({
      stopReason: 'scan_limit',
      consumed: { resultRows: 2 },
      sourceBackfill: { scannedBlocks: 2 },
    })
    expect(result.consumed.accounts).toBe(1)
    expect(result.consumed.requests).toBe(1)
    expect(result.consumed.pages).toBe(1)
  })

  test('bad budgets and pre-abort stop before catalog or provider work', async () => {
    let catalogReads = 0
    let providerReads = 0
    const source = createAccountChainIngestor({
      id: 'node-a',
      provider: { network: 'testnet', async accountSwaps() { providerReads += 1; return [] } },
      catalog: { durability: 'memory', async announce() { throw new Error('unused') }, async participants() { catalogReads += 1; throw new Error('touched') }, async instruments() { throw new Error('unused') } },
      store: { durability: 'memory', async materialize() { throw new Error('touched') }, async offers() { throw new Error('unused') }, async trades() { throw new Error('unused') }, async checkpoint() { return null }, async quarantine() { return [] }, async coverage() { throw new Error('unused') } },
    })
    await expect(source.ingest({ budget: { maxRequests: Number.NaN } })).rejects.toMatchObject({ code: 'bad-market-budget' })
    const controller = new AbortController()
    controller.abort()
    await expect(source.ingest({ signal: controller.signal })).rejects.toMatchObject({ code: 'read-aborted' })
    expect({ catalogReads, providerReads }).toEqual({ catalogReads: 0, providerReads: 0 })
  })

  test('quarantines malformed provider rows without letting them reach stored arithmetic', async () => {
    const storage = createMemoryMarketStorage()
    const catalog = createMarketCatalog({ storage })
    const store = createMarketStore({ storage })
    await catalog.announce(announcement(ALICE, 'alice', 1))
    const source = createAccountChainIngestor({
      id: 'node-a',
      provider: {
        network: 'testnet',
        async accountSwaps() {
          return [{
            hash: 'not-a-hash',
            from: ALICE,
            asset: SWORD,
            amount: '9'.repeat(10_000),
            wantAsset: KEI,
            wantAmount: '1',
            counterparty: null,
            state: 'open',
            acceptedBy: null,
            settledBy: null,
            height: 1,
            seenAt: 1,
            settledAt: null,
          }]
        },
      },
      catalog,
      store,
      now: () => 100,
    })
    const result = await source.ingest()
    expect(result).toMatchObject({ quarantined: 1, consumed: { resultRows: 1 }, stored: { inserted: 0 } })
    expect((await store.offers({ network: 'testnet' })).rows).toEqual([])
    expect((await store.quarantine())[0]?.reason).toContain('offer hash')
  })

  test('filters off-instrument provider rows instead of failing materialization', async () => {
    const storage = createMemoryMarketStorage()
    const catalog = createMarketCatalog({ storage })
    const store = createMarketStore({ storage })
    await catalog.announce(announcement(ALICE, 'alice', 1))
    const source = createAccountChainIngestor({
      id: 'node-a',
      provider: {
        network: 'testnet',
        async accountSwaps() {
          return [{
            hash: 'D'.repeat(64),
            from: ALICE,
            asset: KEI,
            amount: '1',
            wantAsset: SWORD,
            wantAmount: '2',
            counterparty: null,
            state: 'open',
            acceptedBy: null,
            settledBy: null,
            height: 1,
            seenAt: 1,
            settledAt: null,
          }]
        },
      },
      catalog,
      store,
      now: () => 100,
    })
    const result = await source.ingest({ instrument: { base: SWORD, quote: KEI } })
    expect(result).toMatchObject({ quarantined: 1, stored: { inserted: 0 } })
    expect(await store.quarantine()).toHaveLength(1)
    expect((await store.quarantine())[0]?.reason).toContain('instrument')
  })

  test('rejects inherited and accessor-backed provider rows without executing getters', async () => {
    const storage = createMemoryMarketStorage()
    const catalog = createMarketCatalog({ storage })
    const store = createMarketStore({ storage })
    await catalog.announce(announcement(ALICE, 'alice-hostile', 1))
    let getterReads = 0
    const inherited = Object.create({
      hash: 'D'.repeat(64), from: ALICE, asset: SWORD, amount: '1', wantAsset: KEI, wantAmount: '2',
      counterparty: null, state: 'open', acceptedBy: null, settledBy: null, height: 1, seenAt: 1, settledAt: null,
    })
    const accessor = {
      from: ALICE, asset: SWORD, amount: '1', wantAsset: KEI, wantAmount: '2', counterparty: null,
      state: 'open', acceptedBy: null, settledBy: null, height: 1, seenAt: 1, settledAt: null,
    }
    Object.defineProperty(accessor, 'hash', { enumerable: true, get() { getterReads += 1; return 'E'.repeat(64) } })
    const ingestor = createAccountChainIngestor({
      id: 'node-a',
      provider: { network: 'testnet', async accountSwaps() { return [inherited, accessor] } },
      catalog,
      store,
      now: () => 100,
    })
    const result = await ingestor.ingest()
    expect(result).toMatchObject({ quarantined: 2, stored: { inserted: 0 } })
    expect(getterReads).toBe(0)
  })
})

test('new errors remain recognizable through isMarketError', () => {
  const error = new KeiError('bad-market-budget', 'bad')
  expect(isMarketError(error, 'bad-market-budget')).toBe(true)
})

