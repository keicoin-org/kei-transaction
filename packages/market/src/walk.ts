/**
 * How this package reads more than one chain.
 *
 * An offer lives on its author's chain (SPEC §9.1), so every market read that is
 * about more than one account is a walk: one `account_swaps` per chain, bounded,
 * and never a sweep of the ledger. That shape is settled and correct. What was
 * not settled is how the walk behaves, and three properties were missing from it
 * everywhere except `book()`:
 *
 * **It went one chain at a time.** A 128-account directory — the package's own
 * default bound — was 128 sequential round trips per refresh. On a 40 ms link
 * that is five seconds to draw a book, and the chains have nothing to do with
 * each other: `account_swaps` on Alice's chain does not depend on Bob's answer.
 * Reads run `concurrency` at a time now, which turns 128 round trips into 16.
 *
 * **It could not be stopped.** A market view polls, and a player who navigates
 * away leaves the walk running to the end. Every read takes a `signal` now.
 *
 * **It said nothing about what it missed.** `book()` returned `Coverage` and
 * every other read returned a bare array, so a price summary could answer from
 * half the sellers because three chains timed out and say so nowhere. Coverage
 * now rides along on every result that can carry provenance. The legacy scalar
 * `medianPrice()` remains coverage-blind; use `price()` when that matters.
 *
 * One rule holds all three together: **a walk's answer never depends on which
 * chain answered first.** Rows come back in the order the accounts were asked
 * for, whatever order they arrive in, so concurrency changes the wall clock and
 * nothing else.
 */

import { KeiError, isAddress } from '@keicoin/core'

import { directoryDropped, resolveAccounts, type AccountSource } from './directory.js'

/**
 * Chains read at once, unless told otherwise.
 *
 * Eight is deliberately conservative: the public node is one rate-limited box
 * with no uptime promise (SPEC §5.9, §15), while browsers and Node runtimes may
 * negotiate different transports and connection limits. A client that fans an
 * entire 128-account directory out at once invites throttling; eight removes
 * the serial round-trip wall without pretending every deployment has the same
 * network stack. Raise it against a node you operate and measure.
 */
export const DEFAULT_CONCURRENCY = 8

/**
 * Highest supported concurrency for one walk.
 *
 * A finite ceiling keeps an untrusted option from turning a bounded directory
 * into an accidental request flood. Callers that need more throughput should
 * shard deliberately across nodes they operate and can measure.
 */
export const MAX_CONCURRENCY = 32

/**
 * Offers or blocks read from one chain before the walk gives up on that chain.
 *
 * Stated here rather than left to the transport, because the transports did not
 * agree: `HttpNode` sends `count: 100` when no limit is given and `MockNode`
 * returns the whole chain, so the same walk was bounded over RPC and unbounded
 * in a test. A walk that names its own page is the same walk everywhere, and it
 * is the only way `Coverage.truncated` can be true rather than unknowable.
 */
export const DEFAULT_ACCOUNT_LIMIT = 100

/** Why a walked read might be missing something, in the only terms it can honestly give. */
export interface Coverage {
  /** Accounts the walk was asked to read, after removing duplicates. */
  asked: number
  /** Accounts that answered. */
  read: number
  /** Accounts whose read threw, and the sentence it threw. */
  failed: readonly { account: string; reason: string }[]
  /**
   * Accounts that returned as many rows as this walk asked for, so their chain
   * may hold more. A server that silently caps below the asked limit is
   * indistinguishable from a complete short page; keep the requested limit at
   * or below the node's documented cap when completeness matters.
   */
  truncated: readonly string[]
  /** Accounts a bounded directory evicted before this walk (see `directory.ts`). */
  dropped: number
  /** Addresses in `from` that are not addresses. Skipped rather than thrown on. */
  skipped: readonly string[]
  /**
   * True only when every account asked answered in full and nothing was
   * evicted. False is the normal case for any market with a roster in it, and
   * it means "there may be more", never "these rows are wrong".
   */
  complete: boolean
}

/**
 * Rows, and what the walk that produced them could not see.
 *
 * It is an array, so everything that worked on the old return value still works:
 * `length`, `for…of`, `map`, `JSON.stringify`, index access, all unchanged. The
 * `coverage` property is non-enumerable for exactly that reason — nothing that
 * spreads, serialises or enumerates these rows sees a new key.
 *
 * The cost of that trick, stated: `.map()` and `.filter()` return plain arrays
 * and drop it. Read `coverage` off the value the market handed you, or keep it
 * with `coverageOf()` before you transform.
 */
export type Covered<T> = T[] & { readonly coverage: Coverage }

/** What every read that walks chains accepts, on top of its own options. */
export interface ReadOptions {
  /**
   * Stop the walk. A poll that outlives its screen is the case this exists for.
   *
   * It stops further chain reads from *starting*; a request already in flight is
   * not cancelled, because the node contract takes no signal. With the default
   * concurrency that bounds an abort at one outstanding read per lane, and the
   * call rejects immediately rather than waiting for them.
   */
  signal?: AbortSignal
  /** Chains read at once by this call. Integer 1–32; default 8. */
  concurrency?: number
}

/** One account's answer, and whether its chain may hold more than the page returned. */
export interface AccountRead<T> {
  rows: readonly T[]
  truncated: boolean
}

export interface Walk<T> {
  /** In the order the accounts were asked for, never in the order they answered. */
  rows: T[]
  coverage: Coverage
  /** The addresses actually walked: deduplicated, in request order. */
  accounts: string[]
}

/** A coverage for rows that came from nowhere — an empty walk, or a hand-built list. */
export function emptyCoverage(): Coverage {
  return { asked: 0, read: 0, failed: [], truncated: [], dropped: 0, skipped: [], complete: true }
}

/**
 * The coverage a market read attached, or null.
 *
 * Null means "these rows did not come from a walk", which is a different answer
 * from "the walk was incomplete" and is why this is not an empty `Coverage`. A
 * pure function handed a hand-built array of trades has nothing to say about
 * coverage and should say nothing.
 */
export function coverageOf(rows: unknown): Coverage | null {
  if (typeof rows !== 'object' || rows === null) return null
  const carried = (rows as { coverage?: unknown }).coverage
  return isCoverage(carried) ? carried : null
}

/** Attach a coverage to rows without making it enumerable. */
export function withCoverage<T>(rows: T[], coverage: Coverage): Covered<T> {
  Object.defineProperty(rows, 'coverage', {
    value: coverage,
    enumerable: false,
    writable: false,
    configurable: true,
  })
  return rows as Covered<T>
}

/** The same for anything else a read returns — a `Map` of prices, say. */
export function withCoverageOn<T extends object, C extends Coverage | null>(
  value: T,
  coverage: C,
): T & { readonly coverage: C } {
  Object.defineProperty(value, 'coverage', {
    value: coverage,
    enumerable: false,
    writable: false,
    configurable: true,
  })
  return value as T & { readonly coverage: C }
}

/**
 * Two walks' coverage as one.
 *
 * Used where a single read has to touch two RPCs — "my trades" reads this
 * wallet's offers *and* scans its history for the accepts it wrote — because a
 * caller cares whether the answer is whole, not which of two calls dropped it.
 */
export function mergeCoverage(...parts: readonly (Coverage | null | undefined)[]): Coverage {
  const present = parts.filter((part): part is Coverage => part !== null && part !== undefined)
  if (present.length === 0) return emptyCoverage()
  const failed = present.flatMap((part) => [...part.failed])
  const truncated = [...new Set(present.flatMap((part) => [...part.truncated]))]
  const skipped = [...new Set(present.flatMap((part) => [...part.skipped]))]
  return {
    asked: Math.max(...present.map((part) => part.asked)),
    read: Math.min(...present.map((part) => part.read)),
    failed,
    truncated,
    dropped: Math.max(...present.map((part) => part.dropped)),
    skipped,
    complete: present.every((part) => part.complete),
  }
}

/** True for the refusal a stopped read throws. */
export function isAborted(error: unknown): boolean {
  return error instanceof KeiError && error.code === 'read-aborted'
}

/**
 * Walk one read across the accounts behind a `from`.
 *
 * Addresses that are not addresses are skipped and counted rather than thrown
 * on — `from` is usually a roster, and one bad entry in it is not a reason to
 * blank a market screen. A chain whose read throws is a gap for the same reason:
 * the walk returns what it has and names what it lost.
 */
export async function walkAccounts<T>(
  source: AccountSource,
  read: (account: string) => Promise<AccountRead<T>>,
  options: ReadOptions & { what?: string } = {},
): Promise<Walk<T>> {
  const what = options.what ?? 'This market read'
  const signal = options.signal
  throwIfAborted(signal, what)
  const requested = await untilAborted(
    Promise.resolve().then(() => resolveAccounts(source)),
    signal,
    what,
  )
  const skipped = requested.filter((address) => !isAddress(address))
  const accounts = [...new Set(requested.filter((address) => isAddress(address)))]
  const dropped = directoryDropped(source)

  const answers = await mapConcurrent(
    accounts,
    async (account): Promise<Answer<T>> => {
      try {
        return { ok: true, value: await read(account) }
      } catch (error) {
        if (isAborted(error)) throw error
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },
    options,
  )

  const failed: { account: string; reason: string }[] = []
  const truncated: string[] = []
  const rows: T[] = []
  let ok = 0

  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index] as string
    const answer = answers[index] as Answer<T>
    if (!answer.ok) {
      failed.push({ account, reason: answer.reason })
      continue
    }
    ok += 1
    if (answer.value.truncated) truncated.push(account)
    rows.push(...answer.value.rows)
  }

  return {
    rows,
    accounts,
    coverage: {
      asked: accounts.length,
      read: ok,
      failed,
      truncated,
      dropped,
      skipped,
      complete: failed.length === 0 && truncated.length === 0 && skipped.length === 0 && dropped === 0,
    },
  }
}

/**
 * Run a worker over every item, `concurrency` at a time, answering in order.
 *
 * The ordering is the part worth stating: results land at their item's index, so
 * the answer is identical whichever lane finishes first. A market read whose row
 * order depended on network timing would be a market read nobody could test.
 */
export async function mapConcurrent<I, O>(
  items: readonly I[],
  worker: (item: I, index: number) => Promise<O>,
  options: ReadOptions & { what?: string } = {},
): Promise<O[]> {
  const what = options.what ?? 'This market read'
  const signal = options.signal
  throwIfAborted(signal, what)
  const concurrency = concurrencyOf(options.concurrency)
  if (items.length === 0) return []

  const lanes = Math.min(concurrency, items.length)
  const out = new Array<O>(items.length)
  let next = 0

  const lane = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      throwIfAborted(signal, what)
      out[index] = await worker(items[index] as I, index)
    }
  }

  await untilAborted(
    Promise.all(Array.from({ length: lanes }, () => lane())),
    signal,
    what,
  )
  return out
}

interface Failure {
  ok: false
  reason: string
}

type Answer<T> = { ok: true; value: AccountRead<T> } | Failure

function isCoverage(value: unknown): value is Coverage {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Coverage>
  return (
    isCount(candidate.asked) &&
    isCount(candidate.read) &&
    Array.isArray(candidate.failed) &&
    candidate.failed.every(
      (failure) =>
        typeof failure === 'object' &&
        failure !== null &&
        typeof (failure as { account?: unknown }).account === 'string' &&
        typeof (failure as { reason?: unknown }).reason === 'string',
    ) &&
    Array.isArray(candidate.truncated) &&
    candidate.truncated.every((account) => typeof account === 'string') &&
    isCount(candidate.dropped) &&
    Array.isArray(candidate.skipped) &&
    candidate.skipped.every((account) => typeof account === 'string') &&
    typeof candidate.complete === 'boolean'
  )
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function concurrencyOf(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_CONCURRENCY
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_CONCURRENCY) {
    throw new KeiError(
      'bad-concurrency',
      `concurrency is how many chains to read at once — a whole number from 1 through ${MAX_CONCURRENCY}, and ${DEFAULT_CONCURRENCY} by default. Got ${String(requested)}.`,
    )
  }
  return requested
}

function throwIfAborted(signal: AbortSignal | undefined, what: string): void {
  if (signal?.aborted === true) throw abortError(what, signal)
}

/**
 * Reject as soon as the signal fires rather than when the last lane notices.
 *
 * `work` keeps its own handlers here, so a lane that rejects after the abort is
 * still a handled rejection and never reaches the runtime as an unhandled one.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined, what: string): Promise<T> {
  if (signal === undefined || typeof signal.addEventListener !== 'function') return work
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(what, signal))
    signal.addEventListener('abort', onAbort, { once: true })
    const done = (): void => {
      if (typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
    }
    work.then(
      (value) => {
        done()
        resolve(value)
      },
      (error: unknown) => {
        done()
        reject(error)
      },
    )
  })
}

function abortError(what: string, signal: AbortSignal | undefined): KeiError {
  return new KeiError(
    'read-aborted',
    `${what} was stopped${reasonOf(signal)}. Nothing was signed — a market read only ever reads. Aborting stops further chain reads from starting; one already in flight is not cancelled, because the node contract takes no signal.`,
  )
}

function reasonOf(signal: AbortSignal | undefined): string {
  const reason: unknown = signal?.reason
  if (reason instanceof Error && reason.message !== '') return `: ${reason.message}`
  if (typeof reason === 'string' && reason !== '') return `: ${reason}`
  return ''
}
