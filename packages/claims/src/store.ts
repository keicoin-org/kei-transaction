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

const BROWSER_PREFIX = 'kei:claim-store:v1:'
const BROWSER_NAMESPACE_VERSION = 1

function browserNamespaceKey(scope: ClaimStoreScope): string {
  return `${BROWSER_PREFIX}${encodeURIComponent(scope.network)}:${encodeURIComponent(scope.address)}`
}

interface BrowserNamespace {
  readonly version: number
  readonly records: readonly (readonly [root: string, value: string])[]
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
  if (namespace.version !== BROWSER_NAMESPACE_VERSION) throw new Error('claim store namespace version is unsupported')
  if (!Array.isArray(namespace.records) || namespace.records.length > MAX_PENDING_CLAIMS) {
    throw new Error('claim store namespace is corrupt')
  }
  const roots = new Set<string>()
  for (const record of namespace.records) {
    if (!Array.isArray(record) || record.length !== 2 ||
        typeof record[0] !== 'string' || typeof record[1] !== 'string' || roots.has(record[0])) {
      throw new Error('claim store namespace is corrupt')
    }
    roots.add(record[0])
  }
  return namespace as BrowserNamespace
}

class BrowserClaimStore implements ClaimStore {
  readonly durability = 'persistent' as const

  constructor(private readonly storage: ClaimWebStorage) {}

  private load(scope: ClaimStoreScope): BrowserNamespace {
    return parseBrowserNamespace(this.storage.getItem(browserNamespaceKey(scope)))
  }

  list(scope: ClaimStoreScope, limit: number): readonly string[] {
    return this.load(scope).records.slice(0, Math.max(0, limit)).map(([root]) => root)
  }

  read(scope: ClaimStoreScope, root: string): string | null {
    return this.load(scope).records.find(([candidate]) => candidate === root)?.[1] ?? null
  }

  write(scope: ClaimStoreScope, root: string, value: string): void {
    const key = browserNamespaceKey(scope)
    const records = [...this.load(scope).records]
    const existing = records.findIndex(([candidate]) => candidate === root)
    if (existing === -1 && records.length >= MAX_PENDING_CLAIMS) {
      throw new Error('claim store record limit reached')
    }
    if (existing === -1) records.push([root, value])
    else records[existing] = [root, value]
    // localStorage serialises one setItem atomically. Keeping the complete,
    // bounded namespace in that one value means stale concurrent writers can
    // replace one another, but can never publish a 129th visible record.
    this.storage.setItem(key, JSON.stringify({ version: BROWSER_NAMESPACE_VERSION, records }))
  }

  remove(scope: ClaimStoreScope, root: string): void {
    const key = browserNamespaceKey(scope)
    const records = this.load(scope).records.filter(([candidate]) => candidate !== root)
    if (records.length === 0) this.storage.removeItem(key)
    else this.storage.setItem(key, JSON.stringify({ version: BROWSER_NAMESPACE_VERSION, records }))
  }
}

/**
 * Opt into browser persistence without coupling claims to seed custody.
 * Browser policy and quota failures surface through the claims diagnostics.
 */
export function createBrowserClaimStore(storage: ClaimWebStorage): ClaimStore {
  return new BrowserClaimStore(storage)
}
