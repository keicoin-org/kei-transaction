import { KeiError } from '@keicoin/core'

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

export interface MarketStorageCapabilities {
  readonly durability: 'memory' | 'durable'
  readonly atomicCompareAndSwap: true
  readonly migrations: readonly [1]
}

/**
 * Portable persistence boundary. Replacement must be atomic iff the stored
 * revision equals `expectedRevision`; `null` means no envelope exists.
 */
export interface MarketStorageDriver {
  readonly capabilities: MarketStorageCapabilities
  load(): Promise<unknown>
  compareAndSwap(expectedRevision: number | null, next: MarketStorageEnvelope): Promise<boolean>
}

export interface MemoryMarketStorage extends MarketStorageDriver {
  readonly capabilities: MarketStorageCapabilities & { readonly durability: 'memory' }
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

export function createMemoryMarketStorage(): MemoryMarketStorage {
  let value: MarketStorageEnvelope | null = null
  return {
    capabilities: { durability: 'memory', atomicCompareAndSwap: true, migrations: [1] },
    async load() {
      return value === null ? null : cloneEnvelope(value)
    },
    async compareAndSwap(expectedRevision, next) {
      if ((value?.revision ?? null) !== expectedRevision) return false
      value = cloneEnvelope(next)
      return true
    },
    clear() {
      value = null
    },
  }
}

export interface StorageDeadline {
  readonly signal?: AbortSignal
  readonly deadlineAt: number
  readonly what: string
  readonly now: () => number
}

export async function loadEnvelope(
  driver: MarketStorageDriver,
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
  driver: MarketStorageDriver,
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
    // Once an atomic commit starts, await its truthful acknowledgement. A local
    // timeout cannot un-commit it, so racing it would let a late durable write
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
    observations: value.observations.map((row) => ({ ...row })),
    offers: value.offers.map((row) => ({ ...row, sources: [...row.sources] })),
    checkpoints: value.checkpoints.map((row) => ({ ...row })),
    quarantine: value.quarantine.map((row) => ({ ...row })),
  }
}

function assertDriver(driver: MarketStorageDriver): void {
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
    (value.durability !== 'memory' && value.durability !== 'durable') ||
    value.atomicCompareAndSwap !== true ||
    !Array.isArray(value.migrations) ||
    value.migrations.length !== 1 ||
    value.migrations[0] !== 1
  ) throw storageError('the driver must advertise durability, atomic compare-and-swap, and schema version 1')
}

function validateEnvelope(raw: unknown): MarketStorageEnvelope {
  if (typeof raw !== 'object' || raw === null) throw storageError('the stored envelope is not an object')
  const value = raw as Partial<MarketStorageEnvelope>
  if (value.schema !== 'kei-market-storage' || value.version !== 1) {
    throw storageError('the stored schema/version is unsupported; migrate it atomically before opening this store')
  }
  const revision = storedRevision(value.revision, 'revision')
  const catalogRevision = storedRevision(value.catalogRevision, 'catalog revision', revision)
  const offerRevision = storedRevision(value.offerRevision, 'offer revision', revision)
  return {
    schema: 'kei-market-storage',
    version: 1,
    revision,
    catalogRevision,
    offerRevision,
    observations: boundedObjectArray(value.observations, 'observations', 100_000) as StoredParticipantObservation[],
    offers: boundedObjectArray(value.offers, 'offers', 100_000) as StoredOfferRecord[],
    checkpoints: boundedObjectArray(value.checkpoints, 'checkpoints', 100_000) as StoredSourceCheckpoint[],
    quarantine: boundedObjectArray(value.quarantine, 'quarantine', 1_000) as StoredRejectedRow[],
  }
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
