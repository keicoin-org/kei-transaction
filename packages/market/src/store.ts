import { KeiError, isAddress } from '@keicoin/core'

import { deadlineOf } from './catalog.js'
import {
  loadEnvelope,
  throwIfStopped,
  updateEnvelope,
  type MarketStorageDriver,
  type StoredOfferRecord,
  type StoredRejectedRow,
  type StoredSourceCheckpoint,
} from './storage.js'

export const MAX_MATERIALIZED_ROWS_PER_COMMIT = 256
export const MAX_MARKET_QUARANTINE_ROWS = 1_000

export interface StoredMarketOfferInput {
  readonly network: string
  readonly hash: string
  readonly author: string
  readonly give: { readonly asset: string; readonly raw: string }
  readonly want: { readonly asset: string; readonly raw: string }
  readonly counterparty: string | null
  readonly state: 'open' | 'accepted' | 'cancelled'
  readonly acceptedBy: string | null
  readonly settledBy: string | null
  readonly height: number
  readonly seenAt: number
  readonly settledAt: number | null
  readonly source: string
  readonly observedAt: number
}

export interface StoredMarketOffer {
  readonly network: string
  readonly hash: string
  readonly author: string
  readonly give: { readonly asset: string; readonly raw: string }
  readonly want: { readonly asset: string; readonly raw: string }
  readonly counterparty: string | null
  readonly state: 'open' | 'accepted' | 'cancelled'
  readonly acceptedBy: string | null
  readonly settledBy: string | null
  readonly height: number
  readonly seenAt: number
  readonly settledAt: number | null
  readonly provenance: {
    readonly sources: readonly string[]
    readonly firstObservedAt: number
    readonly lastObservedAt: number
    readonly timeBasis: 'node-first-seen/indexer-observed'
  }
}

export interface SourceCheckpointInput {
  readonly network: string
  readonly source: string
  readonly account: string
  readonly adapterVersion: number
  readonly observedAt: number
  readonly newestHash: string | null
  readonly providerCursor: string | null
  readonly exhausted: boolean
  readonly stopReason: MarketIngestStopReason
}

export type MarketIngestStopReason =
  | 'exhausted'
  | 'account_limit'
  | 'request_limit'
  | 'result_limit'
  | 'byte_limit'
  | 'page_limit'
  | 'scan_limit'
  | 'deadline'
  | 'aborted'
  | 'provider_error'
  | 'unsupported_pagination'

export interface RejectedMarketRowInput {
  readonly network: string
  readonly source: string
  readonly account: string
  readonly observedAt: number
  readonly reason: string
}

export interface MaterializedPageInput {
  readonly offers: readonly StoredMarketOfferInput[]
  readonly checkpoint: SourceCheckpointInput
  readonly rejected?: readonly RejectedMarketRowInput[]
  readonly deadlineMs?: number
  readonly signal?: AbortSignal
}

export interface MaterializedPageReceipt {
  readonly inserted: number
  readonly updated: number
  readonly unchanged: number
  readonly conflicts: number
  readonly quarantined: number
  readonly revision: number
  readonly durability: 'memory' | 'durable'
}

export interface StoredOfferQuery {
  readonly network: string
  readonly base?: string
  readonly quote?: string
  readonly state?: 'open' | 'accepted' | 'cancelled'
  readonly limit?: number
  readonly cursor?: string
  readonly maxResultBytes?: number
  readonly deadlineMs?: number
  readonly signal?: AbortSignal
}

export interface StoredOfferPage {
  readonly rows: readonly StoredMarketOffer[]
  readonly nextCursor: string | null
  readonly snapshotRevision: number
  readonly complete: boolean
  readonly consumed: { readonly rows: number; readonly bytes: number }
  readonly coverage: {
    readonly scope: 'stored-observations'
    readonly sourceBackfill: { readonly complete: false; readonly reason: 'unsupported_pagination' }
  }
}

export interface MarketStore {
  readonly durability: 'memory' | 'durable'
  materialize(input: MaterializedPageInput): Promise<MaterializedPageReceipt>
  offers(query: StoredOfferQuery): Promise<StoredOfferPage>
  checkpoint(query: {
    network: string
    source: string
    account: string
    adapterVersion: number
    deadlineMs?: number
    signal?: AbortSignal
  }): Promise<SourceCheckpointInput | null>
  quarantine(query?: { limit?: number; deadlineMs?: number; signal?: AbortSignal }): Promise<readonly RejectedMarketRowInput[]>
}

export interface MarketStoreOptions {
  readonly storage: MarketStorageDriver
  readonly now?: () => number
}

export function createMarketStore(options: MarketStoreOptions): MarketStore {
  const storage = options.storage
  const now = options.now ?? Date.now
  return {
    get durability() {
      return storage.capabilities.durability
    },

    async materialize(input) {
      if (typeof input !== 'object' || input === null) throw badRow('materialized page must be an object')
      // All untrusted rows/checkpoint/budgets are bounded and canonicalized before storage is touched.
      const offers = denseArray(input.offers, 'offers', MAX_MATERIALIZED_ROWS_PER_COMMIT).map(offerOf)
      const rejected = denseArray(input.rejected ?? [], 'rejected rows', MAX_MATERIALIZED_ROWS_PER_COMMIT).map(rejectedOf)
      const checkpoint = checkpointOf(input.checkpoint)
      for (const offer of offers) {
        if (offer.network !== checkpoint.network || !offer.sources.includes(checkpoint.source)) {
          throw badRow('every offer in a page must share its checkpoint network and source')
        }
      }
      const deadline = deadlineOf(input, now, 'Market page materialization')
      let nextRevision = 0
      const value = await updateEnvelope(storage, deadline, (current) => {
        nextRevision = current.revision + 1
        const records = new Map(current.offers.map((row) => [`${row.network}\u0000${row.hash}`, validateStoredOffer(row)]))
        const quarantine = current.quarantine.map(validateRejected)
        let inserted = 0
        let updated = 0
        let unchanged = 0
        let conflicts = 0

        for (const offer of offers) {
          const key = `${offer.network}\u0000${offer.hash}`
          const previous = records.get(key)
          if (!previous) {
            records.set(key, offer)
            inserted += 1
          } else {
            const merged = reconcileOffer(previous, offer)
            if (merged === null) {
              conflicts += 1
              quarantine.push({
                network: offer.network,
                source: checkpoint.source,
                account: checkpoint.account,
                observedAt: checkpoint.observedAt,
                reason: `immutable-conflict:${offer.hash}`,
              })
            } else {
              records.set(key, merged.row)
              if (merged.changed) updated += 1
              else unchanged += 1
            }
          }
        }
        quarantine.push(...rejected)
        const boundedQuarantine = quarantine.slice(-MAX_MARKET_QUARANTINE_ROWS)
        const checkpointRows = current.checkpoints.map(validateCheckpoint)
        const checkpointIndex = checkpointRows.findIndex((row) => row.key === checkpoint.key)
        if (checkpointIndex >= 0) {
          const prior = checkpointRows[checkpointIndex]!
          // An overlapping/stale poll may retry after a newer poll committed.
          // It can add idempotent rows, but must never move the watermark back.
          if (checkpoint.observedAt >= prior.observedAt) checkpointRows[checkpointIndex] = checkpoint
        }
        else checkpointRows.push(checkpoint)
        const { revision: _revision, ...rest } = current
        return {
          next: {
            ...rest,
            offerRevision: current.offerRevision + (inserted > 0 || updated > 0 ? 1 : 0),
            offers: [...records.values()].sort((left, right) => compareText(offerKey(left), offerKey(right))),
            checkpoints: checkpointRows.sort((left, right) => compareText(left.key, right.key)),
            quarantine: boundedQuarantine,
          },
          value: { inserted, updated, unchanged, conflicts, quarantined: rejected.length + conflicts },
        }
      })
      return { ...value, revision: nextRevision, durability: storage.capabilities.durability }
    },

    async offers(query) {
      const parsed = offerQueryOf(query)
      const deadline = deadlineOf(query, now, 'Stored market offer page')
      const { envelope } = await loadEnvelope(storage, deadline)
      const after = storeCursorOf(parsed.cursor, envelope.offerRevision)
      const matching = envelope.offers
        .map(validateStoredOffer)
        .filter(
          (row) =>
            row.network === parsed.network &&
            (parsed.base === undefined || row.giveAsset === parsed.base) &&
            (parsed.quote === undefined || row.wantAsset === parsed.quote) &&
            (parsed.state === undefined || row.state === parsed.state),
        )
        .sort((left, right) => compareText(offerKey(left), offerKey(right)))
      const output: StoredMarketOffer[] = []
      let bytes = 2
      let more = false
      for (const row of matching) {
        throwIfStopped(deadline)
        if (after !== null && compareText(offerKey(row), after) <= 0) continue
        if (output.length >= parsed.limit) {
          more = true
          break
        }
        const candidate = publicOffer(row)
        const candidateBytes = (JSON.stringify(candidate)?.length ?? 0) * 2
        if (bytes + candidateBytes > parsed.maxResultBytes) {
          if (output.length === 0) throw new KeiError('market-result-too-large', `One stored offer needs ${candidateBytes} bytes, above this query's ${parsed.maxResultBytes}-byte budget.`)
          more = true
          break
        }
        output.push(candidate)
        bytes += candidateBytes
      }
      const last = output.at(-1)
      return {
        rows: output,
        nextCursor: more && last ? storeCursor(envelope.offerRevision, `${last.network}\u0000${last.hash}`) : null,
        snapshotRevision: envelope.offerRevision,
        complete: !more,
        consumed: { rows: output.length, bytes },
        coverage: {
          scope: 'stored-observations',
          sourceBackfill: { complete: false, reason: 'unsupported_pagination' },
        },
      }
    },

    async checkpoint(query) {
      const parsed = checkpointKeyQueryOf(query)
      const deadline = deadlineOf(query, now, 'Market source checkpoint read')
      const { envelope } = await loadEnvelope(storage, deadline)
      const found = envelope.checkpoints.map(validateCheckpoint).find((row) => row.key === parsed.key)
      return found ? publicCheckpoint(found) : null
    },

    async quarantine(query = {}) {
      const limit = integerOf(query.limit, 100, 1, MAX_MARKET_QUARANTINE_ROWS, 'quarantine limit')
      const deadline = deadlineOf(query, now, 'Market quarantine read')
      const { envelope } = await loadEnvelope(storage, deadline)
      return envelope.quarantine.map(validateRejected).slice(-limit).map((row) => ({ ...row }))
    },
  }
}

function offerOf(value: StoredMarketOfferInput): StoredOfferRecord {
  if (typeof value !== 'object' || value === null) throw badRow('offer must be an object')
  const network = networkOf(value.network)
  const hash = hashOf(value.hash)
  const author = addressOf(value.author, 'author')
  const give = legOf(value.give, 'give')
  const want = legOf(value.want, 'want')
  if (give.asset === want.asset) throw badRow('offer legs must use different assets')
  const counterparty = nullableAddressOf(value.counterparty, 'counterparty')
  const acceptedBy = nullableAddressOf(value.acceptedBy, 'acceptedBy')
  const settledBy = nullableHashOf(value.settledBy, 'settledBy')
  if (!['open', 'accepted', 'cancelled'].includes(value.state)) throw badRow('state is invalid')
  if (value.state === 'open' && (acceptedBy !== null || settledBy !== null || value.settledAt !== null)) {
    throw badRow('an open offer cannot carry settlement fields')
  }
  if (value.state === 'accepted' && (acceptedBy === null || settledBy === null || value.settledAt === null)) {
    throw badRow('an accepted offer needs acceptedBy, settledBy, and settledAt')
  }
  if (value.state === 'cancelled' && (acceptedBy !== null || settledBy === null || value.settledAt === null)) {
    throw badRow('a cancelled offer needs settledBy/settledAt and cannot have acceptedBy')
  }
  const height = safeInteger(value.height, 1, Number.MAX_SAFE_INTEGER, 'height')
  const seenAt = safeInteger(value.seenAt, 0, Number.MAX_SAFE_INTEGER, 'seenAt')
  const settledAt = value.settledAt === null ? null : safeInteger(value.settledAt, 0, Number.MAX_SAFE_INTEGER, 'settledAt')
  const source = textOf(value.source, 1, 128, 'source')
  const observedAt = safeInteger(value.observedAt, 0, Number.MAX_SAFE_INTEGER, 'observedAt')
  return {
    network,
    hash,
    author,
    giveAsset: give.asset,
    giveRaw: give.raw,
    wantAsset: want.asset,
    wantRaw: want.raw,
    counterparty,
    state: value.state,
    acceptedBy,
    settledBy,
    height,
    seenAt,
    settledAt,
    sources: [source],
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
  }
}

function checkpointOf(value: SourceCheckpointInput): StoredSourceCheckpoint {
  if (typeof value !== 'object' || value === null) throw badRow('checkpoint must be an object')
  const network = networkOf(value.network)
  const source = textOf(value.source, 1, 128, 'checkpoint source')
  const account = addressOf(value.account, 'checkpoint account')
  const adapterVersion = safeInteger(value.adapterVersion, 1, 1_000_000, 'adapterVersion')
  const observedAt = safeInteger(value.observedAt, 0, Number.MAX_SAFE_INTEGER, 'checkpoint observedAt')
  const newestHash = value.newestHash === null ? null : hashOf(value.newestHash)
  const providerCursor = value.providerCursor === null ? null : textOf(value.providerCursor, 1, 2_048, 'providerCursor')
  const reasons: readonly MarketIngestStopReason[] = ['exhausted', 'account_limit', 'request_limit', 'result_limit', 'byte_limit', 'page_limit', 'scan_limit', 'deadline', 'aborted', 'provider_error', 'unsupported_pagination']
  if (!reasons.includes(value.stopReason)) throw badRow('checkpoint stopReason is invalid')
  if (typeof value.exhausted !== 'boolean') throw badRow('checkpoint exhausted must be boolean')
  if (value.exhausted && (value.stopReason !== 'exhausted' || providerCursor !== null)) {
    throw badRow('an exhausted checkpoint must say exhausted and have no provider cursor')
  }
  if (!value.exhausted && value.stopReason === 'exhausted') throw badRow('a non-exhausted checkpoint cannot say exhausted')
  return {
    key: checkpointKey(network, source, account, adapterVersion),
    network,
    source,
    account,
    adapterVersion,
    observedAt,
    newestHash,
    providerCursor,
    exhausted: value.exhausted,
    stopReason: value.stopReason,
  }
}

function rejectedOf(value: RejectedMarketRowInput): StoredRejectedRow {
  if (typeof value !== 'object' || value === null) throw badRow('rejected row must be an object')
  return {
    network: networkOf(value.network),
    source: textOf(value.source, 1, 128, 'rejected source'),
    account: addressOf(value.account, 'rejected account'),
    observedAt: safeInteger(value.observedAt, 0, Number.MAX_SAFE_INTEGER, 'rejected observedAt'),
    reason: textOf(value.reason, 1, 512, 'rejected reason'),
  }
}

function validateStoredOffer(row: StoredOfferRecord): StoredOfferRecord {
  const sources = denseArray(row.sources, 'stored offer sources', 32).map((source) => textOf(source, 1, 128, 'stored source'))
  if (sources.length === 0) throw badRow('stored offer needs at least one provenance source')
  const input: StoredMarketOfferInput = {
    network: row.network,
    hash: row.hash,
    author: row.author,
    give: { asset: row.giveAsset, raw: row.giveRaw },
    want: { asset: row.wantAsset, raw: row.wantRaw },
    counterparty: row.counterparty,
    state: row.state,
    acceptedBy: row.acceptedBy,
    settledBy: row.settledBy,
    height: row.height,
    seenAt: row.seenAt,
    settledAt: row.settledAt,
    source: sources[0] ?? 'invalid',
    observedAt: row.firstObservedAt,
  }
  const validated = offerOf(input)
  const last = safeInteger(row.lastObservedAt, validated.firstObservedAt, Number.MAX_SAFE_INTEGER, 'lastObservedAt')
  return { ...validated, sources: [...new Set(sources)].sort(compareText), lastObservedAt: last }
}

function validateCheckpoint(row: StoredSourceCheckpoint): StoredSourceCheckpoint {
  const parsed = checkpointOf(publicCheckpoint(row))
  if (row.key !== parsed.key) throw badRow('stored checkpoint key does not match its scope')
  return parsed
}

function validateRejected(row: StoredRejectedRow): StoredRejectedRow {
  return rejectedOf(row)
}

function reconcileOffer(
  previous: StoredOfferRecord,
  observed: StoredOfferRecord,
): { row: StoredOfferRecord; changed: boolean } | null {
  const immutable = ({
    sources: _sources,
    firstObservedAt: _first,
    lastObservedAt: _last,
    state: _state,
    acceptedBy: _acceptedBy,
    settledBy: _settledBy,
    settledAt: _settledAt,
    ...value
  }: StoredOfferRecord) => value
  if (JSON.stringify(immutable(previous)) !== JSON.stringify(immutable(observed))) return null

  let lifecycle = previous
  let changed = false
  if (previous.state === 'open' && observed.state !== 'open') {
    lifecycle = observed
    changed = true
  } else if (previous.state !== 'open' && observed.state !== 'open') {
    if (
      previous.state !== observed.state ||
      previous.acceptedBy !== observed.acceptedBy ||
      previous.settledBy !== observed.settledBy ||
      previous.settledAt !== observed.settledAt
    ) return null
  }
  return {
    changed,
    row: {
      ...lifecycle,
      sources: [...new Set([...previous.sources, ...observed.sources])].sort(compareText),
      firstObservedAt: Math.min(previous.firstObservedAt, observed.firstObservedAt),
      lastObservedAt: Math.max(previous.lastObservedAt, observed.lastObservedAt),
    },
  }
}

function publicOffer(row: StoredOfferRecord): StoredMarketOffer {
  return {
    network: row.network,
    hash: row.hash,
    author: row.author,
    give: { asset: row.giveAsset, raw: row.giveRaw },
    want: { asset: row.wantAsset, raw: row.wantRaw },
    counterparty: row.counterparty,
    state: row.state,
    acceptedBy: row.acceptedBy,
    settledBy: row.settledBy,
    height: row.height,
    seenAt: row.seenAt,
    settledAt: row.settledAt,
    provenance: {
      sources: [...row.sources],
      firstObservedAt: row.firstObservedAt,
      lastObservedAt: row.lastObservedAt,
      timeBasis: 'node-first-seen/indexer-observed',
    },
  }
}

function publicCheckpoint(row: StoredSourceCheckpoint): SourceCheckpointInput {
  return {
    network: row.network,
    source: row.source,
    account: row.account,
    adapterVersion: row.adapterVersion,
    observedAt: row.observedAt,
    newestHash: row.newestHash,
    providerCursor: row.providerCursor,
    exhausted: row.exhausted,
    stopReason: row.stopReason as MarketIngestStopReason,
  }
}

function offerQueryOf(query: StoredOfferQuery): { network: string; base?: string; quote?: string; state?: 'open' | 'accepted' | 'cancelled'; limit: number; maxResultBytes: number; cursor?: string } {
  if (typeof query !== 'object' || query === null) throw badRow('offer query must be an object')
  const network = networkOf(query.network)
  const base = query.base === undefined ? undefined : assetOf(query.base, 'base')
  const quote = query.quote === undefined ? undefined : assetOf(query.quote, 'quote')
  if (query.state !== undefined && !['open', 'accepted', 'cancelled'].includes(query.state)) throw badRow('offer query state is invalid')
  const limit = integerOf(query.limit, 50, 1, 256, 'offer page limit')
  const maxResultBytes = integerOf(query.maxResultBytes, 256_000, 1, 1_000_000, 'offer result byte budget')
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 2_048)) throw new KeiError('bad-market-cursor', 'Stored offer cursor is invalid.')
  return { network, limit, maxResultBytes, ...(base === undefined ? {} : { base }), ...(quote === undefined ? {} : { quote }), ...(query.state === undefined ? {} : { state: query.state }), ...(query.cursor === undefined ? {} : { cursor: query.cursor }) }
}

function checkpointKeyQueryOf(query: { network: string; source: string; account: string; adapterVersion: number }): { key: string } {
  const network = networkOf(query.network)
  const source = textOf(query.source, 1, 128, 'checkpoint source')
  const account = addressOf(query.account, 'checkpoint account')
  const version = safeInteger(query.adapterVersion, 1, 1_000_000, 'adapterVersion')
  return { key: checkpointKey(network, source, account, version) }
}

function checkpointKey(network: string, source: string, account: string, version: number): string {
  return `${network}\u0000${source}\u0000${version}\u0000${account}`
}

function offerKey(row: StoredOfferRecord): string {
  return `${row.network}\u0000${row.hash}`
}

function storeCursor(revision: number, key: string): string {
  let hex = ''
  for (let index = 0; index < key.length; index += 1) hex += key.charCodeAt(index).toString(16).padStart(4, '0')
  return `mstore1.${revision}.${hex}`
}

function storeCursorOf(cursor: string | undefined, revision: number): string | null {
  if (cursor === undefined) return null
  const parts = cursor.split('.')
  if (parts.length !== 3 || parts[0] !== 'mstore1' || !/^\d+$/.test(parts[1]!) || !/^[0-9a-f]+$/.test(parts[2]!) || parts[2]!.length % 4 !== 0 || parts[2]!.length > 1_600) {
    throw new KeiError('bad-market-cursor', 'Stored offer cursor is malformed.')
  }
  if (Number(parts[1]) !== revision) throw new KeiError('stale-market-cursor', 'The materialized store changed; restart paging for a stable snapshot.')
  let key = ''
  for (let index = 0; index < parts[2]!.length; index += 4) key += String.fromCharCode(Number.parseInt(parts[2]!.slice(index, index + 4), 16))
  return key
}

function legOf(value: { asset: string; raw: string }, label: string): { asset: string; raw: string } {
  if (typeof value !== 'object' || value === null) throw badRow(`${label} leg must be an object`)
  const raw = textOf(value.raw, 1, 256, `${label}.raw`)
  if (!/^[1-9]\d*$/.test(raw)) throw badRow(`${label}.raw must be a positive canonical integer string`)
  return { asset: assetOf(value.asset, `${label}.asset`), raw }
}

function assetOf(value: unknown, label: string): string {
  const asset = textOf(value, 1, 128, label).toUpperCase()
  if (!/^[A-Z0-9:_-]+$/.test(asset)) throw badRow(`${label} contains unsupported asset-id characters`)
  return asset
}

function hashOf(value: unknown): string {
  const hash = textOf(value, 64, 64, 'hash').toUpperCase()
  if (!/^[0-9A-F]{64}$/.test(hash)) throw badRow('hash must be 64 hexadecimal characters')
  return hash
}

function nullableHashOf(value: unknown, label: string): string | null {
  if (value === null) return null
  try {
    return hashOf(value)
  } catch {
    throw badRow(`${label} must be null or a 64-character hexadecimal hash`)
  }
}

function addressOf(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 128 || !isAddress(value)) throw badRow(`${label} must be a canonical Kei address`)
  return value
}

function nullableAddressOf(value: unknown, label: string): string | null {
  return value === null ? null : addressOf(value, label)
}

function networkOf(value: unknown): string {
  const network = textOf(value, 1, 64, 'network').toLowerCase()
  if (!/^[a-z][a-z0-9.-]*$/.test(network)) throw badRow('network is not a canonical namespace')
  return network
}

function textOf(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw badRow(`${label} must be a printable string of ${minimum}-${maximum} characters`)
  return value
}

function safeInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw badRow(`${label} must be a safe integer from ${minimum} through ${maximum}`)
  return value as number
}

function integerOf(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const chosen = value ?? fallback
  if (!Number.isSafeInteger(chosen) || chosen < minimum || chosen > maximum) throw new KeiError('bad-market-budget', `${label} must be a safe whole number from ${minimum} through ${maximum}.`)
  return chosen
}

function denseArray<T>(value: readonly T[], label: string, maximum: number): T[] {
  if (!Array.isArray(value)) throw badRow(`${label} must be an array`)
  const length: unknown = value.length
  if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maximum) throw badRow(`${label} exceeds its ${maximum}-row budget`)
  const output: T[] = []
  for (let index = 0; index < (length as number); index += 1) {
    if (!Object.hasOwn(value, index)) throw badRow(`${label} contains a sparse entry`)
    output.push(value[index] as T)
  }
  return output
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function badRow(problem: string): KeiError {
  return new KeiError('bad-market-row', `A materialized market row is invalid: ${problem}. No rows or checkpoint were committed.`)
}
