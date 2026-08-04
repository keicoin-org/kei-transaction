import { KeiError, randomSeed } from '@keicoin/core'

export interface StoredParticipantObservation {
  readonly network: string
  readonly address: string
  readonly source: string
  readonly observedAt: number
  readonly observationId: string
  readonly base: string | null
  readonly quote: string | null
}

export interface StoredOfferRecord {
  readonly network: string
  readonly hash: string
  readonly author: string
  readonly giveAsset: string
  readonly giveRaw: string
  readonly wantAsset: string
  readonly wantRaw: string
  readonly counterparty: string | null
  readonly state: 'open' | 'accepted' | 'cancelled'
  readonly acceptedBy: string | null
  readonly settledBy: string | null
  readonly height: number
  readonly seenAt: number
  readonly settledAt: number | null
  readonly sources: readonly string[]
  readonly firstObservedAt: number
  readonly lastObservedAt: number
}

export interface StoredSourceCheckpoint {
  readonly key: string
  readonly network: string
  readonly source: string
  readonly account: string
  readonly adapterVersion: number
  readonly generation: number
  readonly base: string | null
  readonly quote: string | null
  readonly observedAt: number
  readonly newestHash: string | null
  readonly providerCursor: string | null
  readonly exhausted: boolean
  readonly stopReason: string
}

export interface StoredRejectedRow {
  readonly network: string
  readonly source: string
  readonly account: string
  readonly observedAt: number
  readonly reason: string
}

/** Versioned envelope used by both catalog and materialized offer store. */
export interface MarketStorageEnvelope {
  readonly schema: 'kei-market-storage'
  readonly version: 1
  /** All commits; used by compare-and-swap. */
  readonly revision: number
  /** Only discovery changes; checkpoint writes do not stale catalog paging. */
  readonly catalogRevision: number
  /** Only canonical offer changes; checkpoint writes do not stale offer paging. */
  readonly offerRevision: number
  readonly observations: readonly StoredParticipantObservation[]
  readonly offers: readonly StoredOfferRecord[]
  readonly checkpoints: readonly StoredSourceCheckpoint[]
  readonly quarantine: readonly StoredRejectedRow[]
}

export interface MarketMemoryStorageCapabilities {
  /** This whole-snapshot contract is intentionally not a production durability claim. */
  readonly durability: 'memory'
  readonly scope: 'process-memory-reference'
  readonly atomicCompareAndSwap: true
  readonly migrations: readonly [1]
}

/**
 * Portable persistence boundary. Replacement must be atomic iff the stored
 * revision equals `expectedRevision`; `null` means no envelope exists.
 */
export interface MarketMemoryStorageAdapter {
  readonly capabilities: MarketMemoryStorageCapabilities
  load(): Promise<unknown>
  compareAndSwap(expectedRevision: number | null, next: MarketStorageEnvelope): Promise<boolean>
}

export interface MemoryMarketStorage extends MarketMemoryStorageAdapter {
  readonly capabilities: MarketMemoryStorageCapabilities
  clear(): void
}

const EMPTY: MarketStorageEnvelope = {
  schema: 'kei-market-storage',
  version: 1,
  revision: 0,
  catalogRevision: 0,
  offerRevision: 0,
  observations: [],
  offers: [],
  checkpoints: [],
  quarantine: [],
}

type CursorSecretState = { readonly secret: string; revision: number }
const CURSOR_STATES = new WeakMap<MarketMemoryStorageAdapter, CursorSecretState>()

/** Process-local signing key shared by catalog/store instances using one adapter. */
export function cursorSecretFor(adapter: MarketMemoryStorageAdapter): string {
  return cursorStateFor(adapter).secret
}

export function cursorRevisionFor(adapter: MarketMemoryStorageAdapter): number {
  return cursorStateFor(adapter).revision
}

function cursorStateFor(adapter: MarketMemoryStorageAdapter): CursorSecretState {
  const existing = CURSOR_STATES.get(adapter)
  if (existing !== undefined) return existing
  const state: CursorSecretState = { secret: randomSeed(), revision: 0 }
  CURSOR_STATES.set(adapter, state)
  return state
}

function cursorResetFor(adapter: MarketMemoryStorageAdapter): void {
  const state = cursorStateFor(adapter)
  CURSOR_STATES.set(adapter, { secret: state.secret, revision: state.revision + 1 })
}

export function createMemoryMarketStorage(): MemoryMarketStorage {
  let value: MarketStorageEnvelope | null = null
  const storage: MemoryMarketStorage = {
    capabilities: { durability: 'memory', scope: 'process-memory-reference', atomicCompareAndSwap: true, migrations: [1] },
    async load() {
      return value === null ? null : cloneEnvelope(value)
    },
    async compareAndSwap(expectedRevision, next) {
      if ((value?.revision ?? null) !== expectedRevision) return false
      value = cloneEnvelope(next)
      return true
    },
    clear() {
      cursorResetFor(storage)
      value = null
    },
  }
  cursorStateFor(storage)
  return storage
}

export interface StorageDeadline {
  readonly signal?: AbortSignal
  readonly deadlineAt: number
  readonly what: string
  readonly now: () => number
}

export async function loadEnvelope(
  driver: MarketMemoryStorageAdapter,
  deadline: StorageDeadline,
): Promise<{ envelope: MarketStorageEnvelope; expectedRevision: number | null }> {
  assertDriver(driver)
  throwIfStopped(deadline)
  const raw = await beforeDeadline(Promise.resolve().then(() => driver.load()), deadline)
  throwIfStopped(deadline)
  if (raw === null || raw === undefined) return { envelope: cloneEnvelope(EMPTY), expectedRevision: null }
  const envelope = validateEnvelope(raw)
  return { envelope, expectedRevision: envelope.revision }
}

export async function updateEnvelope<T>(
  driver: MarketMemoryStorageAdapter,
  deadline: StorageDeadline,
  change: (current: MarketStorageEnvelope) => {
    readonly next: Omit<MarketStorageEnvelope, 'revision'>
    readonly value: T
  },
): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const loaded = await loadEnvelope(driver, deadline)
    const changed = change(loaded.envelope)
    throwIfStopped(deadline)
    const next: MarketStorageEnvelope = { ...changed.next, revision: loaded.envelope.revision + 1 }
    // Never persist a snapshot that this SDK cannot open on its very next read.
    // This catches every envelope row/revision ceiling before compare-and-swap.
    validateEnvelope(next)
    // Once an atomic commit starts, await its truthful acknowledgement. A local
    // timeout cannot un-commit it, so racing it would let a late adapter write
    // happen after this SDK falsely returned failure.
    const committed = await Promise.resolve().then(() =>
      driver.compareAndSwap(loaded.expectedRevision, cloneEnvelope(next)),
    )
    if (committed === true) return changed.value
    if (committed !== false) throw storageError('compareAndSwap() must resolve to a boolean')
  }
  throw new KeiError(
    'market-storage-conflict',
    'The market storage changed during eight atomic commit attempts. Retry after the competing writer settles; no partial row/checkpoint commit was accepted by this SDK.',
  )
}

export function cloneEnvelope(value: MarketStorageEnvelope): MarketStorageEnvelope {
  return {
    schema: 'kei-market-storage',
    version: 1,
    revision: value.revision,
    catalogRevision: value.catalogRevision,
    offerRevision: value.offerRevision,
    observations: value.observations.map((row) => ({
      network: row.network,
      address: row.address,
      source: row.source,
      observedAt: row.observedAt,
      observationId: row.observationId,
      base: row.base,
      quote: row.quote,
    })),
    offers: value.offers.map((row) => ({
      network: row.network,
      hash: row.hash,
      author: row.author,
      giveAsset: row.giveAsset,
      giveRaw: row.giveRaw,
      wantAsset: row.wantAsset,
      wantRaw: row.wantRaw,
      counterparty: row.counterparty,
      state: row.state,
      acceptedBy: row.acceptedBy,
      settledBy: row.settledBy,
      height: row.height,
      seenAt: row.seenAt,
      settledAt: row.settledAt,
      sources: [...row.sources],
      firstObservedAt: row.firstObservedAt,
      lastObservedAt: row.lastObservedAt,
    })),
    checkpoints: value.checkpoints.map((row) => ({
      key: row.key,
      network: row.network,
      source: row.source,
      account: row.account,
      adapterVersion: row.adapterVersion,
      generation: row.generation,
      base: row.base,
      quote: row.quote,
      observedAt: row.observedAt,
      newestHash: row.newestHash,
      providerCursor: row.providerCursor,
      exhausted: row.exhausted,
      stopReason: row.stopReason,
    })),
    quarantine: value.quarantine.map((row) => ({
      network: row.network,
      source: row.source,
      account: row.account,
      observedAt: row.observedAt,
      reason: row.reason,
    })),
  }
}

function assertDriver(driver: MarketMemoryStorageAdapter): void {
  if (
    typeof driver !== 'object' ||
    driver === null ||
    typeof driver.load !== 'function' ||
    typeof driver.compareAndSwap !== 'function'
  ) throw storageError('the driver must provide load() and compareAndSwap()')
  const value = driver.capabilities
  if (
    typeof value !== 'object' ||
    value === null ||
    value.durability !== 'memory' ||
    value.scope !== 'process-memory-reference' ||
    value.atomicCompareAndSwap !== true ||
    !Array.isArray(value.migrations) ||
    value.migrations.length !== 1 ||
    value.migrations[0] !== 1
  ) throw storageError('the adapter must be the process-memory reference, provide atomic compare-and-swap, and support schema version 1')
}

function validateEnvelope(raw: unknown): MarketStorageEnvelope {
  const schema = storageOwnValue(raw, 'schema')
  const version = storageOwnValue(raw, 'version')
  if (schema !== 'kei-market-storage' || version !== 1) {
    throw storageError('the stored schema/version is unsupported; migrate it atomically before opening this store')
  }
  const revision = storedRevision(storageOwnValue(raw, 'revision'), 'revision')
  const catalogRevision = storedRevision(storageOwnValue(raw, 'catalogRevision'), 'catalog revision', revision)
  const offerRevision = storedRevision(storageOwnValue(raw, 'offerRevision'), 'offer revision', revision)
  return {
    schema: 'kei-market-storage',
    version: 1,
    revision,
    catalogRevision,
    offerRevision,
    observations: boundedObjectArray(storageOwnValue(raw, 'observations'), 'observations', 100_000) as StoredParticipantObservation[],
    offers: boundedObjectArray(storageOwnValue(raw, 'offers'), 'offers', 100_000) as StoredOfferRecord[],
    checkpoints: boundedObjectArray(storageOwnValue(raw, 'checkpoints'), 'checkpoints', 100_000) as StoredSourceCheckpoint[],
    quarantine: boundedObjectArray(storageOwnValue(raw, 'quarantine'), 'quarantine', 1_000) as StoredRejectedRow[],
  }
}

function storageOwnValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw storageError('the stored envelope must be a plain own-property record')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw storageError('the stored envelope cannot inherit fields')
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw storageError(`stored ${key} must be an own data property`)
  return descriptor.value
}

function storedRevision(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw storageError(`the stored ${label} is not a valid non-negative revision`)
  }
  return value as number
}

function boundedObjectArray(value: unknown, name: string, maximum: number): object[] {
  if (!Array.isArray(value)) throw storageError(`stored ${name} must be an array`)
  const length: unknown = value.length
  if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maximum) {
    throw storageError(`stored ${name} exceeds its ${maximum}-row validation budget`)
  }
  const rows: object[] = []
  for (let index = 0; index < (length as number); index += 1) {
    if (!Object.hasOwn(value, index)) throw storageError(`stored ${name} contains a sparse row at ${index}`)
    const row: unknown = value[index]
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw storageError(`stored ${name}[${index}] is not a record`)
    }
    const prototype = Object.getPrototypeOf(row)
    if (prototype !== Object.prototype && prototype !== null) {
      throw storageError(`stored ${name}[${index}] must be a plain own-property record`)
    }
    // Never spread an adapter row: extra enumerable getters could make schema
    // validation unbounded. Consumers copy only their documented fields.
    rows.push(row)
  }
  return rows
}

export function throwIfStopped(deadline: StorageDeadline): void {
  if (deadline.signal?.aborted === true) {
    throw new KeiError('read-aborted', `${deadline.what} was stopped. No new storage or source work was started.`)
  }
  if (safeNow(deadline) >= deadline.deadlineAt) {
    throw new KeiError('market-deadline', `${deadline.what} exceeded its total deadline. No new storage or source work was started.`)
  }
}

async function beforeDeadline<T>(work: Promise<T>, deadline: StorageDeadline): Promise<T> {
  throwIfStopped(deadline)
  const remaining = Math.max(0, deadline.deadlineAt - safeNow(deadline))
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const stopped = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new KeiError('market-deadline', `${deadline.what} exceeded its total deadline.`)),
      Math.min(remaining, 2_147_483_647),
    )
    if (deadline.signal && typeof deadline.signal.addEventListener === 'function') {
      onAbort = () => reject(new KeiError('read-aborted', `${deadline.what} was stopped.`))
      deadline.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  try {
    return await Promise.race([work, stopped])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort && typeof deadline.signal?.removeEventListener === 'function') {
      deadline.signal.removeEventListener('abort', onAbort)
    }
  }
}

function safeNow(deadline: StorageDeadline): number {
  let value: unknown
  try {
    value = deadline.now()
  } catch {
    throw new KeiError('bad-market-clock', `${deadline.what} cannot use a clock that throws.`)
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new KeiError('bad-market-clock', `${deadline.what} needs a non-negative safe whole-millisecond clock.`)
  }
  return value as number
}

function storageError(problem: string): KeiError {
  return new KeiError(
    'bad-market-storage',
    `The market storage is unsafe: ${problem}. No stored observations or checkpoints were trusted or changed.`,
  )
}
