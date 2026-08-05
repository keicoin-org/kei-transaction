import { KeiError, randomSeed } from '@keicoin/core'

/** The envelope shape this build writes. Older stored versions migrate on load. */
export const MARKET_STORAGE_SCHEMA_VERSION = 2

/**
 * What an adapter promises about the bytes it holds.
 *
 * `memory` is a reference adapter and a test double. `durable` is a claim the
 * SDK checks rather than repeats: every commit through a durable adapter is
 * read back before this package reports it as stored.
 */
export type MarketDurability = 'memory' | 'durable'

export interface StoredParticipantObservation {
  readonly network: string
  readonly address: string
  readonly source: string
  /** Newest observation time folded into this row. */
  readonly observedAt: number
  /** Oldest observation time folded into this row. */
  readonly firstObservedAt: number
  /** How many announcements this row stands for. Compaction folds, never forgets. */
  readonly observations: number
  /** Null once compaction folded this row and its per-announcement identity. */
  readonly observationId: string | null
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

/**
 * What compaction has done to this store, for the whole life of the envelope.
 *
 * Counters saturate rather than overflow, and every page carries them: a store
 * with a bound has thrown something away, and a read over it cannot describe
 * itself as complete knowledge of everything ever observed.
 */
export interface MarketRetentionReport {
  /** Announcements merged into a surviving per-participant row. */
  readonly foldedObservations: number
  /** Folded discovery rows evicted because folding could not reach the bound. */
  readonly droppedObservations: number
  /** Canonical offer rows evicted, settled ones first. */
  readonly droppedOffers: number
  /** Source watermarks evicted, oldest observation first. */
  readonly droppedCheckpoints: number
  /** Diagnostic rows evicted, oldest first. */
  readonly droppedQuarantine: number
}

/** Versioned envelope used by both catalog and materialized offer store. */
export interface MarketStorageEnvelope {
  readonly schema: 'kei-market-storage'
  readonly version: typeof MARKET_STORAGE_SCHEMA_VERSION
  /** All commits; used by compare-and-swap. */
  readonly revision: number
  /** Only discovery changes; checkpoint writes do not stale catalog paging. */
  readonly catalogRevision: number
  /** Only canonical offer changes; checkpoint writes do not stale offer paging. */
  readonly offerRevision: number
  /**
   * Cursor-signing key, stored so an opaque page cursor outlives the process
   * that issued it. Clearing or replacing the envelope invalidates every cursor
   * signed by the old key, which is the honest outcome: those row keys no
   * longer describe this store.
   */
  readonly cursorKey: string
  readonly observations: readonly StoredParticipantObservation[]
  readonly offers: readonly StoredOfferRecord[]
  readonly checkpoints: readonly StoredSourceCheckpoint[]
  readonly quarantine: readonly StoredRejectedRow[]
  readonly retention: MarketRetentionReport
}

export interface MarketStorageCapabilities {
  readonly durability: MarketDurability
  /** Bounded label for where the bytes live, e.g. `indexeddb:kei-market`. */
  readonly scope: string
  readonly atomicCompareAndSwap: true
  /** Ascending schema versions this adapter accepts; it must accept the current one. */
  readonly migrations: readonly number[]
}

/**
 * Portable persistence boundary. Replacement must be atomic iff the stored
 * revision equals `expectedRevision`; `null` means no envelope exists.
 *
 * Nothing here is Node-only, browser-only, or Workers-only: an IndexedDB object
 * store, a Durable Object transaction, and a SQLite row all satisfy it, and the
 * SDK holds no credentials for any of them.
 */
export interface MarketStorageAdapter {
  readonly capabilities: MarketStorageCapabilities
  load(): Promise<unknown>
  compareAndSwap(expectedRevision: number | null, next: MarketStorageEnvelope): Promise<boolean>
}

/** @deprecated Name kept for 0.5 callers. Use `MarketStorageCapabilities`. */
export type MarketMemoryStorageCapabilities = MarketStorageCapabilities
/** @deprecated Name kept for 0.5 callers. Use `MarketStorageAdapter`. */
export type MarketMemoryStorageAdapter = MarketStorageAdapter

export interface MemoryMarketStorage extends MarketStorageAdapter {
  clear(): void
}

/**
 * How much this store keeps.
 *
 * Every table has a bound and a compaction path, because a market catalog that
 * only grows is a leak with a schema. Discovery rows fold into one row per
 * participant, instrument, and source before anything is evicted, so a bounded
 * live roster does not erase the fact that an address ever traded.
 */
export interface MarketRetention {
  /** Discovery rows kept before folding, then eviction. Default 5,000. */
  readonly maxObservations: number
  /** Canonical offer rows kept. Settled rows compact before open ones. Default 10,000. */
  readonly maxOffers: number
  /** Source watermarks kept, per network/source/version/account/filter. Default 10,000. */
  readonly maxCheckpoints: number
  /** Rejected-row diagnostics kept. Default 1,000. */
  readonly maxQuarantine: number
}

export const DEFAULT_MARKET_RETENTION: MarketRetention = {
  maxObservations: 5_000,
  maxOffers: 10_000,
  maxCheckpoints: 10_000,
  maxQuarantine: 1_000,
}

/** Absolute ceilings. A bound above one of these could not be validated on load. */
export const MAX_MARKET_RETENTION: MarketRetention = {
  maxObservations: 100_000,
  maxOffers: 100_000,
  maxCheckpoints: 100_000,
  maxQuarantine: 1_000,
}

const EMPTY_RETENTION: MarketRetentionReport = {
  foldedObservations: 0,
  droppedObservations: 0,
  droppedOffers: 0,
  droppedCheckpoints: 0,
  droppedQuarantine: 0,
}

export function retentionOf(input?: Partial<MarketRetention>): MarketRetention {
  if (input !== undefined && (typeof input !== 'object' || input === null)) {
    throw new KeiError('bad-market-budget', 'Market retention must be an object of positive whole-number row bounds.')
  }
  const requested = input ?? {}
  return {
    maxObservations: retentionBound(requested.maxObservations, 'maxObservations'),
    maxOffers: retentionBound(requested.maxOffers, 'maxOffers'),
    maxCheckpoints: retentionBound(requested.maxCheckpoints, 'maxCheckpoints'),
    maxQuarantine: retentionBound(requested.maxQuarantine, 'maxQuarantine'),
  }
}

function retentionBound(value: number | undefined, key: keyof MarketRetention): number {
  const chosen = value ?? DEFAULT_MARKET_RETENTION[key]
  if (!Number.isSafeInteger(chosen) || chosen < 1 || chosen > MAX_MARKET_RETENTION[key]) {
    throw new KeiError(
      'bad-market-budget',
      `Market retention ${key} must be a safe whole number from 1 through ${MAX_MARKET_RETENTION[key]}; got ${String(chosen)}.`,
    )
  }
  return chosen
}

export function createMemoryMarketStorage(): MemoryMarketStorage {
  let value: MarketStorageEnvelope | null = null
  return {
    capabilities: {
      durability: 'memory',
      scope: 'process-memory-reference',
      atomicCompareAndSwap: true,
      migrations: [1, MARKET_STORAGE_SCHEMA_VERSION],
    },
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
  driver: MarketStorageAdapter,
  deadline: StorageDeadline,
): Promise<{ envelope: MarketStorageEnvelope; expectedRevision: number | null }> {
  assertDriver(driver)
  throwIfStopped(deadline)
  const raw = await beforeDeadline(Promise.resolve().then(() => driver.load()), deadline)
  throwIfStopped(deadline)
  if (raw === null || raw === undefined) return { envelope: emptyEnvelope(), expectedRevision: null }
  const envelope = validateEnvelope(raw, driver.capabilities)
  return { envelope, expectedRevision: envelope.revision }
}

export async function updateEnvelope<T>(
  driver: MarketStorageAdapter,
  deadline: StorageDeadline,
  retention: MarketRetention,
  change: (current: MarketStorageEnvelope) => {
    readonly next: Omit<MarketStorageEnvelope, 'revision'>
    readonly value: T
  },
): Promise<{ value: T; committed: MarketStorageEnvelope }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const loaded = await loadEnvelope(driver, deadline)
    const changed = change(loaded.envelope)
    throwIfStopped(deadline)
    // Compaction belongs to the same atomic replacement as the rows it bounds.
    // A commit that would leave this store above its retention never exists.
    const revision = loaded.envelope.revision + 1
    const compacted = compact(changed.next, retention, revision)
    const next: MarketStorageEnvelope = { ...compacted, revision }
    // Never persist a snapshot that this SDK cannot open on its very next read.
    // This catches every envelope row/revision ceiling before compare-and-swap.
    validateEnvelope(next, driver.capabilities)
    // Once an atomic commit starts, await its truthful acknowledgement. A local
    // timeout cannot un-commit it, so racing it would let a late adapter write
    // happen after this SDK falsely returned failure.
    const committed = await beforeDeadline(
      Promise.resolve().then(() => driver.compareAndSwap(loaded.expectedRevision, cloneEnvelope(next))),
      deadline,
    )
    if (committed === true) {
      if (driver.capabilities.durability === 'durable') await confirmDurable(driver, deadline, next)
      return { value: changed.value, committed: next }
    }
    if (committed !== false) throw storageError('compareAndSwap() must resolve to a boolean')
  }
  throw new KeiError(
    'market-storage-conflict',
    'The market storage changed during eight atomic commit attempts. Retry after the competing writer settles; no partial row/checkpoint commit was accepted by this SDK.',
  )
}

/**
 * A durable adapter's own read path has to agree that the commit happened.
 *
 * This is the difference between storing rows and claiming durability. A
 * quota-refusing browser store, a Durable Object that dropped the write, and an
 * adapter that acknowledges optimistically all return `true` from
 * `compareAndSwap()`; only the read-back shows that a restart would find the
 * rows. This SDK labels nothing weaker `durable`.
 */
async function confirmDurable(
  driver: MarketStorageAdapter,
  deadline: StorageDeadline,
  next: MarketStorageEnvelope,
): Promise<void> {
  const raw = await beforeDeadline(Promise.resolve().then(() => driver.load()), deadline)
  if (raw === null || raw === undefined) {
    throw unconfirmed('it reads back as empty immediately after acknowledging the commit')
  }
  const stored = validateEnvelope(raw, driver.capabilities)
  if (stored.revision !== next.revision) {
    throw unconfirmed(`it acknowledged revision ${next.revision} and reads back revision ${stored.revision}`)
  }
}

function unconfirmed(problem: string): KeiError {
  return new KeiError(
    'market-durability-unconfirmed',
    `A market storage adapter claims durable persistence, but ${problem}. Treat those rows and that checkpoint as uncommitted and retry; this SDK does not label a source durable on an unverified write.`,
  )
}

/**
 * Bring an envelope back inside its retention, folding before evicting.
 *
 * Folding merges every announcement of one `(network, address, instrument,
 * source)` into a single row that keeps the first and last observation times
 * and the count. The participant, the pair it traded, and who saw it survive;
 * only the per-announcement ids go, and those are what made the table grow.
 */
function compact(
  candidate: Omit<MarketStorageEnvelope, 'revision'>,
  retention: MarketRetention,
  revision: number,
): Omit<MarketStorageEnvelope, 'revision'> {
  const report = { ...candidate.retention }
  let observations = candidate.observations
  let catalogRevision = candidate.catalogRevision
  let offerRevision = candidate.offerRevision

  if (observations.length > retention.maxObservations) {
    const folded = foldObservations(observations)
    report.foldedObservations = saturate(report.foldedObservations, observations.length - folded.length)
    observations = folded
    if (observations.length > retention.maxObservations) {
      // Oldest folded rows go first. An evicted participant is gone from this
      // store's roster, and `droppedObservations` is how a page admits it.
      const ordered = [...observations].sort(
        (left, right) => left.observedAt - right.observedAt || compareText(observationKey(left), observationKey(right)),
      )
      const evicted = ordered.slice(0, observations.length - retention.maxObservations)
      const gone = new Set(evicted.map(observationKey))
      observations = observations.filter((row) => !gone.has(observationKey(row)))
      report.droppedObservations = saturate(report.droppedObservations, evicted.length)
    }
    // Row keys and counts moved, so every catalog cursor issued against the old
    // snapshot must fail closed rather than silently skip a folded neighbour.
    // This commit's own revision is the smallest value that guarantees it.
    catalogRevision = revision
  }

  let offers = candidate.offers
  if (offers.length > retention.maxOffers) {
    const ordered = [...offers].sort(compareOfferEviction)
    const evicted = ordered.slice(0, offers.length - retention.maxOffers)
    const gone = new Set(evicted.map(offerKey))
    offers = offers.filter((row) => !gone.has(offerKey(row)))
    report.droppedOffers = saturate(report.droppedOffers, evicted.length)
    offerRevision = revision
  }

  let checkpoints = candidate.checkpoints
  if (checkpoints.length > retention.maxCheckpoints) {
    const ordered = [...checkpoints].sort(
      (left, right) => left.observedAt - right.observedAt || compareText(left.key, right.key),
    )
    const evicted = ordered.slice(0, checkpoints.length - retention.maxCheckpoints)
    const gone = new Set(evicted.map((row) => row.key))
    checkpoints = checkpoints.filter((row) => !gone.has(row.key))
    report.droppedCheckpoints = saturate(report.droppedCheckpoints, evicted.length)
  }

  let quarantine = candidate.quarantine
  if (quarantine.length > retention.maxQuarantine) {
    const kept = quarantine.slice(-retention.maxQuarantine)
    report.droppedQuarantine = saturate(report.droppedQuarantine, quarantine.length - kept.length)
    quarantine = kept
  }

  return {
    ...candidate,
    catalogRevision,
    offerRevision,
    observations,
    offers,
    checkpoints,
    quarantine,
    retention: report,
  }
}

function foldObservations(rows: readonly StoredParticipantObservation[]): StoredParticipantObservation[] {
  const folded = new Map<string, StoredParticipantObservation>()
  for (const row of rows) {
    const current = storedObservation(row)
    const key = observationScope(current)
    const previous = folded.get(key)
    if (previous === undefined) {
      folded.set(key, current)
      continue
    }
    folded.set(key, {
      network: previous.network,
      address: previous.address,
      source: previous.source,
      observedAt: Math.max(previous.observedAt, current.observedAt),
      firstObservedAt: Math.min(previous.firstObservedAt, current.firstObservedAt),
      observations: saturate(previous.observations, current.observations),
      observationId: null,
      base: previous.base,
      quote: previous.quote,
    })
  }
  return [...folded.values()].sort((left, right) => compareText(observationKey(left), observationKey(right)))
}

/**
 * Settled rows leave before open ones: an open offer still locks somebody's
 * asset, so it is the row a live view cannot reconstruct. Within a group the
 * least recently observed goes first.
 */
function compareOfferEviction(left: StoredOfferRecord, right: StoredOfferRecord): number {
  const leftOpen = left.state === 'open' ? 1 : 0
  const rightOpen = right.state === 'open' ? 1 : 0
  if (leftOpen !== rightOpen) return leftOpen - rightOpen
  if (left.lastObservedAt !== right.lastObservedAt) return left.lastObservedAt - right.lastObservedAt
  const leftAt = left.settledAt ?? left.seenAt
  const rightAt = right.settledAt ?? right.seenAt
  if (leftAt !== rightAt) return leftAt - rightAt
  return compareText(left.hash, right.hash)
}

/**
 * The observation fields compaction does arithmetic on, checked first.
 *
 * Adapter rows stay untrusted between two commits by this SDK as well: a folded
 * time or count is a number that would otherwise reach `Math.min` and an
 * addition straight out of storage.
 */
function storedObservation(row: StoredParticipantObservation): StoredParticipantObservation {
  const observedAt = storedTime(row.observedAt, 'observation observedAt')
  const firstObservedAt = storedTime(row.firstObservedAt, 'observation firstObservedAt')
  if (!Number.isSafeInteger(row.observations) || row.observations < 1) {
    throw storageError('a stored observation count is not a positive whole number')
  }
  if (firstObservedAt > observedAt) throw storageError('a stored observation ends before it starts')
  return {
    network: storedText(row.network, 64, 'observation network'),
    address: storedText(row.address, 128, 'observation address'),
    source: storedText(row.source, 128, 'observation source'),
    observedAt,
    firstObservedAt,
    observations: row.observations,
    observationId: row.observationId === null ? null : storedText(row.observationId, 256, 'observation id'),
    base: row.base === null ? null : storedText(row.base, 128, 'observation base'),
    quote: row.quote === null ? null : storedText(row.quote, 128, 'observation quote'),
  }
}

function storedTime(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw storageError(`a stored ${label} is not a whole-millisecond time`)
  }
  return value as number
}

function storedText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw storageError(`a stored ${label} is not a bounded string`)
  }
  return value
}

function observationScope(row: StoredParticipantObservation): string {
  return `${row.network}\u0000${row.address}\u0000${row.base ?? ''}\u0000${row.quote ?? ''}\u0000${row.source}`
}

function observationKey(row: StoredParticipantObservation): string {
  return `${observationScope(row)}\u0000${row.observationId ?? ''}`
}

function offerKey(row: StoredOfferRecord): string {
  return `${row.network}\u0000${row.hash}`
}

function saturate(value: number, added: number): number {
  return value > Number.MAX_SAFE_INTEGER - added ? Number.MAX_SAFE_INTEGER : value + added
}

export function emptyEnvelope(): MarketStorageEnvelope {
  return {
    schema: 'kei-market-storage',
    version: MARKET_STORAGE_SCHEMA_VERSION,
    revision: 0,
    catalogRevision: 0,
    offerRevision: 0,
    cursorKey: randomSeed(),
    observations: [],
    offers: [],
    checkpoints: [],
    quarantine: [],
    retention: { ...EMPTY_RETENTION },
  }
}

export function cloneEnvelope(value: MarketStorageEnvelope): MarketStorageEnvelope {
  return {
    schema: 'kei-market-storage',
    version: MARKET_STORAGE_SCHEMA_VERSION,
    revision: value.revision,
    catalogRevision: value.catalogRevision,
    offerRevision: value.offerRevision,
    cursorKey: value.cursorKey,
    observations: value.observations.map((row) => ({
      network: row.network,
      address: row.address,
      source: row.source,
      observedAt: row.observedAt,
      firstObservedAt: row.firstObservedAt,
      observations: row.observations,
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
    retention: {
      foldedObservations: value.retention.foldedObservations,
      droppedObservations: value.retention.droppedObservations,
      droppedOffers: value.retention.droppedOffers,
      droppedCheckpoints: value.retention.droppedCheckpoints,
      droppedQuarantine: value.retention.droppedQuarantine,
    },
  }
}

function assertDriver(driver: MarketStorageAdapter): void {
  if (
    typeof driver !== 'object' ||
    driver === null ||
    typeof driver.load !== 'function' ||
    typeof driver.compareAndSwap !== 'function'
  ) throw storageError('the driver must provide load() and compareAndSwap()')
  const value = driver.capabilities
  if (typeof value !== 'object' || value === null) throw storageError('the adapter must declare its capabilities')
  if (value.durability !== 'memory' && value.durability !== 'durable') {
    throw storageError("the adapter must declare durability as 'memory' or 'durable'")
  }
  if (
    typeof value.scope !== 'string' ||
    value.scope.length < 1 ||
    value.scope.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value.scope)
  ) throw storageError('the adapter must name its storage scope with a bounded printable string')
  if (value.atomicCompareAndSwap !== true) throw storageError('the adapter must provide atomic compare-and-swap')
  if (!Array.isArray(value.migrations) || value.migrations.length < 1 || value.migrations.length > 8) {
    throw storageError('the adapter must declare which schema versions it accepts')
  }
  let previous = 0
  for (let index = 0; index < value.migrations.length; index += 1) {
    const version: unknown = value.migrations[index]
    if (
      !Number.isSafeInteger(version) ||
      (version as number) <= previous ||
      (version as number) > MARKET_STORAGE_SCHEMA_VERSION
    ) throw storageError(`declared schema versions must ascend within 1..${MARKET_STORAGE_SCHEMA_VERSION}`)
    previous = version as number
  }
  if (!value.migrations.includes(MARKET_STORAGE_SCHEMA_VERSION)) {
    throw storageError(
      `this build commits schema version ${MARKET_STORAGE_SCHEMA_VERSION} and the adapter accepts only ${value.migrations.join(', ')}; upgrade the adapter before opening the store`,
    )
  }
}

function validateEnvelope(raw: unknown, capabilities: MarketStorageCapabilities): MarketStorageEnvelope {
  const schema = storageOwnValue(raw, 'schema')
  const version = storageOwnValue(raw, 'version')
  if (schema !== 'kei-market-storage' || !Number.isSafeInteger(version) || (version as number) < 1) {
    throw storageError('the stored schema/version is unsupported; migrate it atomically before opening this store')
  }
  if ((version as number) > MARKET_STORAGE_SCHEMA_VERSION || !capabilities.migrations.includes(version as number)) {
    throw storageError(
      `the stored envelope is schema version ${String(version)}, which this build and adapter do not accept; migrate it atomically before opening this store`,
    )
  }
  const revision = storedRevision(storageOwnValue(raw, 'revision'), 'revision')
  const catalogRevision = storedRevision(storageOwnValue(raw, 'catalogRevision'), 'catalog revision', revision)
  const offerRevision = storedRevision(storageOwnValue(raw, 'offerRevision'), 'offer revision', revision)
  const legacy = (version as number) < MARKET_STORAGE_SCHEMA_VERSION
  return {
    schema: 'kei-market-storage',
    version: MARKET_STORAGE_SCHEMA_VERSION,
    revision,
    catalogRevision,
    offerRevision,
    // Version 1 stored no cursor key and signed its cursors with a process-local
    // secret that is gone. A fresh key refuses them all rather than reusing row
    // keys under a snapshot this build never issued.
    cursorKey: legacy ? randomSeed() : storedCursorKey(storageOwnValue(raw, 'cursorKey')),
    observations: migratedObservations(
      boundedObjectArray(storageOwnValue(raw, 'observations'), 'observations', MAX_MARKET_RETENTION.maxObservations),
      legacy,
    ),
    offers: boundedObjectArray(
      storageOwnValue(raw, 'offers'),
      'offers',
      MAX_MARKET_RETENTION.maxOffers,
    ) as StoredOfferRecord[],
    checkpoints: boundedObjectArray(
      storageOwnValue(raw, 'checkpoints'),
      'checkpoints',
      MAX_MARKET_RETENTION.maxCheckpoints,
    ) as StoredSourceCheckpoint[],
    quarantine: boundedObjectArray(
      storageOwnValue(raw, 'quarantine'),
      'quarantine',
      MAX_MARKET_RETENTION.maxQuarantine,
    ) as StoredRejectedRow[],
    retention: legacy ? { ...EMPTY_RETENTION } : storedReport(storageOwnValue(raw, 'retention')),
  }
}

/**
 * Version 1 rows carried one announcement each and no fold counters.
 *
 * The migration is a whole-envelope replacement: this read reshapes them in
 * memory, and the next commit persists version 2 through the same
 * compare-and-swap as its rows. A half-migrated envelope has nowhere to exist.
 */
function migratedObservations(rows: readonly object[], legacy: boolean): StoredParticipantObservation[] {
  if (!legacy) return rows as StoredParticipantObservation[]
  return rows.map((row) => {
    const observedAt = storageOwnValue(row, 'observedAt') as number
    return {
      network: storageOwnValue(row, 'network') as string,
      address: storageOwnValue(row, 'address') as string,
      source: storageOwnValue(row, 'source') as string,
      observedAt,
      firstObservedAt: observedAt,
      observations: 1,
      observationId: storageOwnValue(row, 'observationId') as string,
      base: storageOwnValue(row, 'base') as string | null,
      quote: storageOwnValue(row, 'quote') as string | null,
    }
  })
}

function storedCursorKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{16,128}$/i.test(value)) {
    throw storageError('the stored cursor key is missing or is not bounded hexadecimal')
  }
  return value
}

function storedReport(value: unknown): MarketRetentionReport {
  const counter = (key: keyof MarketRetentionReport): number => {
    const found = storageOwnValue(value, key)
    if (!Number.isSafeInteger(found) || (found as number) < 0) {
      throw storageError(`the stored retention ${key} is not a non-negative whole number`)
    }
    return found as number
  }
  return {
    foldedObservations: counter('foldedObservations'),
    droppedObservations: counter('droppedObservations'),
    droppedOffers: counter('droppedOffers'),
    droppedCheckpoints: counter('droppedCheckpoints'),
    droppedQuarantine: counter('droppedQuarantine'),
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function storageError(problem: string): KeiError {
  return new KeiError(
    'bad-market-storage',
    `The market storage is unsafe: ${problem}. No stored observations or checkpoints were trusted or changed.`,
  )
}
