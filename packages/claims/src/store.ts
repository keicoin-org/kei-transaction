/**
 * Storage for off-chain claim proofs.
 *
 * A Merkle root cannot reproduce a player's sibling path, so a wallet that
 * wants claims to survive a restart has to retain the bundle itself. Stores
 * receive only public claim metadata and a scoped wallet signature: never a
 * seed, private key, or server credential.
 */

import {
  claimStoreAdmissionHash,
  isHex,
  publicKeyFromAddress,
  verifyHash,
} from '@keicoin/core'

export type ClaimStoreDurability = 'persistent' | 'session'
export const MAX_PENDING_CLAIMS = 128

export interface ClaimStoreScope {
  readonly network: string
  readonly address: string
}

export interface ClaimStore {
  /** What the adapter itself promises. Every write is still read back. */
  readonly durability: ClaimStoreDurability
  /** Return at most `limit` roots in this wallet/network namespace. */
  list(scope: ClaimStoreScope, limit: number): readonly string[] | Promise<readonly string[]>
  read(scope: ClaimStoreScope, root: string): string | null | Promise<string | null>
  /** Adapters must enforce the finite per-scope record count atomically. */
  write(scope: ClaimStoreScope, root: string, value: string): void | Promise<void>
  /**
   * Atomically retain and admit exactly `value` at `root`. A false/failed
   * admission MUST leave no value visible through `readAdmitted`; implementations
   * must also enforce the per-scope record limit inside this operation.
   * Older custom adapters may omit this capability; the claims API then fails
   * closed before mutation.
   */
  admit?(
    scope: ClaimStoreScope,
    root: string,
    value: string,
    /** Wallet signature over the scoped root and exact value, when required. */
    authority?: string,
  ): boolean | Promise<boolean>
  /** Return bytes only when the adapter durably admitted that exact value. */
  readAdmitted?(scope: ClaimStoreScope, root: string): string | null | Promise<string | null>
  remove(scope: ClaimStoreScope, root: string): void | Promise<void>
}

function scopeKey(scope: ClaimStoreScope): string {
  return `${scope.network}\u0000${scope.address}`
}

class ClaimStoreCapacityError extends Error {}

/** Recognise only the built-in adapter's bounded, non-secret capacity signal. */
export function isClaimStoreCapacityError(error: unknown): boolean {
  return error instanceof ClaimStoreCapacityError
}

class MemoryClaimStore implements ClaimStore {
  readonly durability = 'session' as const
  private readonly records = new Map<string, Map<string, string>>()
  private readonly admitted = new Map<string, Set<string>>()

  list(scope: ClaimStoreScope, limit: number): readonly string[] {
    return [...(this.records.get(scopeKey(scope))?.keys() ?? [])].slice(0, limit)
  }

  read(scope: ClaimStoreScope, root: string): string | null {
    return this.records.get(scopeKey(scope))?.get(root) ?? null
  }

  write(scope: ClaimStoreScope, root: string, value: string): void {
    const key = scopeKey(scope)
    const records = this.records.get(key) ?? new Map<string, string>()
    if (!records.has(root) && records.size >= MAX_PENDING_CLAIMS) {
      throw new ClaimStoreCapacityError('claim store record limit reached')
    }
    records.set(root, value)
    this.records.set(key, records)
    this.admitted.get(key)?.delete(root)
  }

  admit(scope: ClaimStoreScope, root: string, value: string): boolean {
    const key = scopeKey(scope)
    const records = this.records.get(key) ?? new Map<string, string>()
    if (this.admitted.get(key)?.has(root)) return records.get(root) === value
    if (!records.has(root) && records.size >= MAX_PENDING_CLAIMS) {
      throw new ClaimStoreCapacityError('claim store record limit reached')
    }
    records.set(root, value)
    this.records.set(key, records)
    const roots = this.admitted.get(key) ?? new Set<string>()
    roots.add(root)
    this.admitted.set(key, roots)
    return true
  }

  readAdmitted(scope: ClaimStoreScope, root: string): string | null {
    const key = scopeKey(scope)
    if (!this.admitted.get(key)?.has(root)) return null
    return this.records.get(key)?.get(root) ?? null
  }

  remove(scope: ClaimStoreScope, root: string): void {
    const key = scopeKey(scope)
    const records = this.records.get(key)
    if (!records) return
    records.delete(root)
    this.admitted.get(key)?.delete(root)
    if (records.size === 0) this.records.delete(key)
    if (this.admitted.get(key)?.size === 0) this.admitted.delete(key)
  }
}

/** A fresh session-only store. Share it explicitly to share claims in-process. */
export function createMemoryClaimStore(): ClaimStore {
  return new MemoryClaimStore()
}

/** The localStorage surface needed by the opt-in browser adapter. */
export interface ClaimWebStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * The small Web Locks surface used to serialize one wallet/network namespace.
 * Pass a shared deterministic implementation in tests; browsers use
 * `navigator.locks` when this option is omitted.
 */
export interface ClaimWebLockManager {
  request<T>(name: string, callback: () => T | PromiseLike<T>): Promise<T>
}

export interface BrowserClaimStoreOptions {
  /** `null` explicitly disables locking and makes every operation fail closed. */
  readonly lockManager?: ClaimWebLockManager | null
}

const BROWSER_PREFIX = 'kei:claim-store:v1:'
const BROWSER_NAMESPACE_VERSION = 4

async function hasWalletAuthority(
  scope: ClaimStoreScope,
  root: string,
  value: string,
  authority: string | null | undefined,
): Promise<boolean> {
  if (!isHex(authority, 64)) return false
  try {
    return await verifyHash(
      claimStoreAdmissionHash(scope.network, scope.address, root, value),
      authority,
      publicKeyFromAddress(scope.address),
    )
  } catch {
    return false
  }
}

function browserNamespaceKey(scope: ClaimStoreScope): string {
  return `${BROWSER_PREFIX}${encodeURIComponent(scope.network)}:${encodeURIComponent(scope.address)}`
}

function browserLockKey(scope: ClaimStoreScope): string {
  return `${browserNamespaceKey(scope)}:lock`
}

function defaultBrowserLockManager(): ClaimWebLockManager | null {
  const candidate = (globalThis as {
    navigator?: { locks?: { request?: unknown } }
  }).navigator?.locks
  if (!candidate || typeof candidate.request !== 'function') return null
  return {
    request<T>(name: string, callback: () => T | PromiseLike<T>): Promise<T> {
      const request = candidate.request as (
        this: unknown,
        lockName: string,
        locked: () => T | PromiseLike<T>,
      ) => PromiseLike<T>
      return Promise.resolve(request.call(candidate, name, callback))
    },
  }
}

interface BrowserNamespace {
  readonly version: number
  readonly records: readonly (readonly [root: string, value: string, admission: string | null])[]
}

function parseBrowserNamespace(raw: string | null): BrowserNamespace {
  if (raw === null) return { version: BROWSER_NAMESPACE_VERSION, records: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('claim store namespace is corrupt')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('claim store namespace is corrupt')
  const namespace = parsed as { version?: unknown; records?: unknown }
  if (namespace.version !== 1 && namespace.version !== 2 && namespace.version !== 3 &&
      namespace.version !== BROWSER_NAMESPACE_VERSION) {
    throw new Error('claim store namespace version is unsupported')
  }
  if (!Array.isArray(namespace.records) || namespace.records.length > MAX_PENDING_CLAIMS) {
    throw new Error('claim store namespace is corrupt')
  }
  const roots = new Set<string>()
  const records: [string, string, string | null][] = []
  for (const record of namespace.records) {
    const legacy = namespace.version === 1
    if (!Array.isArray(record) || record.length !== (legacy ? 2 : 3) ||
        typeof record[0] !== 'string' || typeof record[1] !== 'string' ||
        (namespace.version === 2 && typeof record[2] !== 'boolean') ||
        (namespace.version === 3 && record[2] !== null && typeof record[2] !== 'string') ||
        (namespace.version === BROWSER_NAMESPACE_VERSION &&
          record[2] !== null && typeof record[2] !== 'string') || roots.has(record[0])) {
      throw new Error('claim store namespace is corrupt')
    }
    roots.add(record[0])
    // Boolean markers and unkeyed digests do not prove wallet authority.
    // Preserve legacy candidates for explicit re-add, but never infer admission.
    records.push([
      record[0],
      record[1],
      namespace.version === BROWSER_NAMESPACE_VERSION ? record[2] as string | null : null,
    ])
  }
  return { version: BROWSER_NAMESPACE_VERSION, records }
}

class BrowserClaimStore implements ClaimStore {
  readonly durability = 'persistent' as const

  constructor(
    private readonly storage: ClaimWebStorage,
    private readonly lockManager: ClaimWebLockManager | null,
  ) {}

  private withLock<T>(scope: ClaimStoreScope, operation: () => T | PromiseLike<T>): Promise<T> {
    if (!this.lockManager) {
      return Promise.reject(new Error('browser claim storage requires the Web Locks API'))
    }
    return this.lockManager.request(browserLockKey(scope), operation)
  }

  private load(scope: ClaimStoreScope): BrowserNamespace {
    return parseBrowserNamespace(this.storage.getItem(browserNamespaceKey(scope)))
  }

  list(scope: ClaimStoreScope, limit: number): Promise<readonly string[]> {
    return this.withLock(scope, () =>
      this.load(scope).records.slice(0, Math.max(0, limit)).map(([root]) => root))
  }

  read(scope: ClaimStoreScope, root: string): Promise<string | null> {
    return this.withLock(scope, () =>
      this.load(scope).records.find(([candidate]) => candidate === root)?.[1] ?? null)
  }

  readAdmitted(scope: ClaimStoreScope, root: string): Promise<string | null> {
    return this.withLock<string | null>(scope, async () => {
      const record = this.load(scope).records.find(([candidate]) => candidate === root)
      return record && await hasWalletAuthority(scope, root, record[1], record[2])
        ? record[1]
        : null
    })
  }

  write(scope: ClaimStoreScope, root: string, value: string): Promise<void> {
    return this.withLock(scope, () => {
      const key = browserNamespaceKey(scope)
      const records = [...this.load(scope).records]
      const existing = records.findIndex(([candidate]) => candidate === root)
      if (existing === -1 && records.length >= MAX_PENDING_CLAIMS) {
        throw new ClaimStoreCapacityError('claim store record limit reached')
      }
      if (existing === -1) records.push([root, value, null])
      else records[existing] = [root, value, null]
      this.storage.setItem(key, JSON.stringify({ version: BROWSER_NAMESPACE_VERSION, records }))
    })
  }

  admit(scope: ClaimStoreScope, root: string, value: string, authority?: string): Promise<boolean> {
    return this.withLock<boolean>(scope, async () => {
      if (!await hasWalletAuthority(scope, root, value, authority)) return false
      const key = browserNamespaceKey(scope)
      const records = [...this.load(scope).records]
      const existing = records.findIndex(([candidate]) => candidate === root)
      const existingRecord = records[existing]
      if (existingRecord && await hasWalletAuthority(
        scope,
        root,
        existingRecord[1],
        existingRecord[2],
      )) {
        return existingRecord[1] === value
      }
      if (existing === -1 && records.length >= MAX_PENDING_CLAIMS) {
        throw new ClaimStoreCapacityError('claim store record limit reached')
      }
      if (existing === -1) records.push([root, value, null])
      else records[existing] = [root, value, null]
      this.storage.setItem(key, JSON.stringify({ version: BROWSER_NAMESPACE_VERSION, records }))
      const candidateRecords = [...this.load(scope).records]
      const candidate = candidateRecords.findIndex(([storedRoot]) => storedRoot === root)
      if (candidate === -1 || candidateRecords[candidate]?.[1] !== value ||
          candidateRecords[candidate]?.[2] !== null) {
        return candidate !== -1 && candidateRecords[candidate]?.[1] === value &&
          await hasWalletAuthority(
            scope,
            root,
            candidateRecords[candidate]?.[1] as string,
            candidateRecords[candidate]?.[2],
          )
      }
      candidateRecords[candidate] = [root, value, authority as string]
      this.storage.setItem(key, JSON.stringify({
        version: BROWSER_NAMESPACE_VERSION,
        records: candidateRecords,
      }))
      const admitted = this.load(scope).records.find(([storedRoot]) => storedRoot === root)
      // `authority` was verified before mutation. Exact read-back proves the
      // storage layer did not replace either the bytes or their signature.
      return admitted?.[1] === value && admitted[2] === authority
    })
  }

  remove(scope: ClaimStoreScope, root: string): Promise<void> {
    return this.withLock(scope, () => {
      const key = browserNamespaceKey(scope)
      const records = this.load(scope).records.filter(([candidate]) => candidate !== root)
      if (records.length === 0) this.storage.removeItem(key)
      else this.storage.setItem(key, JSON.stringify({ version: BROWSER_NAMESPACE_VERSION, records }))
    })
  }
}

/**
 * Opt into browser persistence without coupling claims to seed custody.
 * Browser policy and quota failures surface through the claims diagnostics.
 */
export function createBrowserClaimStore(
  storage: ClaimWebStorage,
  options: BrowserClaimStoreOptions = {},
): ClaimStore {
  const lockManager = options.lockManager === undefined
    ? defaultBrowserLockManager()
    : options.lockManager
  return new BrowserClaimStore(storage, lockManager)
}
