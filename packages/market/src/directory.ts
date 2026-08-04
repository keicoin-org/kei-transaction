/**
 * Which chains to read.
 *
 * `market.offers()` requires a `from`, and that requirement is correct: an offer
 * is a block on its author's chain, so "every listing on the network" is an
 * indexer and SPEC §9.4 says Kei does not ship one. What the requirement leaves
 * to the caller is the part nobody can avoid — *remembering* which accounts are
 * worth asking — and every application that has used this package has written
 * the same set with the same three properties and, in one case, without the
 * bound that keeps it affordable.
 *
 * So it is here now, and it is deliberately small. A directory is a list of
 * addresses. It is not an oracle, it holds no balances, and nothing read through
 * it is trusted: every offer it leads to is re-read off the chain before anybody
 * signs against it, which is what makes a wrong directory able to hide a listing
 * and unable to cost anybody an asset.
 *
 * The bound matters more than it looks. `watch` is usually reachable from an
 * unauthenticated route, so without a ceiling the cost of every read is set by
 * whoever last posted to it. Evicting the least recently heard-from is the right
 * loss — they are the accounts least likely to hold a live listing, and hearing
 * from them again puts them straight back — but it is a loss, so the count is
 * reported rather than swallowed (see `Coverage` in `book.ts`).
 */

import { KeiError, isAddress } from '@keicoin/core'

/**
 * Somewhere to get a list of accounts from.
 *
 * An application that already has its roster in a database implements this in
 * four lines and never touches `createDirectory`.
 */
export interface AccountDirectory {
  accounts(): readonly string[] | Promise<readonly string[]>
  /** How many the directory currently holds, when it knows. */
  readonly size?: number
  /** How many it has evicted to stay inside its bound, when it has one. */
  readonly dropped?: number
}

/** Anywhere a bounded walk can take its accounts from. */
export type AccountSource = string | readonly string[] | AccountDirectory

export interface MutableDirectory extends AccountDirectory {
  /**
   * Announce an account whose chain may carry an offer. Returns false for
   * anything that is not an address, because this is usually fed by a route.
   *
   * Re-announcing an address already held is not a no-op: it moves that address
   * to the newest end of the eviction order, which is the whole reason the
   * roster survives a busy market.
   */
  watch(address: string): boolean
  forget(address: string): boolean
  accounts(): readonly string[]
  clear(): void
  readonly size: number
  readonly limit: number
  readonly dropped: number
}

export interface DirectoryOptions {
  /**
   * How many accounts to keep. Positive safe integer, 1–256; default 128.
   *
   * Chosen against what a walk costs rather than against how many players a
   * world might have: a book is one `account_swaps` call per account, so this is
   * a ceiling of ~128 node calls per read. Far above any session a game template
   * will see, and still a request that finishes. Invalid or larger values throw
   * `bad-directory-limit` before `accounts` is touched.
   */
  limit?: number
  /** Addresses to start with. Anything that is not an address is skipped. */
  accounts?: Iterable<string>
}

export const DEFAULT_DIRECTORY_LIMIT = 128

/**
 * Largest roster the built-in directory may retain.
 *
 * Two default-sized directories are already 256 node calls in one refresh.
 * Larger markets need explicit sharding or pagination rather than a number that
 * lets an unauthenticated announcement route set every future read's cost.
 * This is also the absolute account ceiling for one walk (see `walk.ts`).
 */
export const MAX_DIRECTORY_LIMIT = 256

export function createDirectory(options: DirectoryOptions = {}): MutableDirectory {
  // Validate before even reading `options.accounts`: it is a public Iterable
  // and may run code, throw, or never end when touched.
  const limit = directoryLimitOf(options.limit)
  // A Map rather than a Set because insertion order is what bounds it: the first
  // key is the address heard from longest ago.
  const held = new Map<string, true>()
  let dropped = 0

  const directory: MutableDirectory = {
    watch(address) {
      if (typeof address !== 'string' || !isAddress(address)) return false
      held.delete(address)
      held.set(address, true)
      while (held.size > limit) {
        const oldest = held.keys().next()
        if (oldest.done) break
        held.delete(oldest.value)
        dropped += 1
      }
      return true
    },
    forget(address) {
      return held.delete(address)
    },
    accounts() {
      return [...held.keys()]
    },
    clear() {
      held.clear()
    },
    get size() {
      return held.size
    },
    get limit() {
      return limit
    },
    get dropped() {
      return dropped
    },
  }

  for (const address of options.accounts ?? []) directory.watch(address)
  return directory
}

/** Resolve the retained-account ceiling without coercion or an unlimited escape. */
function directoryLimitOf(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_DIRECTORY_LIMIT
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > MAX_DIRECTORY_LIMIT) {
    throw new KeiError(
      'bad-directory-limit',
      `Directory limit is how many announced accounts to retain — a positive safe whole number from 1 through ${MAX_DIRECTORY_LIMIT}, and ${DEFAULT_DIRECTORY_LIMIT} by default. Got ${String(requested)}. Split a larger market into explicit directories or pages; no initial accounts were read.`,
    )
  }
  return requested
}

export function isDirectory(source: unknown): source is AccountDirectory {
  return typeof source === 'object' && source !== null && typeof (source as AccountDirectory).accounts === 'function'
}

/** The accounts behind any of the three shapes a `from` can take. */
export async function resolveAccounts(source: AccountSource): Promise<string[]> {
  if (typeof source === 'string') return [source]
  if (isDirectory(source)) return [...(await source.accounts())]
  return [...source]
}

/** What a directory admits about itself, or nothing when it is a plain list. */
export function directoryDropped(source: AccountSource): number {
  if (!isDirectory(source)) return 0
  const dropped = source.dropped ?? 0
  if (!Number.isSafeInteger(dropped) || dropped < 0) {
    throw new KeiError(
      'bad-account-source',
      `An account directory's dropped count must be a non-negative safe whole number when present, not ${String(dropped)}. Fix the directory before using its coverage; no account chains were read.`,
    )
  }
  return dropped
}
