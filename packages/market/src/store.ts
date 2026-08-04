import { blake2b, bytesToHex, KeiError, isAddress, utf8 } from '@keicoin/core'

import { deadlineOf } from './catalog.js'
import {
  loadEnvelope,
  cursorSecretFor,
  throwIfStopped,
  updateEnvelope,
  type MarketMemoryStorageAdapter,
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
  /** Monotonic poll generation within this exact network/source/account/filter scope. */
  readonly generation: number
  readonly instrument?: { readonly base: string; readonly quote: string }
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
  readonly durability: 'memory'
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
  readonly durability: 'memory'
  materialize(input: MaterializedPageInput): Promise<MaterializedPageReceipt>
  offers(query: StoredOfferQuery): Promise<StoredOfferPage>
  checkpoint(query: {
    network: string
    source: string
    account: string
    adapterVersion: number
    instrument?: { readonly base: string; readonly quote: string }
    deadlineMs?: number
    signal?: AbortSignal
  }): Promise<SourceCheckpointInput | null>
  quarantine(query?: { limit?: number; deadlineMs?: number; signal?: AbortSignal }): Promise<readonly RejectedMarketRowInput[]>
}

export interface MarketStoreOptions {
  readonly storage: MarketMemoryStorageAdapter
  readonly now?: () => number
}

export function createMarketStore(options: MarketStoreOptions): MarketStore {
  const storage = options.storage
  const now = options.now ?? Date.now
  const cursorSecret = cursorSecretFor(storage)
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
        if (checkpoint.base !== null && (offer.giveAsset !== checkpoint.base || offer.wantAsset !== checkpoint.quote)) {
          throw badRow('every offer in a filtered page must match its checkpoint instrument scope')
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
          if (compareCheckpoint(checkpoint, prior) > 0) checkpointRows[checkpointIndex] = checkpoint
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
      const scope = offerQueryScope(parsed)
      const after = storeCursorOf(parsed.cursor, envelope.offerRevision, scope, cursorSecret)
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
        nextCursor: more && last ? storeCursor(envelope.offerRevision, scope, cursorSecret, `${last.network}\u0000${last.hash}`) : null,
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
  const network = networkOf(ownValue(value, 'network'))
  const hash = hashOf(ownValue(value, 'hash'))
  const author = addressOf(ownValue(value, 'author'), 'author')
  const give = legOf(ownValue(value, 'give'), 'give')
  const want = legOf(ownValue(value, 'want'), 'want')
  if (give.asset === want.asset) throw badRow('offer legs must use different assets')
  const counterparty = nullableAddressOf(ownValue(value, 'counterparty'), 'counterparty')
  const acceptedBy = nullableAddressOf(ownValue(value, 'acceptedBy'), 'acceptedBy')
  const settledBy = nullableHashOf(ownValue(value, 'settledBy'), 'settledBy')
  const state = ownValue(value, 'state')
  const settledAtValue = ownValue(value, 'settledAt')
  if (typeof state !== 'string' || !['open', 'accepted', 'cancelled'].includes(state)) throw badRow('state is invalid')
  if (state === 'open' && (acceptedBy !== null || settledBy !== null || settledAtValue !== null)) {
    throw badRow('an open offer cannot carry settlement fields')
  }
  if (state === 'accepted' && (acceptedBy === null || settledBy === null || settledAtValue === null)) {
    throw badRow('an accepted offer needs acceptedBy, settledBy, and settledAt')
  }
  if (state === 'cancelled' && (acceptedBy !== null || settledBy === null || settledAtValue === null)) {
    throw badRow('a cancelled offer needs settledBy/settledAt and cannot have acceptedBy')
  }
  const height = safeInteger(ownValue(value, 'height'), 1, Number.MAX_SAFE_INTEGER, 'height')
  const seenAt = safeInteger(ownValue(value, 'seenAt'), 0, Number.MAX_SAFE_INTEGER, 'seenAt')
  const settledAt = settledAtValue === null ? null : safeInteger(settledAtValue, 0, Number.MAX_SAFE_INTEGER, 'settledAt')
  const source = textOf(ownValue(value, 'source'), 1, 128, 'source')
  const observedAt = safeInteger(ownValue(value, 'observedAt'), 0, Number.MAX_SAFE_INTEGER, 'observedAt')
  return {
    network,
    hash,
    author,
    giveAsset: give.asset,
    giveRaw: give.raw,
    wantAsset: want.asset,
    wantRaw: want.raw,
    counterparty,
    state: state as 'open' | 'accepted' | 'cancelled',
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
  const network = networkOf(ownValue(value, 'network'))
  const source = textOf(ownValue(value, 'source'), 1, 128, 'checkpoint source')
  const account = addressOf(ownValue(value, 'account'), 'checkpoint account')
  const adapterVersion = safeInteger(ownValue(value, 'adapterVersion'), 1, 1_000_000, 'adapterVersion')
  const generation = safeInteger(ownValue(value, 'generation'), 1, Number.MAX_SAFE_INTEGER, 'checkpoint generation')
  const instrumentValue = ownValue(value, 'instrument', false)
  const instrument = instrumentValue === undefined ? undefined : instrumentOf(instrumentValue as { base: string; quote: string })
  const observedAt = safeInteger(ownValue(value, 'observedAt'), 0, Number.MAX_SAFE_INTEGER, 'checkpoint observedAt')
  const newestHashValue = ownValue(value, 'newestHash')
  const newestHash = newestHashValue === null ? null : hashOf(newestHashValue)
  const providerCursorValue = ownValue(value, 'providerCursor')
  const providerCursor = providerCursorValue === null ? null : textOf(providerCursorValue, 1, 2_048, 'providerCursor')
  const stopReason = ownValue(value, 'stopReason')
  const exhausted = ownValue(value, 'exhausted')
  const reasons: readonly MarketIngestStopReason[] = ['exhausted', 'account_limit', 'request_limit', 'result_limit', 'byte_limit', 'page_limit', 'scan_limit', 'deadline', 'aborted', 'provider_error', 'unsupported_pagination']
  if (typeof stopReason !== 'string' || !reasons.includes(stopReason as MarketIngestStopReason)) throw badRow('checkpoint stopReason is invalid')
  if (typeof exhausted !== 'boolean') throw badRow('checkpoint exhausted must be boolean')
  if (exhausted && (stopReason !== 'exhausted' || providerCursor !== null)) {
    throw badRow('an exhausted checkpoint must say exhausted and have no provider cursor')
  }
  if (!exhausted && stopReason === 'exhausted') throw badRow('a non-exhausted checkpoint cannot say exhausted')
  return {
    key: checkpointKey(network, source, account, adapterVersion, instrument),
    network,
    source,
    account,
    adapterVersion,
    generation,
    base: instrument?.base ?? null,
    quote: instrument?.quote ?? null,
    observedAt,
    newestHash,
    providerCursor,
    exhausted,
    stopReason,
  }
}

function rejectedOf(value: RejectedMarketRowInput): StoredRejectedRow {
  return {
    network: networkOf(ownValue(value, 'network')),
    source: textOf(ownValue(value, 'source'), 1, 128, 'rejected source'),
    account: addressOf(ownValue(value, 'account'), 'rejected account'),
    observedAt: safeInteger(ownValue(value, 'observedAt'), 0, Number.MAX_SAFE_INTEGER, 'rejected observedAt'),
    reason: textOf(ownValue(value, 'reason'), 1, 512, 'rejected reason'),
  }
}

function validateStoredOffer(row: StoredOfferRecord): StoredOfferRecord {
  const sources = denseArray(ownValue(row, 'sources') as readonly string[], 'stored offer sources', 32).map((source) => textOf(source, 1, 128, 'stored source'))
  if (sources.length === 0) throw badRow('stored offer needs at least one provenance source')
  const input: StoredMarketOfferInput = {
    network: ownValue(row, 'network') as string,
    hash: ownValue(row, 'hash') as string,
    author: ownValue(row, 'author') as string,
    give: { asset: ownValue(row, 'giveAsset') as string, raw: ownValue(row, 'giveRaw') as string },
    want: { asset: ownValue(row, 'wantAsset') as string, raw: ownValue(row, 'wantRaw') as string },
    counterparty: ownValue(row, 'counterparty') as string | null,
    state: ownValue(row, 'state') as StoredMarketOfferInput['state'],
    acceptedBy: ownValue(row, 'acceptedBy') as string | null,
    settledBy: ownValue(row, 'settledBy') as string | null,
    height: ownValue(row, 'height') as number,
    seenAt: ownValue(row, 'seenAt') as number,
    settledAt: ownValue(row, 'settledAt') as number | null,
    source: sources[0] ?? 'invalid',
    observedAt: ownValue(row, 'firstObservedAt') as number,
  }
  const validated = offerOf(input)
  const last = safeInteger(ownValue(row, 'lastObservedAt'), validated.firstObservedAt, Number.MAX_SAFE_INTEGER, 'lastObservedAt')
  return { ...validated, sources: [...new Set(sources)].sort(compareText), lastObservedAt: last }
}

function validateCheckpoint(row: StoredSourceCheckpoint): StoredSourceCheckpoint {
  const base = ownValue(row, 'base')
  const quote = ownValue(row, 'quote')
  const parsed = checkpointOf({
    network: ownValue(row, 'network') as string,
    source: ownValue(row, 'source') as string,
    account: ownValue(row, 'account') as string,
    adapterVersion: ownValue(row, 'adapterVersion') as number,
    generation: ownValue(row, 'generation') as number,
    ...(base === null && quote === null ? {} : { instrument: { base: base as string, quote: quote as string } }),
    observedAt: ownValue(row, 'observedAt') as number,
    newestHash: ownValue(row, 'newestHash') as string | null,
    providerCursor: ownValue(row, 'providerCursor') as string | null,
    exhausted: ownValue(row, 'exhausted') as boolean,
    stopReason: ownValue(row, 'stopReason') as MarketIngestStopReason,
  })
  if (ownValue(row, 'key') !== parsed.key) throw badRow('stored checkpoint key does not match its scope')
  return parsed
}

function validateRejected(row: StoredRejectedRow): StoredRejectedRow {
  return rejectedOf({
    network: ownValue(row, 'network') as string,
    source: ownValue(row, 'source') as string,
    account: ownValue(row, 'account') as string,
    observedAt: ownValue(row, 'observedAt') as number,
    reason: ownValue(row, 'reason') as string,
  })
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
    generation: row.generation,
    ...(row.base === null && row.quote === null ? {} : { instrument: { base: row.base!, quote: row.quote! } }),
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

function checkpointKeyQueryOf(query: { network: string; source: string; account: string; adapterVersion: number; instrument?: { base: string; quote: string } }): { key: string } {
  const network = networkOf(query.network)
  const source = textOf(query.source, 1, 128, 'checkpoint source')
  const account = addressOf(query.account, 'checkpoint account')
  const version = safeInteger(query.adapterVersion, 1, 1_000_000, 'adapterVersion')
  const instrument = query.instrument === undefined ? undefined : instrumentOf(query.instrument)
  return { key: checkpointKey(network, source, account, version, instrument) }
}

function checkpointKey(network: string, source: string, account: string, version: number, instrument?: { base: string; quote: string }): string {
  return `${network}\u0000${source}\u0000${version}\u0000${account}\u0000${instrument?.base ?? '*'}\u0000${instrument?.quote ?? '*'}`
}

function offerKey(row: StoredOfferRecord): string {
  return `${row.network}\u0000${row.hash}`
}

function storeCursor(revision: number, scope: string, secret: string, key: string): string {
  let hex = ''
  for (let index = 0; index < key.length; index += 1) hex += key.charCodeAt(index).toString(16).padStart(4, '0')
  const payload = `mstore2.${revision}.${scope}.${hex}`
  return `${payload}.${cursorIntegrity(secret, payload)}`
}

function storeCursorOf(cursor: string | undefined, revision: number, scope: string, secret: string): string | null {
  if (cursor === undefined) return null
  const parts = cursor.split('.')
  if (parts.length !== 5 || parts[0] !== 'mstore2' || !/^\d+$/.test(parts[1]!) || parts[2] !== scope || !/^[0-9a-f]+$/.test(parts[3]!) || parts[3]!.length % 4 !== 0 || parts[3]!.length > 1_600) {
    throw new KeiError('bad-market-cursor', 'Stored offer cursor is malformed.')
  }
  if (Number(parts[1]) !== revision) throw new KeiError('stale-market-cursor', 'The materialized store changed; restart paging for a stable snapshot.')
  const payload = `mstore2.${parts[1]}.${scope}.${parts[3]}`
  if (parts[4] !== cursorIntegrity(secret, payload)) throw new KeiError('bad-market-cursor', 'Stored offer cursor failed its integrity check or belongs to another query.')
  let key = ''
  for (let index = 0; index < parts[3]!.length; index += 4) key += String.fromCharCode(Number.parseInt(parts[3]!.slice(index, index + 4), 16))
  return key
}

function offerQueryScope(query: ReturnType<typeof offerQueryOf>): string {
  return cursorIntegrity('public-query-scope', JSON.stringify({
    network: query.network,
    base: query.base ?? null,
    quote: query.quote ?? null,
    state: query.state ?? null,
    limit: query.limit,
    maxResultBytes: query.maxResultBytes,
  }))
}

function cursorIntegrity(secret: string, value: string): string {
  return bytesToHex(blake2b(utf8(`kei-market-cursor-v2\n${secret}\n${value}`), 16)).toLowerCase()
}

function instrumentOf(value: { readonly base: string; readonly quote: string }): { base: string; quote: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRow('checkpoint instrument must be an object')
  const base = assetOf(value.base, 'checkpoint instrument base')
  const quote = assetOf(value.quote, 'checkpoint instrument quote')
  if (base === quote) throw badRow('checkpoint instrument legs must differ')
  return { base, quote }
}

function compareCheckpoint(left: StoredSourceCheckpoint, right: StoredSourceCheckpoint): number {
  if (left.observedAt !== right.observedAt) return left.observedAt - right.observedAt
  if (left.generation !== right.generation) return left.generation - right.generation
  return compareText(checkpointOrder(left), checkpointOrder(right))
}

function checkpointOrder(value: StoredSourceCheckpoint): string {
  return JSON.stringify({
    newestHash: value.newestHash,
    providerCursor: value.providerCursor,
    exhausted: value.exhausted,
    stopReason: value.stopReason,
  })
}

function legOf(value: unknown, label: string): { asset: string; raw: string } {
  const raw = textOf(ownValue(value, 'raw'), 1, 256, `${label}.raw`)
  if (!/^[1-9]\d*$/.test(raw)) throw badRow(`${label}.raw must be a positive canonical integer string`)
  return { asset: assetOf(ownValue(value, 'asset'), `${label}.asset`), raw }
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

function ownValue(value: unknown, key: string, required = true): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRow('records must be plain own-property objects')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw badRow('inherited record fields are not accepted')
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) {
    if (!required) return undefined
    throw badRow(`${key} must be an own data property`)
  }
  if (!Object.hasOwn(descriptor, 'value')) throw badRow(`${key} cannot be an accessor property`)
  return descriptor.value
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function badRow(problem: string): KeiError {
  return new KeiError('bad-market-row', `A materialized market row is invalid: ${problem}. No rows or checkpoint were committed.`)
}
