/**
 * Storage for off-chain claim proofs.
 *
 * A Merkle root cannot reproduce a player's sibling path, so a wallet that
 * wants claims to survive a restart has to retain the bundle itself. Stores
 * receive only public claim metadata: never a seed, private key, signature, or
 * server credential.
 */

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
  remove(scope: ClaimStoreScope, root: string): void | Promise<void>
}

function scopeKey(scope: ClaimStoreScope): string {
  return `${scope.network}\u0000${scope.address}`
}

class MemoryClaimStore implements ClaimStore {
  readonly durability = 'session' as const
  private readonly records = new Map<string, Map<string, string>>()

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
      throw new Error('claim store record limit reached')
    }
    records.set(root, value)
    this.records.set(key, records)
  }

  remove(scope: ClaimStoreScope, root: string): void {
    const key = scopeKey(scope)
    const records = this.records.get(key)
    if (!records) return
    records.delete(root)
    if (records.size === 0) this.records.delete(key)
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

const BROWSER_PREFIX = 'kei:claim:v1:'

function browserScopePrefix(scope: ClaimStoreScope): string {
  return `${BROWSER_PREFIX}${encodeURIComponent(scope.network)}:${encodeURIComponent(scope.address)}:`
}

function browserRecordKey(scope: ClaimStoreScope, root: string): string {
  return `${browserScopePrefix(scope)}${root}`
}

class BrowserClaimStore implements ClaimStore {
  readonly durability = 'persistent' as const

  constructor(private readonly storage: ClaimWebStorage) {}

  list(scope: ClaimStoreScope, limit: number): readonly string[] {
    const prefix = browserScopePrefix(scope)
    const roots: string[] = []
    for (let index = 0; index < this.storage.length && roots.length < limit; index++) {
      const key = this.storage.key(index)
      if (key?.startsWith(prefix)) roots.push(key.slice(prefix.length))
    }
    return roots
  }

  read(scope: ClaimStoreScope, root: string): string | null {
    return this.storage.getItem(browserRecordKey(scope, root))
  }

  write(scope: ClaimStoreScope, root: string, value: string): void {
    const key = browserRecordKey(scope, root)
    if (this.storage.getItem(key) === null && this.list(scope, MAX_PENDING_CLAIMS).length >= MAX_PENDING_CLAIMS) {
      throw new Error('claim store record limit reached')
    }
    this.storage.setItem(key, value)
  }

  remove(scope: ClaimStoreScope, root: string): void {
    this.storage.removeItem(browserRecordKey(scope, root))
  }
}

/**
 * Opt into browser persistence without coupling claims to seed custody.
 * Browser policy and quota failures surface through the claims diagnostics.
 */
export function createBrowserClaimStore(storage: ClaimWebStorage): ClaimStore {
  return new BrowserClaimStore(storage)
}
