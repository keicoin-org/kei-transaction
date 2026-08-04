/**
 * The walk every market read is built on.
 *
 * Three properties, and each one is a defect this package shipped with:
 *
 * - **The answer does not depend on who answered first.** Reads run in parallel
 *   now, so a row order that followed completion order would make every market
 *   view untestable and every book different on a slow link.
 * - **It is bounded.** A 128-account directory is the package's own default, and
 *   fanning 128 requests at a rate-limited node is a worse failure than a slow
 *   read.
 * - **It admits what it missed.** A chain that threw, a page that filled, an
 *   address that was not one, an eviction — four different reasons a walk is
 *   short, and all four used to look like "nobody is selling".
 *
 * Pure, so no chain is imported: the walk takes a read function, and these hand
 * it one that counts. The same properties over a real ledger are in
 * `packages/kei/test/market-coverage.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { KeiError, keyPairFromSeed, randomSeed } from '@keicoin/core'
import {
  DEFAULT_ACCOUNT_LIMIT,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  coverageOf,
  createDirectory,
  emptyCoverage,
  isAborted,
  isMarketError,
  mapConcurrent,
  mergeCoverage,
  walkAccounts,
  withCoverage,
  type AccountRead,
} from '@keicoin/market'
import { accountLimitOf } from '../src/walk.js'

async function addresses(count: number): Promise<string[]> {
  const pairs = await Promise.all(Array.from({ length: count }, () => keyPairFromSeed(randomSeed(), 0)))
  return pairs.map((pair) => pair.address)
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A read that answers with the account's own name, after an optional pause. */
const rows =
  (pause: (account: string) => number = () => 0) =>
  async (account: string): Promise<AccountRead<string>> => {
    const ms = pause(account)
    if (ms > 0) await wait(ms)
    return { rows: [account], truncated: false }
  }

describe('walkAccounts — the answer is not a race', () => {
  test('rows come back in the order the accounts were asked for', async () => {
    const [a, b, c] = (await addresses(3)) as [string, string, string]
    // Reversed on purpose: the first account asked for is the last to answer.
    const slowest = new Map([
      [a, 30],
      [b, 15],
      [c, 0],
    ])

    const walk = await walkAccounts([a, b, c], rows((account) => slowest.get(account) ?? 0))
    expect(walk.rows).toEqual([a, b, c])
    expect(walk.accounts).toEqual([a, b, c])
  })

  test('reads no more chains at once than it was told to', async () => {
    const roster = await addresses(12)
    let inFlight = 0
    let peak = 0

    await walkAccounts(
      roster,
      async (account) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await wait(5)
        inFlight -= 1
        return { rows: [account], truncated: false }
      },
      { concurrency: 3 },
    )

    expect(peak).toBe(3)
  })

  test('the default is stated rather than implied', () => {
    expect(DEFAULT_CONCURRENCY).toBe(8)
    expect(DEFAULT_ACCOUNT_LIMIT).toBe(100)
  })

  test('one chain at a time is still available, and still correct', async () => {
    const roster = await addresses(4)
    let peak = 0
    let inFlight = 0
    const walk = await walkAccounts(
      roster,
      async (account) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await wait(1)
        inFlight -= 1
        return { rows: [account], truncated: false }
      },
      { concurrency: 1 },
    )
    expect(peak).toBe(1)
    expect(walk.rows).toEqual(roster)
  })

  test('concurrency outside the supported integer range is refused rather than adjusted', async () => {
    const [only] = (await addresses(1)) as [string]
    for (const concurrency of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_CONCURRENCY + 1]) {
      const failure = await walkAccounts([only], rows(), { concurrency }).catch(
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toMatch(/how many chains to read at once/i)
      expect(isMarketError(failure, 'bad-concurrency')).toBe(true)
    }

    const emptyFailure = await mapConcurrent([], async () => 0, { concurrency: 0 }).catch(
      (error: unknown) => error,
    )
    expect(emptyFailure).toBeInstanceOf(Error)

    expect(await mapConcurrent([], async () => 0, { concurrency: MAX_CONCURRENCY })).toEqual([])
  })

  test('invalid concurrency is refused before an asynchronous directory is called', async () => {
    let calls = 0
    const directory = {
      accounts: () => {
        calls += 1
        return new Promise<readonly string[]>(() => {})
      },
    }

    const failure = await walkAccounts(directory, rows(), { concurrency: Number.NaN }).catch(
      (error: unknown) => error,
    )
    expect(isMarketError(failure, 'bad-concurrency')).toBe(true)
    expect(calls).toBe(0)
  })

  test('per-account limits are positive safe integers, not timer-style coercions', () => {
    expect(accountLimitOf(undefined)).toBe(DEFAULT_ACCOUNT_LIMIT)
    expect(accountLimitOf(1)).toBe(1)
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const failure = (() => {
        try {
          accountLimitOf(limit)
        } catch (error) {
          return error
        }
      })()
      expect(isMarketError(failure, 'bad-limit')).toBe(true)
    }
  })
})

describe('walkAccounts — coverage is the honest half', () => {
  test('a whole read says so', async () => {
    const roster = await addresses(3)
    const walk = await walkAccounts(roster, rows())
    expect(walk.coverage).toMatchObject({ asked: 3, read: 3, dropped: 0, complete: true })
    expect(walk.coverage.failed).toEqual([])
  })

  test('a chain that throws is a gap, named, and not the end of the read', async () => {
    const [a, b, c] = (await addresses(3)) as [string, string, string]
    const walk = await walkAccounts([a, b, c], async (account) => {
      if (account === b) throw new Error('node unreachable')
      return { rows: [account], truncated: false }
    })

    expect(walk.rows).toEqual([a, c])
    expect(walk.coverage.read).toBe(2)
    expect(walk.coverage.failed).toEqual([{ account: b, reason: 'node unreachable' }])
    expect(walk.coverage.complete).toBe(false)
  })

  test('a chain that filled its page is truncated, because a short answer is not a complete one', async () => {
    const [a, b] = (await addresses(2)) as [string, string]
    const walk = await walkAccounts([a, b], async (account) => ({
      rows: [account],
      truncated: account === a,
    }))
    expect(walk.coverage.truncated).toEqual([a])
    expect(walk.coverage.complete).toBe(false)
  })

  test('anything that is not an address is skipped and counted, not thrown on', async () => {
    const [real] = (await addresses(1)) as [string]
    const walk = await walkAccounts([real, 'not-an-address', ''], rows())
    expect(walk.rows).toEqual([real])
    expect(walk.coverage.skipped).toEqual(['not-an-address', ''])
    expect(walk.coverage.asked).toBe(1)
    expect(walk.coverage.complete).toBe(false)
  })

  test('the same address twice is one chain read, not two', async () => {
    const [only] = (await addresses(1)) as [string]
    let reads = 0
    const walk = await walkAccounts([only, only, only], async (account) => {
      reads += 1
      return { rows: [account], truncated: false }
    })
    expect(reads).toBe(1)
    expect(walk.coverage.asked).toBe(1)
  })

  test("a bounded directory's evictions reach the coverage", async () => {
    const roster = await addresses(3)
    const directory = createDirectory({ limit: 2 })
    for (const address of roster) directory.watch(address)

    const walk = await walkAccounts(directory, rows())
    expect(walk.coverage.dropped).toBe(1)
    expect(walk.coverage.complete).toBe(false)
  })

  test('merging two reads over the same accounts keeps the pessimistic answer', () => {
    const whole = { ...emptyCoverage(), asked: 1, read: 1 }
    const partial = {
      ...emptyCoverage(),
      asked: 1,
      read: 0,
      failed: [{ account: 'kei_x', reason: 'timed out' }],
      complete: false,
    }
    const merged = mergeCoverage(whole, partial)
    expect(merged).toMatchObject({ asked: 1, read: 0, complete: false })
    expect(merged.failed).toHaveLength(1)
  })

  test('merged read counts only accounts that answered every part', () => {
    const missedFirst = {
      ...emptyCoverage(),
      asked: 2,
      read: 1,
      failed: [{ account: 'kei_a', reason: 'first RPC failed' }],
      complete: false,
    }
    const missedSecond = {
      ...emptyCoverage(),
      asked: 2,
      read: 1,
      failed: [{ account: 'kei_b', reason: 'second RPC failed' }],
      complete: false,
    }

    expect(mergeCoverage(missedFirst, missedSecond)).toMatchObject({
      asked: 2,
      read: 0,
      complete: false,
    })
  })

  test('merging different account cardinalities refuses instead of inventing coverage', () => {
    const one = { ...emptyCoverage(), asked: 1, read: 1 }
    const two = { ...emptyCoverage(), asked: 2, read: 2 }
    let failure: unknown
    try {
      mergeCoverage(one, two)
    } catch (error) {
      failure = error
    }

    expect(isMarketError(failure, 'coverage-mismatch')).toBe(true)
    expect(failure).toMatchObject({
      code: 'coverage-mismatch',
      message: expect.stringContaining('Expected 1 accounts, but another part describes 2'),
    })
  })

  test('scope cardinality validation ignores absent optional reads', () => {
    const whole = { ...emptyCoverage(), asked: 2, read: 2 }
    expect(mergeCoverage(undefined, whole, null)).toEqual(whole)
  })

  test('an unnamed read deficit is never upgraded to complete coverage', () => {
    const partial = { ...emptyCoverage(), asked: 2, read: 1, complete: false }
    expect(mergeCoverage(undefined, partial, null)).toMatchObject({
      asked: 2,
      read: 1,
      complete: false,
    })
  })

  test('two incomplete reads with unnamed deficits refuse an unknowable intersection', () => {
    const partial = { ...emptyCoverage(), asked: 2, read: 1, complete: false }
    expect(() => mergeCoverage(partial, partial)).toThrow(/unnamed unread accounts/)
  })
})

describe('walkAccounts — a read that can be stopped', () => {
  test('a signal already aborted refuses before anything is read', async () => {
    const roster = await addresses(3)
    const controller = new AbortController()
    controller.abort()

    let reads = 0
    const failure = await walkAccounts(
      roster,
      async (account) => {
        reads += 1
        return { rows: [account], truncated: false }
      },
      { signal: controller.signal },
    ).catch((error: unknown) => error)

    expect(reads).toBe(0)
    expect(isAborted(failure)).toBe(true)
    expect(isMarketError(failure, 'read-aborted')).toBe(true)
  })

  test('aborting mid-walk stops further chains and rejects with a sentence', async () => {
    const roster = await addresses(20)
    const controller = new AbortController()
    let reads = 0

    const walk = walkAccounts(
      roster,
      async (account) => {
        reads += 1
        if (reads === 1) controller.abort(new Error('the player closed the tab'))
        await wait(2)
        return { rows: [account], truncated: false }
      },
      { signal: controller.signal, concurrency: 2 },
    )

    const failure = await walk.catch((error: unknown) => error)
    expect(isAborted(failure)).toBe(true)
    expect((failure as Error).message).toContain('the player closed the tab')
    expect((failure as Error).message).toContain('Nothing was signed')
    // Both lanes had started before the abort landed; nothing beyond them ran.
    expect(reads).toBeLessThanOrEqual(2)
  })

  test('an abort rejects without waiting for the reads already in flight', async () => {
    const [only] = (await addresses(1)) as [string]
    const controller = new AbortController()
    let settled = false

    const walk = walkAccounts(
      [only],
      async (account) => {
        await wait(200)
        settled = true
        return { rows: [account], truncated: false }
      },
      { signal: controller.signal },
    )
    await wait(5)
    controller.abort()

    expect(isAborted(await walk.catch((error: unknown) => error))).toBe(true)
    // The point of the check: the caller was answered while the read was still
    // outstanding. Cancelling the request itself needs a node contract that
    // takes a signal, and this one does not.
    expect(settled).toBe(false)
  })

  test('an abort rejects without waiting for an asynchronous directory', async () => {
    const controller = new AbortController()
    const directory = { accounts: () => new Promise<readonly string[]>(() => {}) }
    const walk = walkAccounts(directory, rows(), { signal: controller.signal })

    await wait(5)
    controller.abort(new Error('the roster stopped responding'))

    const failure = await walk.catch((error: unknown) => error)
    expect(isAborted(failure)).toBe(true)
    expect((failure as Error).message).toContain('the roster stopped responding')
  })

  test('a directory rejection after abort stays handled', async () => {
    const controller = new AbortController()
    let rejectDirectory: (error: Error) => void = () => {}
    const directory = {
      accounts: () =>
        new Promise<readonly string[]>((_, reject) => {
          rejectDirectory = reject
        }),
    }
    const walk = walkAccounts(directory, rows(), { signal: controller.signal })

    await wait(0)
    controller.abort()
    expect(isAborted(await walk.catch((error: unknown) => error))).toBe(true)
    rejectDirectory(new Error('late directory failure'))
    await wait(0)
  })
})

describe('mapConcurrent', () => {
  test('results land at their own index whatever order they finish in', async () => {
    const out = await mapConcurrent([50, 10, 30, 0], async (ms, index) => {
      await wait(ms)
      return index
    })
    expect(out).toEqual([0, 1, 2, 3])
  })

  test('an empty list is not a read', async () => {
    let called = false
    expect(
      await mapConcurrent([], async () => {
        called = true
        return 1
      }),
    ).toEqual([])
    expect(called).toBe(false)
  })
})

describe('coverage rides along without changing the rows', () => {
  const coverage = { ...emptyCoverage(), asked: 2, read: 1, complete: false }

  test('the value is still an array in every way anything already used it', () => {
    const covered = withCoverage([1, 2, 3], coverage)
    expect(Array.isArray(covered)).toBe(true)
    expect(covered).toHaveLength(3)
    expect([...covered]).toEqual([1, 2, 3])
    expect(covered.map((n) => n * 2)).toEqual([2, 4, 6])
    // The two that would have broken a caller: an equality assertion against a
    // plain array, and a serialisation. The cast is the one compatibility note
    // this change carries — `coverage` is required in the *type*, so a matcher
    // that compares a `Covered<T>` against an array literal wants a widening
    // first. Nothing about the value at runtime is different.
    expect(covered as number[]).toEqual([1, 2, 3])
    expect(JSON.stringify(covered)).toBe('[1,2,3]')
    expect(Object.keys(covered)).toEqual(['0', '1', '2'])
  })

  test('coverageOf reads it back, and answers null for rows that came from nowhere', () => {
    expect(coverageOf(withCoverage([1], coverage))).toEqual(coverage)
    // Null rather than an empty coverage: "these did not come from a walk" is a
    // different answer from "the walk saw everything".
    expect(coverageOf([1, 2, 3])).toBeNull()
    expect(coverageOf(undefined)).toBeNull()
  })

  test('coverageOf refuses partial, inconsistent, and malformed lookalikes', () => {
    const cases: unknown[] = [
      { asked: 1, complete: true },
      { ...emptyCoverage(), asked: 1.5 },
      { ...emptyCoverage(), asked: 1, read: 0, complete: true },
      { ...emptyCoverage(), failed: [{ account: 'kei_x' }] },
      { ...emptyCoverage(), truncated: [1] },
      { ...emptyCoverage(), skipped: ['ok', null] },
    ]
    for (const carried of cases) {
      const rowsWithLookalike: unknown[] = []
      Object.defineProperty(rowsWithLookalike, 'coverage', { value: carried })
      expect(coverageOf(rowsWithLookalike)).toBeNull()
    }
  })

  test('the guard is exact code membership, not error provenance', () => {
    expect(isMarketError(new KeiError('bad-address', 'not a market refusal'))).toBe(false)
    expect(isMarketError(new KeiError('bad-amount', 'constructed by another layer'))).toBe(true)
  })

  test('a transform drops it, which is why coverageOf is read off the market value', () => {
    const covered = withCoverage([1, 2, 3], coverage)
    expect(coverageOf(covered.filter((n) => n > 1))).toBeNull()
  })
})
