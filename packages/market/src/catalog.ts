import { blake2b, bytesToHex, KeiError, isAddress, utf8 } from '@keicoin/core'

import {
  loadEnvelope,
  retentionOf,
  throwIfStopped,
  updateEnvelope,
  type MarketDurability,
  type MarketRetention,
  type MarketRetentionReport,
  type MarketStorageAdapter,
  type StorageDeadline,
  type StoredParticipantObservation,
} from './storage.js'

export const DEFAULT_CATALOG_PAGE_SIZE = 50
export const MAX_CATALOG_PAGE_SIZE = 256
export const DEFAULT_MARKET_DEADLINE_MS = 5_000
export const MAX_MARKET_DEADLINE_MS = 60_000
export const DEFAULT_CATALOG_RESULT_BYTES = 256_000
export const MAX_CATALOG_RESULT_BYTES = 1_000_000

export interface MarketInstrumentIdentity {
  readonly base: string
  readonly quote: string
}

export interface ParticipantAnnouncement {
  readonly network: string
  readonly address: string
  readonly source: string
  readonly observedAt: number
  readonly observationId: string
  readonly instrument?: MarketInstrumentIdentity
}

export interface AnnouncementReceipt {
  readonly inserted: boolean
  readonly revision: number
  readonly durability: MarketDurability
}

export interface MarketParticipant {
  readonly network: string
  readonly address: string
  readonly firstObservedAt: number
  readonly lastObservedAt: number
  readonly observationCount: number
  /**
   * How many of `observationCount` no longer have their own announcement id,
   * because retention folded them. Their times, sources, and pairs are exact;
   * re-announcing a folded id counts again rather than deduplicating.
   */
  readonly compactedObservations: number
  readonly sources: readonly string[]
  readonly instruments: readonly MarketInstrumentIdentity[]
}

export interface MarketInstrumentRecord extends MarketInstrumentIdentity {
  readonly network: string
  readonly participantCount: number
  readonly firstObservedAt: number
  readonly lastObservedAt: number
  readonly sources: readonly string[]
}

export interface CatalogPage<T> {
  readonly rows: readonly T[]
  readonly nextCursor: string | null
  readonly snapshotRevision: number
  readonly complete: boolean
  readonly consumed: { readonly rows: number; readonly bytes: number }
  /**
   * What this store has folded or evicted for its whole life. `complete` is
   * about this page's rows; these counters are about the roster that reached
   * the page at all.
   */
  readonly retention: MarketRetentionReport
}

export interface CatalogQuery {
  readonly network?: string
  readonly limit?: number
  readonly cursor?: string
  readonly maxResultBytes?: number
  readonly deadlineMs?: number
  readonly signal?: AbortSignal
}

export interface ParticipantQuery extends CatalogQuery {
  readonly instrument?: MarketInstrumentIdentity
}

export interface InstrumentQuery extends CatalogQuery {
  readonly base?: string
  readonly quote?: string
}

export interface MarketCatalog {
  readonly durability: MarketDurability
  announce(input: ParticipantAnnouncement, options?: { deadlineMs?: number; signal?: AbortSignal }): Promise<AnnouncementReceipt>
  participants(query?: ParticipantQuery): Promise<CatalogPage<MarketParticipant>>
  instruments(query?: InstrumentQuery): Promise<CatalogPage<MarketInstrumentRecord>>
}

export interface MarketCatalogOptions {
  readonly storage: MarketStorageAdapter
  readonly now?: () => number
  /** Row bounds and their compaction path. Defaults to `DEFAULT_MARKET_RETENTION`. */
  readonly retention?: Partial<MarketRetention>
}

export function createMarketCatalog(options: MarketCatalogOptions): MarketCatalog {
  const storage = options.storage
  const now = options.now ?? Date.now
  const retention = retentionOf(options.retention)

  return {
    get durability() {
      return storage.capabilities.durability
    },

    async announce(input, writeOptions = {}) {
      const deadline = deadlineOf(writeOptions, now, 'Market catalog announcement')
      // Validate every caller-controlled field before the storage adapter is touched.
      const row = observationOf(input)
      const { value: inserted, committed } = await updateEnvelope(storage, deadline, retention, (current) => {
        const observations = current.observations.map(validateStoredObservation)
        const sameId = observations.find(
          (candidate) =>
            candidate.observationId !== null &&
            candidate.network === row.network &&
            candidate.source === row.source &&
            candidate.observationId === row.observationId,
        )
        if (sameId) {
          if (!sameObservation(sameId, row)) {
            throw new KeiError(
              'market-observation-conflict',
              'A participant observation reused its network/source/observationId with different immutable facts. The original observation remains unchanged.',
            )
          }
          return { next: { ...withoutRevision(current), observations }, value: false }
        }
        return {
          next: {
            ...withoutRevision(current),
            catalogRevision: current.catalogRevision + 1,
            observations: [...observations, row],
          },
          value: true,
        }
      })
      return { inserted, revision: committed.catalogRevision, durability: storage.capabilities.durability }
    },

    async participants(query = {}) {
      const parsed = participantQueryOf(query)
      const deadline = deadlineOf(query, now, 'Market catalog participant page')
      const { envelope } = await loadEnvelope(storage, deadline)
      throwIfStopped(deadline)
      const queryScopeValue = queryScope('participants', parsed)
      const cursor = cursorOf(parsed.cursor, 'participants', envelope.catalogRevision, queryScopeValue, envelope.cursorKey)
      const rows = participantView(envelope.observations, parsed)
      return page(rows, parsed, cursor, envelope.catalogRevision, 'participants', queryScopeValue, envelope.cursorKey, participantKey, envelope.retention, deadline)
    },

    async instruments(query = {}) {
      const parsed = instrumentQueryOf(query)
      const deadline = deadlineOf(query, now, 'Market catalog instrument page')
      const { envelope } = await loadEnvelope(storage, deadline)
      throwIfStopped(deadline)
      const queryScopeValue = queryScope('instruments', parsed)
      const cursor = cursorOf(parsed.cursor, 'instruments', envelope.catalogRevision, queryScopeValue, envelope.cursorKey)
      const rows = instrumentView(envelope.observations, parsed)
      return page(rows, parsed, cursor, envelope.catalogRevision, 'instruments', queryScopeValue, envelope.cursorKey, instrumentKey, envelope.retention, deadline)
    },
  }
}

interface ParsedQuery {
  readonly network?: string
  readonly limit: number
  readonly cursor?: string
  readonly maxResultBytes: number
}

interface ParsedParticipantQuery extends ParsedQuery {
  readonly instrument?: MarketInstrumentIdentity
}

interface ParsedInstrumentQuery extends ParsedQuery {
  readonly base?: string
  readonly quote?: string
}

function participantQueryOf(query: ParticipantQuery): ParsedParticipantQuery {
  const common = queryOf(query)
  const instrument = query.instrument === undefined ? undefined : instrumentOf(query.instrument)
  return { ...common, ...(instrument === undefined ? {} : { instrument }) }
}

function instrumentQueryOf(query: InstrumentQuery): ParsedInstrumentQuery {
  const common = queryOf(query)
  const base = query.base === undefined ? undefined : assetOf(query.base, 'base')
  const quote = query.quote === undefined ? undefined : assetOf(query.quote, 'quote')
  return { ...common, ...(base === undefined ? {} : { base }), ...(quote === undefined ? {} : { quote }) }
}

function queryOf(query: CatalogQuery): ParsedQuery {
  const limit = boundedInteger(query.limit, DEFAULT_CATALOG_PAGE_SIZE, 1, MAX_CATALOG_PAGE_SIZE, 'catalog page limit')
  const maxResultBytes = boundedInteger(
    query.maxResultBytes,
    DEFAULT_CATALOG_RESULT_BYTES,
    1,
    MAX_CATALOG_RESULT_BYTES,
    'catalog byte budget',
  )
  const network = query.network === undefined ? undefined : networkOf(query.network)
  const cursor = query.cursor
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 2_048)) {
    throw new KeiError('bad-market-cursor', 'A market catalog cursor must be an opaque string no longer than 2,048 characters.')
  }
  return { limit, maxResultBytes, ...(network === undefined ? {} : { network }), ...(cursor === undefined ? {} : { cursor }) }
}

function participantView(
  stored: readonly StoredParticipantObservation[],
  query: ParsedParticipantQuery,
): MarketParticipant[] {
  const grouped = new Map<string, { rows: StoredParticipantObservation[]; instruments: Map<string, MarketInstrumentIdentity> }>()
  for (const candidate of stored) {
    const row = validateStoredObservation(candidate)
    if (query.network !== undefined && row.network !== query.network) continue
    if (
      query.instrument !== undefined &&
      (row.base !== query.instrument.base || row.quote !== query.instrument.quote)
    ) continue
    const key = `${row.network}\u0000${row.address}`
    let group = grouped.get(key)
    if (!group) {
      group = { rows: [], instruments: new Map() }
      grouped.set(key, group)
    }
    group.rows.push(row)
    if (row.base !== null && row.quote !== null) {
      group.instruments.set(`${row.base}\u0000${row.quote}`, { base: row.base, quote: row.quote })
    }
  }
  return [...grouped.values()]
    .map(({ rows, instruments }) => {
      const first = rows[0]!
      let firstObservedAt = first.firstObservedAt
      let lastObservedAt = first.observedAt
      let observationCount = 0
      let compactedObservations = 0
      for (const row of rows) {
        firstObservedAt = Math.min(firstObservedAt, row.firstObservedAt)
        lastObservedAt = Math.max(lastObservedAt, row.observedAt)
        observationCount += row.observations
        if (row.observationId === null) compactedObservations += row.observations
      }
      return {
        network: first.network,
        address: first.address,
        firstObservedAt,
        lastObservedAt,
        observationCount,
        compactedObservations,
        sources: [...new Set(rows.map((row) => row.source))].sort(compareText),
        instruments: [...instruments.values()].sort((left, right) => compareText(pairKey(left), pairKey(right))),
      }
    })
    .sort((left, right) => compareText(participantKey(left), participantKey(right)))
}

function instrumentView(
  stored: readonly StoredParticipantObservation[],
  query: ParsedInstrumentQuery,
): MarketInstrumentRecord[] {
  const grouped = new Map<string, StoredParticipantObservation[]>()
  for (const candidate of stored) {
    const row = validateStoredObservation(candidate)
    if (row.base === null || row.quote === null) continue
    if (query.network !== undefined && row.network !== query.network) continue
    if (query.base !== undefined && row.base !== query.base) continue
    if (query.quote !== undefined && row.quote !== query.quote) continue
    const key = `${row.network}\u0000${row.base}\u0000${row.quote}`
    const group = grouped.get(key)
    if (group) group.push(row)
    else grouped.set(key, [row])
  }
  return [...grouped.values()]
    .map((rows) => {
      const first = rows[0]!
      let firstObservedAt = first.firstObservedAt
      let lastObservedAt = first.observedAt
      for (const row of rows) {
        firstObservedAt = Math.min(firstObservedAt, row.firstObservedAt)
        lastObservedAt = Math.max(lastObservedAt, row.observedAt)
      }
      return {
        network: first.network,
        base: first.base!,
        quote: first.quote!,
        participantCount: new Set(rows.map((row) => row.address)).size,
        firstObservedAt,
        lastObservedAt,
        sources: [...new Set(rows.map((row) => row.source))].sort(compareText),
      }
    })
    .sort((left, right) => compareText(instrumentKey(left), instrumentKey(right)))
}

function page<T>(
  rows: readonly T[],
  query: ParsedQuery,
  after: string | null,
  revision: number,
  kind: 'participants' | 'instruments',
  scope: string,
  secret: string,
  keyOf: (row: T) => string,
  retention: MarketRetentionReport,
  deadline: StorageDeadline,
): CatalogPage<T> {
  const output: T[] = []
  let bytes = 2
  let hasMore = false
  for (const row of rows) {
    throwIfStopped(deadline)
    const key = keyOf(row)
    if (after !== null && compareText(key, after) <= 0) continue
    if (output.length >= query.limit) {
      hasMore = true
      break
    }
    const rowBytes = jsonBytes(row)
    if (bytes + rowBytes > query.maxResultBytes) {
      if (output.length === 0) {
        throw new KeiError(
          'market-result-too-large',
          `One catalog row needs ${rowBytes} bytes, above this query's ${query.maxResultBytes}-byte result budget. Raise the bounded byte budget or narrow the query; no partial row was returned.`,
        )
      }
      hasMore = true
      break
    }
    output.push(row)
    bytes += rowBytes
  }
  const last = output.length === 0 ? null : keyOf(output[output.length - 1] as T)
  return {
    rows: output,
    nextCursor: hasMore && last !== null ? encodeCursor(kind, revision, scope, secret, last) : null,
    snapshotRevision: revision,
    complete: !hasMore,
    consumed: { rows: output.length, bytes },
    retention,
  }
}

function cursorOf(value: string | undefined, kind: 'participants' | 'instruments', revision: number, scope: string, secret: string): string | null {
  if (value === undefined) return null
  const parts = value.split('.')
  if (parts.length !== 6 || parts[0] !== 'mcat2' || parts[2] !== kind || !/^\d+$/.test(parts[1]!) || parts[3] !== scope) {
    throw new KeiError('bad-market-cursor', 'The market catalog cursor is malformed or belongs to a different page kind.')
  }
  const key = decodeHex(parts[4]!)
  // Integrity first: a cursor signed by another store, or by this store before
  // it was cleared and replayed, is not a stale page of this snapshot at all.
  const expected = cursorIntegrity(secret, `mcat2.${parts[1]}.${kind}.${scope}.${parts[4]}`)
  if (parts[5] !== expected) throw new KeiError('bad-market-cursor', 'The market catalog cursor failed its integrity check or belongs to another query.')
  const cursorRevision = Number(parts[1])
  if (!Number.isSafeInteger(cursorRevision) || cursorRevision !== revision) {
    throw new KeiError(
      'stale-market-cursor',
      'The catalog changed after this cursor was issued. Restart paging from the first page to get a stable snapshot without gaps or duplicates.',
    )
  }
  return key
}

function encodeCursor(kind: string, revision: number, scope: string, secret: string, key: string): string {
  let hex = ''
  for (let index = 0; index < key.length; index += 1) hex += key.charCodeAt(index).toString(16).padStart(4, '0')
  const payload = `mcat2.${revision}.${kind}.${scope}.${hex}`
  return `${payload}.${cursorIntegrity(secret, payload)}`
}

function queryScope(kind: 'participants' | 'instruments', query: ParsedParticipantQuery | ParsedInstrumentQuery): string {
  const normalized = kind === 'participants'
    ? {
        kind,
        network: query.network ?? null,
        instrument: 'instrument' in query ? query.instrument ?? null : null,
      }
    : {
        kind,
        network: query.network ?? null,
        base: 'base' in query ? query.base ?? null : null,
        quote: 'quote' in query ? query.quote ?? null : null,
      }
  return cursorIntegrity('public-query-scope', JSON.stringify(normalized))
}

function cursorIntegrity(secret: string, value: string): string {
  return bytesToHex(blake2b(utf8(`kei-market-cursor-v2\n${secret}\n${value}`), 16)).toLowerCase()
}

function decodeHex(value: string): string {
  if (value.length > 1_600 || value.length % 4 !== 0 || !/^[0-9a-f]*$/.test(value)) {
    throw new KeiError('bad-market-cursor', 'The market catalog cursor payload is malformed.')
  }
  let output = ''
  for (let index = 0; index < value.length; index += 4) output += String.fromCharCode(Number.parseInt(value.slice(index, index + 4), 16))
  return output
}

export function deadlineOf(
  options: { deadlineMs?: number; signal?: AbortSignal },
  now: () => number,
  what: string,
): StorageDeadline {
  const duration = boundedInteger(options.deadlineMs, DEFAULT_MARKET_DEADLINE_MS, 1, MAX_MARKET_DEADLINE_MS, 'market deadline')
  let start: unknown
  try {
    start = now()
  } catch {
    throw new KeiError('bad-market-clock', `${what} cannot use a clock that throws.`)
  }
  if (!Number.isSafeInteger(start) || (start as number) < 0 || (start as number) > Number.MAX_SAFE_INTEGER - duration) {
    throw new KeiError('bad-market-clock', `${what} needs a non-negative safe whole-millisecond clock with room for its deadline.`)
  }
  return { now, what, deadlineAt: (start as number) + duration, ...(options.signal === undefined ? {} : { signal: options.signal }) }
}

function observationOf(input: ParticipantAnnouncement): StoredParticipantObservation {
  const network = networkOf(ownValue(input, 'network'))
  const address = ownValue(input, 'address')
  if (typeof address !== 'string' || address.length > 128 || !isAddress(address)) {
    throw badObservation('address must be a canonical Kei address')
  }
  const source = boundedText(ownValue(input, 'source'), 1, 128, 'source')
  const observationId = boundedText(ownValue(input, 'observationId'), 1, 256, 'observationId')
  const observedAt = ownValue(input, 'observedAt')
  if (!Number.isSafeInteger(observedAt) || (observedAt as number) < 0) {
    throw badObservation('observedAt must be a non-negative safe whole-millisecond timestamp')
  }
  const instrumentValue = ownValue(input, 'instrument', false)
  const instrument = instrumentValue === undefined ? undefined : instrumentOf(instrumentValue as MarketInstrumentIdentity)
  return {
    network,
    address,
    source,
    observedAt: observedAt as number,
    firstObservedAt: observedAt as number,
    observations: 1,
    observationId,
    base: instrument?.base ?? null,
    quote: instrument?.quote ?? null,
  }
}

/**
 * Re-check a stored row's own fields, including the ones compaction wrote.
 *
 * A folded row has no announcement id and stands for a count, so the checks
 * differ from a fresh announcement's without becoming weaker: its window still
 * has to be a real interval and its count a positive whole number.
 */
function validateStoredObservation(input: StoredParticipantObservation): StoredParticipantObservation {
  const observationId = ownValue(input, 'observationId')
  const base = ownValue(input, 'base')
  const quote = ownValue(input, 'quote')
  const validated = observationOf({
    network: ownValue(input, 'network') as string,
    address: ownValue(input, 'address') as string,
    source: ownValue(input, 'source') as string,
    observedAt: ownValue(input, 'observedAt') as number,
    observationId: observationId === null ? 'compacted' : (observationId as string),
    ...(base === null && quote === null ? {} : { instrument: { base: base as string, quote: quote as string } }),
  })
  const firstObservedAt = ownValue(input, 'firstObservedAt')
  const observations = ownValue(input, 'observations')
  if (!Number.isSafeInteger(firstObservedAt) || (firstObservedAt as number) < 0 || (firstObservedAt as number) > validated.observedAt) {
    throw badObservation('firstObservedAt must be a non-negative whole-millisecond time at or before observedAt')
  }
  if (!Number.isSafeInteger(observations) || (observations as number) < 1) {
    throw badObservation('observations must be a positive safe whole number')
  }
  return {
    ...validated,
    firstObservedAt: firstObservedAt as number,
    observations: observations as number,
    observationId: observationId === null ? null : validated.observationId,
  }
}

function instrumentOf(value: MarketInstrumentIdentity): MarketInstrumentIdentity {
  const base = assetOf(ownValue(value, 'base'), 'base')
  const quote = assetOf(ownValue(value, 'quote'), 'quote')
  if (base === quote) throw badObservation('instrument base and quote must differ')
  return { base, quote }
}

function assetOf(value: unknown, label: string): string {
  const text = boundedText(value, 1, 128, label).toUpperCase()
  if (!/^[A-Z0-9:_-]+$/.test(text)) throw badObservation(`${label} contains unsupported asset-id characters`)
  return text
}

function networkOf(value: unknown): string {
  const text = boundedText(value, 1, 64, 'network').toLowerCase()
  if (!/^[a-z][a-z0-9.-]*$/.test(text)) throw badObservation('network must be a canonical lowercase namespace')
  return text
}

function boundedText(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw badObservation(`${label} must be a bounded printable string (${minimum}-${maximum} characters)`)
  }
  return value
}

function ownValue(value: unknown, key: string, required = true): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badObservation('it must be a plain own-property object')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw badObservation('inherited record fields are not accepted')
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) {
    if (!required) return undefined
    throw badObservation(`${key} must be an own data property`)
  }
  if (!Object.hasOwn(descriptor, 'value')) throw badObservation(`${key} cannot be an accessor property`)
  return descriptor.value
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const chosen = value ?? fallback
  if (!Number.isSafeInteger(chosen) || chosen < minimum || chosen > maximum) {
    throw new KeiError('bad-market-budget', `${label} must be a safe whole number from ${minimum} through ${maximum}; got ${String(chosen)}.`)
  }
  return chosen
}

function participantKey(row: MarketParticipant): string {
  return `${row.network}\u0000${row.address}`
}

function instrumentKey(row: MarketInstrumentRecord): string {
  return `${row.network}\u0000${row.base}\u0000${row.quote}`
}

function pairKey(row: MarketInstrumentIdentity): string {
  return `${row.base}\u0000${row.quote}`
}

function sameObservation(left: StoredParticipantObservation, right: StoredParticipantObservation): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function withoutRevision(value: import('./storage.js').MarketStorageEnvelope): Omit<import('./storage.js').MarketStorageEnvelope, 'revision'> {
  const { revision: _revision, ...rest } = value
  return rest
}

function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value)
  return json === undefined ? 0 : json.length * 2
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function badObservation(problem: string): KeiError {
  return new KeiError('bad-market-observation', `A market catalog observation is invalid: ${problem}. Nothing was stored.`)
}
