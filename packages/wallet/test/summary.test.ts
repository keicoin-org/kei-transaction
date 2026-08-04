/**
 * Issue #35 — `wallet.summary()` must not cost one round trip per held asset.
 *
 * Everything here is driven by promises the test settles by hand rather than by
 * timers, so "how many requests were in flight at once" and "how many waves did
 * a hundred lookups take" are counted exactly instead of inferred from a clock.
 * There is no wall-clock threshold anywhere in this file: a slow machine makes
 * these tests slower, never redder.
 *
 * The wave counts at the bottom are the performance evidence. `serial` is what
 * the code did before this change (one wave per asset); `waves` is what it does
 * now, and it is a function of the concurrency bound rather than of N.
 */

import { describe, expect, test } from 'bun:test'
import type { AccountInfo, AssetId, AssetInfo, Holding, KeiClient } from '@keicoin/core'
import { KeiError } from '@keicoin/core'
import {
  DEFAULT_ASSET_CACHE_LIMIT,
  DEFAULT_ASSET_CONCURRENCY,
  MAX_ASSET_CACHE_LIMIT,
  MAX_ASSET_CONCURRENCY,
  createWallet,
  WalletPanel,
  type WalletApi,
  type WalletOptions,
  type WalletSummary,
} from '../src/index.js'
import type { WalletPanelKei } from '../src/panel.js'
import { makeDom } from './support.js'

const ADDRESS = 'kei_1testtesttesttesttesttesttesttesttesttesttesttesttesttesttest'

/**
 * Hands the turn back to the runtime so every microtask queued by settling a
 * lookup has run. A turn boundary, not a delay — the timeout is zero and
 * nothing is being waited *for*.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

interface AssetSpec {
  id: AssetId
  kind: 'token' | 'item'
  decimals?: number
}

function infoFor(spec: AssetSpec): AssetInfo {
  return {
    id: spec.id,
    issuer: 'kei_issuer',
    name: `Name ${spec.id}`,
    symbol: spec.id,
    decimals: spec.decimals ?? (spec.kind === 'item' ? 0 : 2),
    maxSupply: null,
    transfer: 'open',
    swap: 'two-way',
    kind: spec.kind,
    circulating: '1000',
  }
}

/** `A00`, `A01`, … — fixed width, so string order and numeric order agree. */
function ids(count: number, prefix = 'A'): AssetId[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`)
}

/**
 * A node whose `assetInfo` never settles until the test says so, and which
 * counts how many of those calls were outstanding at the same moment.
 */
class TestNode {
  /** Every `assetInfo` argument, in call order. Length is the RPC count. */
  readonly assetCalls: AssetId[] = []
  /** The most `assetInfo` calls outstanding at any single moment. */
  peakInFlight = 0
  accountCalls = 0
  holdingsCalls = 0

  balance = '0'
  holdings: Holding[] = []
  /** Assets the node claims not to know about; `assetInfo` answers `null`. */
  unknown = new Set<AssetId>()
  /** Assets whose lookup rejects. */
  broken = new Set<AssetId>()
  /** Wrong ids returned by a stale or misbehaving node, keyed by the requested id. */
  returnedIds = new Map<AssetId, AssetId>()
  kinds = new Map<AssetId, 'token' | 'item'>()

  private pending: Array<{ asset: AssetId; done: () => void; resolve: (v: AssetInfo | null) => void; reject: (e: unknown) => void }> = []
  private inFlight = 0

  async accountInfo(): Promise<AccountInfo | null> {
    this.accountCalls++
    return {
      address: ADDRESS,
      frontier: '0'.repeat(64),
      height: 1,
      balance: this.balance,
      representative: ADDRESS,
      receivableCount: 0,
      issuedCount: 0,
    }
  }

  async holdingsOf(): Promise<Holding[]> {
    this.holdingsCalls++
    return [...this.holdings]
  }

  assetInfo(asset: AssetId): Promise<AssetInfo | null> {
    this.assetCalls.push(asset)
    this.inFlight++
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight)
    return new Promise<AssetInfo | null>((resolve, reject) => {
      this.pending.push({
        asset,
        done: () => {
          this.inFlight--
        },
        resolve,
        reject,
      })
    })
  }

  /** How many lookups are waiting to be answered right now. */
  get outstanding(): number {
    return this.pending.length
  }

  /** Answers every outstanding lookup, and reports how many that was. */
  settleAll(): number {
    const batch = this.pending
    this.pending = []
    for (const call of batch) {
      call.done()
      if (this.broken.has(call.asset)) call.reject(new KeiError('node-unreachable', 'the node did not answer'))
      else if (this.unknown.has(call.asset)) call.resolve(null)
      else {
        call.resolve(
          infoFor({
            id: this.returnedIds.get(call.asset) ?? call.asset,
            kind: this.kinds.get(call.asset) ?? 'token',
          }),
        )
      }
    }
    return batch.length
  }

  setHoldings(assets: readonly AssetId[], balance = '1'): void {
    this.holdings = assets.map((asset) => ({ asset, balance }))
  }
}

interface Harness {
  wallet: WalletApi
  node: TestNode
  /** Fires one client `update`, exactly as `KeiClient` does after a block. */
  update(): void
  /** How many `update` listeners the wallet currently holds on the client. */
  get clientListeners(): number
}

function harness(options: WalletOptions = {}): Harness {
  const node = new TestNode()
  const updates = new Set<() => void>()
  const client = {
    address: ADDRESS,
    // The wallet reaches for exactly these three node methods and `on`. Casting
    // a structural stand-in at this one boundary is what `leak.test.ts` already
    // does for `kei`, and it is what lets a lookup be held open by hand.
    node: {
      accountInfo: () => node.accountInfo(),
      holdings: () => node.holdingsOf(),
      assetInfo: (asset: AssetId) => node.assetInfo(asset),
    },
    on(event: string, listener: () => void) {
      if (event !== 'update') return () => undefined
      updates.add(listener)
      return () => updates.delete(listener)
    },
  } as unknown as KeiClient

  return {
    wallet: createWallet(client, options),
    node,
    update: () => {
      for (const listener of [...updates]) listener()
    },
    get clientListeners() {
      return updates.size
    },
  }
}

function optionFailure(options: WalletOptions): KeiError {
  try {
    harness(options)
  } catch (error) {
    expect(error).toBeInstanceOf(KeiError)
    return error as KeiError
  }
  throw new Error('expected createWallet() to reject the wallet options')
}

/**
 * Answers lookups one full wave at a time until nothing is outstanding, and
 * returns the size of each wave. With a bound of L and N uncached assets this
 * is `ceil(N / L)` entries — the whole point of the change.
 */
async function drain(node: TestNode): Promise<number[]> {
  const waves: number[] = []
  await flush()
  while (node.outstanding > 0) {
    waves.push(node.outstanding)
    node.settleAll()
    await flush()
  }
  return waves
}

// --------------------------------------------------------------- concurrency

describe('asset lookups are concurrent and bounded', () => {
  test('a hundred holdings resolve in ceil(100/8) waves, never more than 8 at once', async () => {
    const h = harness()
    h.node.setHoldings(ids(100))

    const pending = h.wallet.summary()
    const waves = await drain(h.node)
    const summary = await pending

    expect(waves).toEqual([8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 4])
    expect(waves).toHaveLength(Math.ceil(100 / 8))
    expect(h.node.peakInFlight).toBe(8)
    expect(h.node.assetCalls).toHaveLength(100)
    expect(summary.tokens).toHaveLength(100)
  })

  test('assetConcurrency sets the bound, and the wave count follows it', async () => {
    for (const [limit, count] of [
      [1, 12],
      [3, 12],
      [4, 10],
      [16, 100],
    ] as const) {
      const h = harness({ assetConcurrency: limit })
      h.node.setHoldings(ids(count))
      const pending = h.wallet.summary()
      const waves = await drain(h.node)
      await pending

      expect(waves).toHaveLength(Math.ceil(count / limit))
      expect(h.node.peakInFlight).toBe(Math.min(limit, count))
    }
  })

  test('the lower, default, and upper option boundaries are accepted', () => {
    expect(() => harness()).not.toThrow()
    expect(() => harness({ assetConcurrency: DEFAULT_ASSET_CONCURRENCY })).not.toThrow()
    expect(() => harness({ assetCacheLimit: DEFAULT_ASSET_CACHE_LIMIT })).not.toThrow()
    expect(() => harness({ assetConcurrency: 1, assetCacheLimit: 1 })).not.toThrow()
    expect(() => harness({ assetConcurrency: MAX_ASSET_CONCURRENCY })).not.toThrow()
    expect(() => harness({ assetCacheLimit: MAX_ASSET_CACHE_LIMIT })).not.toThrow()
  })

  test('invalid option boundaries fail synchronously with bad-wallet-option', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const concurrency = optionFailure({ assetConcurrency: bad })
      expect(concurrency.code).toBe('bad-wallet-option')
      expect(concurrency.message).toContain('assetConcurrency must be a whole number from 1 through 32')

      const cache = optionFailure({ assetCacheLimit: bad })
      expect(cache.code).toBe('bad-wallet-option')
      expect(cache.message).toContain(`assetCacheLimit must be a whole number from 1 through ${MAX_ASSET_CACHE_LIMIT}`)
    }

    const excessiveConcurrency = optionFailure({ assetConcurrency: MAX_ASSET_CONCURRENCY + 1 })
    expect(excessiveConcurrency.code).toBe('bad-wallet-option')
    expect(excessiveConcurrency.message).toContain('assetConcurrency')

    for (const bad of [MAX_ASSET_CACHE_LIMIT + 1, Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE]) {
      const cache = optionFailure({ assetCacheLimit: bad })
      expect(cache.code).toBe('bad-wallet-option')
      expect(cache.message).toContain(`assetCacheLimit must be a whole number from 1 through ${MAX_ASSET_CACHE_LIMIT}`)
    }
  })

  test('the exported defaults and finite maxima are the supported option contract', () => {
    expect(DEFAULT_ASSET_CONCURRENCY).toBe(8)
    expect(MAX_ASSET_CONCURRENCY).toBe(32)
    expect(DEFAULT_ASSET_CACHE_LIMIT).toBe(2_048)
    expect(MAX_ASSET_CACHE_LIMIT).toBe(8_192)
  })

  test('the bound holds across overlapping summaries over disjoint assets', async () => {
    // The regression this exists for: a bound that lives on one `resolve()`
    // call is not a bound on the wallet. Two summaries over sets that share
    // nothing cannot dedupe their way under the limit, so if the ceiling is
    // per-call this reaches 8 rather than 4.
    const h = harness({ assetConcurrency: 4 })

    h.node.setHoldings(ids(10, 'A'))
    const first = h.wallet.summary()
    await flush()
    expect(h.node.outstanding).toBe(4)

    h.node.setHoldings(ids(10, 'B'))
    const second = h.wallet.summary()
    await flush()

    expect(h.node.peakInFlight).toBe(4)
    expect(h.node.outstanding).toBe(4)

    while (h.node.outstanding > 0) {
      h.node.settleAll()
      await flush()
    }
    const [a, b] = await Promise.all([first, second])

    expect(h.node.peakInFlight).toBe(4)
    expect(h.node.assetCalls).toHaveLength(20)
    expect(a.tokens.map((t) => t.asset)).toEqual(ids(10, 'A'))
    expect(b.tokens.map((t) => t.asset)).toEqual(ids(10, 'B'))
  })

  test('overlapping summaries over the same asset share one request', async () => {
    const h = harness({ assetConcurrency: 4 })
    h.node.setHoldings(ids(3))

    const first = h.wallet.summary()
    await flush()
    const second = h.wallet.summary()
    await flush()

    expect(h.node.assetCalls).toHaveLength(3)
    while (h.node.outstanding > 0) {
      h.node.settleAll()
      await flush()
    }
    await Promise.all([first, second])
    expect(h.node.assetCalls).toHaveLength(3)
    // Both summaries still read the mutable half for themselves.
    expect(h.node.holdingsCalls).toBe(2)
    expect(h.node.accountCalls).toBe(2)
  })

  test('the same asset held twice is asked about once', async () => {
    const h = harness()
    h.node.holdings = [
      { asset: 'A000', balance: '1' },
      { asset: 'A000', balance: '2' },
      { asset: 'A001', balance: '1' },
    ]
    const pending = h.wallet.summary()
    await drain(h.node)
    await pending
    expect(h.node.assetCalls).toEqual(['A000', 'A001'])
  })
})

// --------------------------------------------------------------------- cache

describe('immutable metadata is cached; mutable state never is', () => {
  test('a second summary asks the node about no assets at all', async () => {
    const h = harness()
    h.node.setHoldings(ids(20))

    const first = h.wallet.summary()
    await drain(h.node)
    await first
    expect(h.node.assetCalls).toHaveLength(20)

    const second = h.wallet.summary()
    await drain(h.node)
    await second
    expect(h.node.assetCalls).toHaveLength(20)
    expect(h.node.holdingsCalls).toBe(2)
    expect(h.node.accountCalls).toBe(2)
  })

  test('balances, holdings and claims are re-read even when metadata is cached', async () => {
    const h = harness()
    h.node.balance = (5n * 10n ** 18n).toString()
    h.node.setHoldings(['A000'], '100')

    const first = h.wallet.summary()
    await drain(h.node)
    expect((await first).kei).toBe(5)
    expect((await first).tokens[0]?.amount).toBe(1)

    // The chain moved: balance up, holding up, and a second asset arrived.
    h.node.balance = (9n * 10n ** 18n).toString()
    h.node.holdings = [
      { asset: 'A000', balance: '250' },
      { asset: 'A001', balance: '1' },
    ]

    const second = h.wallet.summary()
    await drain(h.node)
    const after = await second

    expect(after.kei).toBe(9)
    expect(after.tokens[0]?.amount).toBe(2.5)
    expect(after.tokens).toHaveLength(2)
    // Only the genuinely new asset cost a request.
    expect(h.node.assetCalls).toEqual(['A000', 'A001'])
  })

  test('an asset the node does not know is re-asked, and recovers when it answers', async () => {
    const h = harness()
    h.node.unknown.add('A001')
    h.node.setHoldings(['A000', 'A001'])

    const first = h.wallet.summary()
    await drain(h.node)
    expect((await first).tokens.map((t) => t.asset)).toEqual(['A000'])
    expect(h.node.assetCalls).toEqual(['A000', 'A001'])

    // Absence was never remembered, so the next summary asks again — and this
    // time the node has caught up.
    h.node.unknown.delete('A001')
    const second = h.wallet.summary()
    await drain(h.node)
    expect((await second).tokens.map((t) => t.asset)).toEqual(['A000', 'A001'])
    expect(h.node.assetCalls).toEqual(['A000', 'A001', 'A001'])
  })

  test('a failed lookup rejects the summary, caches nothing, and recovers next time', async () => {
    const h = harness()
    h.node.broken.add('A001')
    h.node.setHoldings(['A000', 'A001'])

    // The handler goes on before the lookup is answered: the rejection happens
    // during `drain`, and a promise left bare until afterwards would be an
    // unhandled rejection rather than a caught one.
    const failure = h.wallet.summary().then(
      () => new Error('summary resolved but the node had failed'),
      (error: unknown) => error,
    )
    await drain(h.node)
    expect((await failure) as Error).toBeInstanceOf(KeiError)
    expect(String((await failure as Error).message)).toContain('the node did not answer')

    h.node.broken.delete('A001')
    const second = h.wallet.summary()
    await drain(h.node)
    expect((await second).tokens.map((t) => t.asset)).toEqual(['A000', 'A001'])
    // A000 answered the first time and stayed cached; only A001 was re-asked.
    expect(h.node.assetCalls).toEqual(['A000', 'A001', 'A001'])
  })

  test('mismatched asset metadata rejects, is not cached, and recovers on retry', async () => {
    const h = harness()
    h.node.setHoldings(['A000'], '123')
    h.node.returnedIds.set('A000', 'B000')

    const failure = h.wallet.summary().then(
      () => new Error('summary resolved with mismatched asset metadata'),
      (error: unknown) => error,
    )
    await drain(h.node)
    const mismatch = await failure

    expect(mismatch).toBeInstanceOf(KeiError)
    expect((mismatch as KeiError).code).toBe('asset-info-mismatch')
    expect((mismatch as KeiError).message).toContain('A000')
    expect((mismatch as KeiError).message).toContain('B000')

    h.node.returnedIds.delete('A000')
    const second = h.wallet.summary()
    await drain(h.node)
    expect((await second).tokens).toEqual([
      {
        asset: 'A000',
        symbol: 'A000',
        name: 'Name A000',
        amount: 1.23,
        issuer: 'kei_issuer',
      },
    ])
    expect(h.node.assetCalls).toEqual(['A000', 'A000'])
  })

  test('the cache evicts least-recently-used at assetCacheLimit, and re-learns', async () => {
    const h = harness({ assetCacheLimit: 2, assetConcurrency: 1 })

    h.node.setHoldings(['A000', 'A001'])
    const first = h.wallet.summary()
    await drain(h.node)
    await first
    expect(h.node.assetCalls).toEqual(['A000', 'A001'])

    // Touch A000 so A001 is the least recently used, then add a third.
    h.node.setHoldings(['A000'])
    const second = h.wallet.summary()
    await drain(h.node)
    await second

    h.node.setHoldings(['A000', 'A002'])
    const third = h.wallet.summary()
    await drain(h.node)
    await third
    expect(h.node.assetCalls).toEqual(['A000', 'A001', 'A002'])

    // A001 was the one evicted; A000 and A002 are still free.
    h.node.setHoldings(['A000', 'A001', 'A002'])
    const fourth = h.wallet.summary()
    await drain(h.node)
    expect((await fourth).tokens).toHaveLength(3)
    expect(h.node.assetCalls).toEqual(['A000', 'A001', 'A002', 'A001'])
  })
})

// ------------------------------------------------------------------ ordering

describe('output order is asset id, whatever the node and the network did', () => {
  test('tokens and items are each ascending by asset id', async () => {
    const h = harness({ assetConcurrency: 16 })
    for (const id of ['T003', 'T001', 'T002']) h.node.kinds.set(id, 'token')
    for (const id of ['I003', 'I001', 'I002']) h.node.kinds.set(id, 'item')
    // Holdings arrive in an order no node would sort into, and the lookups are
    // answered back-to-front on top of that.
    h.node.setHoldings(['T003', 'I002', 'T001', 'I003', 'T002', 'I001'])

    const pending = h.wallet.summary()
    await flush()
    h.node.settleAll()
    await flush()
    const summary = await pending

    expect(summary.tokens.map((t) => t.asset)).toEqual(['T001', 'T002', 'T003'])
    expect(summary.items.map((i) => i.asset)).toEqual(['I001', 'I002', 'I003'])
  })

  test('two summaries over the same holdings agree exactly', async () => {
    const h = harness()
    h.node.setHoldings(ids(30))

    const first = h.wallet.summary()
    await drain(h.node)
    const a = await first

    h.node.holdings = [...h.node.holdings].reverse()
    const second = h.wallet.summary()
    await drain(h.node)
    const b = await second

    expect(b.tokens).toEqual(a.tokens)
    expect(b.items).toEqual(a.items)
  })
})

// ------------------------------------------------------------- change events

/** Subscribes and records every summary delivered, in delivery order. */
function record(wallet: WalletApi): { seen: WalletSummary[]; off: () => void } {
  const seen: WalletSummary[] = []
  const off = wallet.on('change', (summary) => {
    seen.push(summary)
  })
  return { seen, off }
}

describe('update bursts are coalesced across every listener', () => {
  test('a burst during one refresh becomes exactly one follow-up', async () => {
    const h = harness()
    h.node.setHoldings(ids(4))
    const listener = record(h.wallet)

    h.update()
    await flush()
    expect(h.node.holdingsCalls).toBe(1)

    // Five more blocks land while the first scan is still out.
    for (let i = 0; i < 5; i++) h.update()
    await flush()
    expect(h.node.holdingsCalls).toBe(1)

    h.node.settleAll()
    await flush()
    // One active pass, then one queued pass covering the whole burst.
    expect(h.node.holdingsCalls).toBe(2)

    await drain(h.node)
    expect(h.node.holdingsCalls).toBe(2)
    expect(listener.seen).toHaveLength(2)
    listener.off()
  })

  test('an update arriving at the very end of a refresh is still honoured', async () => {
    const h = harness()
    h.node.setHoldings(['A000'])
    const listener = record(h.wallet)

    h.update()
    await flush()
    // The lookup is out; the update lands before this pass has delivered.
    h.update()
    await drain(h.node)

    expect(h.node.holdingsCalls).toBe(2)
    expect(listener.seen).toHaveLength(2)
    // The last delivery reflects the latest state, not the state at the burst.
    listener.off()
  })

  test('many listeners share one refresh and all of them are told', async () => {
    const h = harness()
    h.node.setHoldings(ids(3))
    const a = record(h.wallet)
    const b = record(h.wallet)
    const c = record(h.wallet)

    expect(h.clientListeners).toBe(1)

    h.update()
    await drain(h.node)

    expect(h.node.holdingsCalls).toBe(1)
    expect(a.seen).toHaveLength(1)
    expect(b.seen).toHaveLength(1)
    expect(c.seen).toHaveLength(1)
    expect(a.seen[0]).toBe(b.seen[0] as WalletSummary)
    a.off()
    b.off()
    c.off()
  })

  test('a listener joining mid-refresh does not receive its pre-subscription snapshot', async () => {
    const h = harness()
    h.node.setHoldings(['A000'])
    const existing = record(h.wallet)

    h.update()
    await flush()
    expect(h.node.outstanding).toBe(1)

    const late = record(h.wallet)
    await drain(h.node)
    expect(existing.seen).toHaveLength(1)
    expect(late.seen).toHaveLength(0)

    h.update()
    await drain(h.node)
    expect(existing.seen).toHaveLength(2)
    expect(late.seen).toHaveLength(1)
    existing.off()
    late.off()
  })

  test('unsubscribe and re-subscribe of the same callback cannot revive an old subscription', async () => {
    const h = harness()
    h.node.setHoldings(['A000'])
    const seen: WalletSummary[] = []
    const listener = (summary: WalletSummary): void => {
      seen.push(summary)
    }
    const anchor = record(h.wallet)
    const firstOff = h.wallet.on('change', listener)

    h.update()
    await flush()
    firstOff()
    const currentOff = h.wallet.on('change', listener)
    await drain(h.node)

    expect(anchor.seen).toHaveLength(1)
    expect(seen).toHaveLength(0)
    h.update()
    await drain(h.node)
    expect(seen).toHaveLength(1)
    anchor.off()
    currentOff()
  })

  test('a throwing listener does not stop the others, or the next update', async () => {
    const h = harness()
    h.node.setHoldings(['A000'])
    const seen: string[] = []
    const offBad = h.wallet.on('change', () => {
      seen.push('bad')
      throw new Error('listener bug')
    })
    const offGood = h.wallet.on('change', () => {
      seen.push('good')
    })

    h.update()
    await drain(h.node)
    expect(seen).toEqual(['bad', 'good'])

    h.update()
    await drain(h.node)
    expect(seen).toEqual(['bad', 'good', 'bad', 'good'])
    offBad()
    offGood()
  })

  test('a refresh that fails is dropped quietly and does not starve the next one', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const h = harness()
      h.node.broken.add('A000')
      h.node.setHoldings(['A000'])
      const listener = record(h.wallet)

      h.update()
      await drain(h.node)
      expect(listener.seen).toHaveLength(0)

      h.node.broken.delete('A000')
      h.update()
      await drain(h.node)
      expect(listener.seen).toHaveLength(1)
      listener.off()
    } finally {
      await flush()
      process.off('unhandledRejection', onRejection)
    }
    expect(rejections).toEqual([])
  })
})

describe('unsubscribing stops the work and the delivery', () => {
  test('the last unsubscribe drops the client subscription', async () => {
    const h = harness()
    h.node.setHoldings(['A000'])
    const a = record(h.wallet)
    const b = record(h.wallet)

    a.off()
    expect(h.clientListeners).toBe(1)
    b.off()
    expect(h.clientListeners).toBe(0)

    h.update()
    await flush()
    expect(h.node.holdingsCalls).toBe(0)
  })

  test('unsubscribing twice is harmless and does not drop another listener', async () => {
    const h = harness()
    h.node.setHoldings(['A000'])
    const a = record(h.wallet)
    const b = record(h.wallet)

    a.off()
    a.off()
    expect(h.clientListeners).toBe(1)

    h.update()
    await drain(h.node)
    expect(b.seen).toHaveLength(1)
    expect(a.seen).toHaveLength(0)
    b.off()
  })

  test('a refresh already in flight delivers to nobody once everyone has left', async () => {
    const h = harness()
    h.node.setHoldings(['A000'])
    const listener = record(h.wallet)

    h.update()
    await flush()
    expect(h.node.outstanding).toBe(1)

    listener.off()
    await drain(h.node)

    expect(listener.seen).toHaveLength(0)
    // And it does not deliver to a listener that arrived after that snapshot
    // was read, either.
    const late = record(h.wallet)
    await flush()
    expect(late.seen).toHaveLength(0)
    late.off()
  })

  test('a new generation does not lose an update behind an abandoned refresh', async () => {
    const h = harness()
    h.node.setHoldings(['A000'])
    const old = record(h.wallet)

    h.update()
    await flush()
    expect(h.node.outstanding).toBe(1)

    old.off()
    const current = record(h.wallet)
    h.update()
    await drain(h.node)
    await flush()

    expect(old.seen).toHaveLength(0)
    expect(current.seen).toHaveLength(1)
    expect(h.node.holdingsCalls).toBe(2)
    current.off()
  })
})

// --------------------------------------------------------------------- panel

describe('the panel never paints an older summary over a newer one', () => {
  function panelKei(wallet: WalletApi): WalletPanelKei {
    return {
      address: ADDRESS,
      seed: 'S'.repeat(64),
      client: { reveal: 'never' },
      wallet,
    }
  }

  test('a change delivered first wins over a slow initial summary', async () => {
    const h = harness()
    h.node.setHoldings([])
    h.node.balance = (1n * 10n ** 18n).toString()
    const dom = makeDom()

    // The panel's own first `summary()` is held open by leaving one lookup
    // outstanding, so the change event overtakes it.
    h.node.setHoldings(['A000'])
    const handle = WalletPanel.mount(dom.container, { kei: panelKei(h.wallet) })
    await flush()
    expect(h.node.outstanding).toBe(1)

    // A block lands and the wallet refreshes with a newer balance. Its lookup
    // is served from the same in-flight request, so settling once answers both.
    h.node.balance = (7n * 10n ** 18n).toString()
    h.update()
    await drain(h.node)

    const value = handle.element.querySelector('.kei-wallet-panel__value')
    expect(value?.textContent).toBe('7')

    // The mount-time summary resolved with the older balance of 1. It must not
    // repaint over the 7 the change event already delivered.
    await flush()
    expect(handle.element.querySelector('.kei-wallet-panel__value')?.textContent).toBe('7')
    handle.unmount()
  })

  test('a failed initial summary does not blank a panel the change stream filled', async () => {
    const h = harness()
    h.node.broken.add('A000')
    h.node.setHoldings(['A000'])
    const dom = makeDom()

    const handle = WalletPanel.mount(dom.container, { kei: panelKei(h.wallet) })
    await flush()

    // The change refresh succeeds; the mount-time fetch is the one that breaks.
    h.node.broken.delete('A000')
    h.node.balance = (3n * 10n ** 18n).toString()
    h.update()
    await flush()
    h.node.settleAll()
    await drain(h.node)

    expect(handle.element.querySelector('.kei-wallet-panel__value')?.textContent).toBe('3')
    expect(handle.element.querySelector('.kei-wallet-panel__error')).toBeNull()
    handle.unmount()
  })

  test('a refresh begun before mount cannot repaint a newer initial summary', async () => {
    const dom = makeDom()
    const updates = new Set<() => void>()
    let accountCalls = 0
    let resolveOld: ((info: AccountInfo) => void) | undefined
    const oldInfo = new Promise<AccountInfo>((resolve) => {
      resolveOld = resolve
    })
    const account = (kei: number): AccountInfo => ({
      address: ADDRESS,
      frontier: '0'.repeat(64),
      height: 1,
      balance: (BigInt(kei) * 10n ** 18n).toString(),
      representative: ADDRESS,
      receivableCount: 0,
      issuedCount: 0,
    })
    const client = {
      address: ADDRESS,
      node: {
        accountInfo: () => (++accountCalls === 1 ? oldInfo : Promise.resolve(account(2))),
        holdings: async () => [],
        assetInfo: async () => null,
      },
      on(event: string, listener: () => void) {
        if (event !== 'update') return () => undefined
        updates.add(listener)
        return () => updates.delete(listener)
      },
    } as unknown as KeiClient
    const wallet = createWallet(client)
    const anchorOff = wallet.on('change', () => undefined)

    for (const update of [...updates]) update()
    await flush()
    const handle = WalletPanel.mount(dom.container, { kei: panelKei(wallet) })
    await flush()
    expect(handle.element.querySelector('.kei-wallet-panel__value')?.textContent).toBe('2')

    resolveOld?.(account(1))
    await flush()
    expect(handle.element.querySelector('.kei-wallet-panel__value')?.textContent).toBe('2')
    expect(accountCalls).toBe(2)

    handle.unmount()
    anchorOff()
  })
})

// ---------------------------------------------------------- wave arithmetic

describe('performance evidence: waves, not wall clock', () => {
  test('round trips grow with ceil(N / limit) rather than with N', async () => {
    const table: Array<{ holdings: number; limit: number; serial: number; waves: number }> = []

    for (const [holdings, limit] of [
      [25, 8],
      [100, 8],
      [100, 4],
      [100, 16],
      [256, 8],
    ] as const) {
      const h = harness({ assetConcurrency: limit })
      h.node.setHoldings(ids(holdings))
      const pending = h.wallet.summary()
      const waves = await drain(h.node)
      await pending

      table.push({ holdings, limit, serial: holdings, waves: waves.length })
      expect(waves.length).toBe(Math.ceil(holdings / limit))
      expect(h.node.peakInFlight).toBe(limit)
      expect(h.node.assetCalls).toHaveLength(holdings)
    }

    expect(table).toEqual([
      { holdings: 25, limit: 8, serial: 25, waves: 4 },
      { holdings: 100, limit: 8, serial: 100, waves: 13 },
      { holdings: 100, limit: 4, serial: 100, waves: 25 },
      { holdings: 100, limit: 16, serial: 100, waves: 7 },
      { holdings: 256, limit: 8, serial: 256, waves: 32 },
    ])
  })

  test('a repeat summary of a hundred holdings costs zero metadata round trips', async () => {
    const h = harness()
    h.node.setHoldings(ids(100))

    const first = h.wallet.summary()
    const waves = await drain(h.node)
    await first
    expect(waves).toHaveLength(13)

    const second = h.wallet.summary()
    const repeatWaves = await drain(h.node)
    await second

    expect(repeatWaves).toEqual([])
    expect(h.node.assetCalls).toHaveLength(100)
  })
})
