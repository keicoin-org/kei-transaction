import { KeiError, isAddress, type SwapOffer } from '@keicoin/core'

import type { MarketCatalog, MarketInstrumentIdentity } from './catalog.js'
import type {
  MarketIngestStopReason,
  MarketStore,
  RejectedMarketRowInput,
  StoredMarketOfferInput,
} from './store.js'

export interface MarketReadBudget {
  readonly maxAccounts: number
  readonly maxRequests: number
  readonly maxResultsPerRequest: number
  readonly maxResultRows: number
  readonly maxResultBytes: number
  readonly maxPages: number
  readonly maxScannedBlocks?: number
  readonly deadlineMs: number
}

export const DEFAULT_MARKET_READ_BUDGET: MarketReadBudget = {
  maxAccounts: 64,
  maxRequests: 64,
  maxResultsPerRequest: 100,
  maxResultRows: 2_000,
  maxResultBytes: 1_000_000,
  maxPages: 8,
  deadlineMs: 10_000,
}

export interface AccountChainProvider {
  readonly network: string
  accountSwaps(
    account: string,
    options: { readonly limit: number },
  ): Promise<unknown>
}

export interface AccountChainIngestorOptions {
  readonly id: string
  readonly provider: AccountChainProvider
  readonly catalog: MarketCatalog
  readonly store: MarketStore
  readonly adapterVersion?: number
  readonly now?: () => number
}

export interface AccountChainIngestRequest {
  readonly instrument?: MarketInstrumentIdentity
  readonly cursor?: string
  readonly budget?: Partial<MarketReadBudget>
  readonly signal?: AbortSignal
}

export interface AccountChainIngestResult {
  readonly source: { readonly id: string; readonly network: string; readonly adapterVersion: number }
  readonly status: 'partial'
  readonly stopReason: MarketIngestStopReason
  readonly cursor: string | null
  readonly consumed: {
    readonly accounts: number
    readonly requests: number
    readonly pages: number
    readonly resultRows: number
    readonly resultBytes: number
  }
  readonly stored: { readonly inserted: number; readonly updated: number; readonly unchanged: number; readonly conflicts: number }
  readonly quarantined: number
  readonly failedAccounts: readonly { readonly account: string; readonly reason: string }[]
  readonly sourceBackfill: {
    readonly supported: false
    readonly complete: false
    readonly reason: 'unsupported_pagination'
    readonly scannedBlocks: 'unsupported'
  }
}

export interface AccountChainIngestor {
  readonly id: string
  readonly network: string
  readonly capabilities: {
    readonly storage: 'process-memory-reference'
    readonly catalogPaging: true
    readonly sourceBackfillPaging: false
    readonly scannedBlockBudget: false
    readonly atomicCheckpoints: true
  }
  ingest(request?: AccountChainIngestRequest): Promise<AccountChainIngestResult>
}

/**
 * Materialize today's bounded newest-window `account_swaps` RPC honestly.
 * Catalog traversal resumes, and each account's observation watermark commits
 * atomically with its rows. Chain-history backfill does not resume because the
 * current node RPC has no cursor/exhaustion proof (kei-node#27).
 */
export function createAccountChainIngestor(options: AccountChainIngestorOptions): AccountChainIngestor {
  if (typeof options !== 'object' || options === null) throw badSource('options must be an object')
  const id = textOf(options.id, 1, 128, 'source id')
  const network = networkOf(options.provider?.network)
  if (!options.provider || typeof options.provider.accountSwaps !== 'function') throw badSource('provider must implement accountSwaps()')
  if (!options.catalog || typeof options.catalog.participants !== 'function') throw badSource('catalog must implement participants()')
  if (!options.store || typeof options.store.materialize !== 'function') throw badSource('store must implement materialize()')
  const adapterVersion = integer(options.adapterVersion ?? 1, 1, 1_000_000, 'adapter version')
  const now = options.now ?? Date.now

  return {
    id,
    network,
    capabilities: {
      storage: 'process-memory-reference',
      catalogPaging: true,
      sourceBackfillPaging: false,
      scannedBlockBudget: false,
      atomicCheckpoints: true,
    },

    async ingest(request = {}) {
      // Validate the entire budget before catalog/storage/provider getters are touched.
      const budget = budgetOf(request.budget)
      const instrument = request.instrument === undefined ? undefined : instrumentOf(request.instrument)
      const signal = request.signal
      const startedAt = clock(now, 'Account-chain ingestion')
      if (startedAt > Number.MAX_SAFE_INTEGER - budget.deadlineMs) throw badSource('clock cannot represent the requested deadline')
      const deadlineAt = startedAt + budget.deadlineMs
      stopped(signal, now, deadlineAt)

      let cursor = request.cursor
      let accounts = 0
      let requests = 0
      let pages = 0
      let resultRows = 0
      let resultBytes = 0
      let inserted = 0
      let updated = 0
      let unchanged = 0
      let conflicts = 0
      let quarantined = 0
      const failedAccounts: { account: string; reason: string }[] = []
      let traversalComplete = false
      let budgetStop: MarketIngestStopReason | null = null

      while (pages < budget.maxPages && accounts < budget.maxAccounts && requests < budget.maxRequests) {
        stopped(signal, now, deadlineAt)
        const resultRoom = budget.maxResultRows - resultRows
        if (resultRoom <= 0) {
          budgetStop = 'result_limit'
          break
        }
        const room = Math.min(
          budget.maxAccounts - accounts,
          budget.maxRequests - requests,
          resultRoom,
          256,
        )
        const remaining = remainingMs(now, deadlineAt)
        const page = await options.catalog.participants({
          network,
          ...(instrument === undefined ? {} : { instrument }),
          limit: room,
          ...(cursor === undefined ? {} : { cursor }),
          deadlineMs: Math.min(remaining, 60_000),
          ...(signal === undefined ? {} : { signal }),
        })
        pages += 1
        let pageFailed = false

        for (const participant of page.rows) {
          stopped(signal, now, deadlineAt)
          if (accounts >= budget.maxAccounts) {
            budgetStop = 'account_limit'
            break
          }
          if (requests >= budget.maxRequests) {
            budgetStop = 'request_limit'
            break
          }
          const account = participant.address
          if (typeof account !== 'string' || account.length > 128 || !isAddress(account)) {
            failedAccounts.push({ account: typeof account === 'string' ? account.slice(0, 128) : '[invalid account]', reason: 'catalog returned an invalid address' })
            accounts += 1
            continue
          }
          const perRequestLimit = Math.min(budget.maxResultsPerRequest, budget.maxResultRows - resultRows)
          if (perRequestLimit < 1) {
            budgetStop = 'result_limit'
            break
          }
          accounts += 1
          requests += 1
          let raw: unknown
          let generation: number
          try {
            const prior = await options.store.checkpoint({
              network,
              source: id,
              account,
              adapterVersion,
              ...(instrument === undefined ? {} : { instrument }),
              deadlineMs: Math.min(remainingMs(now, deadlineAt), 60_000),
              ...(signal === undefined ? {} : { signal }),
            })
            generation = (prior?.generation ?? 0) + 1
            if (!Number.isSafeInteger(generation) || generation > Number.MAX_SAFE_INTEGER) {
              throw badSource('checkpoint generation is exhausted for this source scope')
            }
            raw = await within(
              Promise.resolve().then(() => options.provider.accountSwaps(account, { limit: perRequestLimit })),
              signal,
              now,
              deadlineAt,
            )
          } catch (error) {
            if (isStop(error)) {
              budgetStop = error.code === 'read-aborted' ? 'aborted' : 'deadline'
              break
            }
            failedAccounts.push({ account, reason: messageOf(error) })
            pageFailed = true
            continue
          }

          const observedAt = clock(now, 'Account-chain ingestion observation')
          let converted: ReturnType<typeof providerRows>
          try {
            converted = providerRows(raw, perRequestLimit, {
              network,
              source: id,
              account,
              observedAt,
            })
          } catch (error) {
            failedAccounts.push({ account, reason: messageOf(error) })
            pageFailed = true
            continue
          }
          if (resultRows + converted.totalRows > budget.maxResultRows) {
            budgetStop = 'result_limit'
            break
          }
          if (resultBytes + converted.bytes > budget.maxResultBytes) {
            budgetStop = 'byte_limit'
            break
          }
          resultRows += converted.totalRows
          resultBytes += converted.bytes
          const commit = await options.store.materialize({
            offers: converted.offers,
            checkpoint: {
              network,
              source: id,
              account,
              adapterVersion,
              generation,
              ...(instrument === undefined ? {} : { instrument }),
              observedAt,
              newestHash: converted.offers[0]?.hash ?? null,
              providerCursor: null,
              exhausted: false,
              stopReason: 'unsupported_pagination',
            },
            rejected: converted.rejected,
            deadlineMs: Math.min(remainingMs(now, deadlineAt), 60_000),
            ...(signal === undefined ? {} : { signal }),
          })
          inserted += commit.inserted
          updated += commit.updated
          unchanged += commit.unchanged
          conflicts += commit.conflicts
          quarantined += commit.quarantined
        }

        if (budgetStop !== null) break
        if (pageFailed) {
          budgetStop = 'provider_error'
          break
        }
        cursor = page.nextCursor ?? undefined
        if (page.nextCursor === null) {
          traversalComplete = true
          break
        }
      }

      if (budgetStop === null && !traversalComplete) {
        if (pages >= budget.maxPages) budgetStop = 'page_limit'
        else if (accounts >= budget.maxAccounts) budgetStop = 'account_limit'
        else if (requests >= budget.maxRequests) budgetStop = 'request_limit'
      }
      // Even a fully traversed catalog is only a newest-window observation with
      // today's node. Never translate that into complete chain history.
      return {
        source: { id, network, adapterVersion },
        status: 'partial',
        stopReason: budgetStop ?? 'unsupported_pagination',
        cursor: traversalComplete ? null : (cursor ?? request.cursor ?? null),
        consumed: { accounts, requests, pages, resultRows, resultBytes },
        stored: { inserted, updated, unchanged, conflicts },
        quarantined,
        failedAccounts,
        sourceBackfill: {
          supported: false,
          complete: false,
          reason: 'unsupported_pagination',
          scannedBlocks: 'unsupported',
        },
      }
    },
  }
}

function providerRows(
  value: unknown,
  limit: number,
  context: { network: string; source: string; account: string; observedAt: number },
): { offers: StoredMarketOfferInput[]; rejected: RejectedMarketRowInput[]; totalRows: number; bytes: number } {
  if (!Array.isArray(value)) throw badSource('accountSwaps() must return an array')
  const length: unknown = value.length
  if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > limit) {
    throw badSource(`accountSwaps() returned more than its ${limit}-row request budget`)
  }
  const offers: StoredMarketOfferInput[] = []
  const rejected: RejectedMarketRowInput[] = []
  let bytes = 0
  for (let index = 0; index < (length as number); index += 1) {
    if (!Object.hasOwn(value, index)) {
      rejected.push({ ...context, reason: `sparse provider row at index ${index}` })
      continue
    }
    try {
      const offer = providerOffer(value[index], context)
      offers.push(offer)
      bytes += offerBytes(offer)
    } catch (error) {
      rejected.push({ ...context, reason: messageOf(error).slice(0, 512) })
    }
  }
  return { offers, rejected, totalRows: length as number, bytes }
}

function providerOffer(value: unknown, context: { network: string; source: string; account: string; observedAt: number }): StoredMarketOfferInput {
  const hash = providerHash(ownProviderValue(value, 'hash'), 'offer hash')
  const author = providerAddress(ownProviderValue(value, 'from'), 'offer author')
  const giveAsset = asset(ownProviderValue(value, 'asset'), 'give asset')
  const giveRaw = providerRaw(ownProviderValue(value, 'amount'), 'give amount')
  const wantAsset = asset(ownProviderValue(value, 'wantAsset'), 'want asset')
  const wantRaw = providerRaw(ownProviderValue(value, 'wantAmount'), 'want amount')
  if (giveAsset === wantAsset) throw badSource('provider offer legs use the same asset')
  const counterpartyValue = ownProviderValue(value, 'counterparty')
  const counterparty = counterpartyValue === null ? null : providerAddress(counterpartyValue, 'counterparty')
  const state = ownProviderValue(value, 'state')
  if (typeof state !== 'string' || !['open', 'accepted', 'cancelled'].includes(state)) throw badSource('provider offer state is invalid')
  const acceptedByValue = ownProviderValue(value, 'acceptedBy')
  const acceptedBy = acceptedByValue === null ? null : providerAddress(acceptedByValue, 'acceptedBy')
  const settledByValue = ownProviderValue(value, 'settledBy')
  const settledBy = settledByValue === null ? null : providerHash(settledByValue, 'settledBy')
  const height = integer(ownProviderValue(value, 'height'), 1, Number.MAX_SAFE_INTEGER, 'offer height')
  const seenAt = integer(ownProviderValue(value, 'seenAt'), 0, Number.MAX_SAFE_INTEGER, 'offer seenAt')
  const settledAtValue = ownProviderValue(value, 'settledAt')
  const settledAt = settledAtValue === null ? null : integer(settledAtValue, 0, Number.MAX_SAFE_INTEGER, 'offer settledAt')
  if (state === 'open' && (acceptedBy !== null || settledBy !== null || settledAt !== null)) throw badSource('open provider offer carries settlement fields')
  if (state === 'accepted' && (acceptedBy === null || settledBy === null || settledAt === null)) throw badSource('accepted provider offer is missing settlement fields')
  if (state === 'cancelled' && (acceptedBy !== null || settledBy === null || settledAt === null)) throw badSource('cancelled provider offer has inconsistent settlement fields')
  return {
    network: context.network,
    hash,
    author,
    give: { asset: giveAsset, raw: giveRaw },
    want: { asset: wantAsset, raw: wantRaw },
    counterparty,
    state: state as SwapOffer['state'],
    acceptedBy,
    settledBy,
    height,
    seenAt,
    settledAt,
    source: context.source,
    observedAt: context.observedAt,
  }
}

function providerHash(value: unknown, label: string): string {
  const output = textOf(value, 64, 64, label).toUpperCase()
  if (!/^[0-9A-F]{64}$/.test(output)) throw badSource(`${label} must be 64 hexadecimal characters`)
  return output
}

function providerAddress(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 128 || !isAddress(value)) throw badSource(`${label} is not a canonical Kei address`)
  return value
}

function providerRaw(value: unknown, label: string): string {
  const output = textOf(value, 1, 256, label)
  if (!/^[1-9]\d*$/.test(output)) throw badSource(`${label} must be a positive canonical raw integer string`)
  return output
}

function budgetOf(input: Partial<MarketReadBudget> | undefined): MarketReadBudget {
  if (input !== undefined && (typeof input !== 'object' || input === null)) throw new KeiError('bad-market-budget', 'Market read budget must be an object.')
  const budget = input ?? {}
  const result: MarketReadBudget = {
    maxAccounts: budgetInteger(budget.maxAccounts, DEFAULT_MARKET_READ_BUDGET.maxAccounts, 1, 256, 'maxAccounts'),
    maxRequests: budgetInteger(budget.maxRequests, DEFAULT_MARKET_READ_BUDGET.maxRequests, 1, 256, 'maxRequests'),
    maxResultsPerRequest: budgetInteger(budget.maxResultsPerRequest, DEFAULT_MARKET_READ_BUDGET.maxResultsPerRequest, 1, 256, 'maxResultsPerRequest'),
    maxResultRows: budgetInteger(budget.maxResultRows, DEFAULT_MARKET_READ_BUDGET.maxResultRows, 1, 10_000, 'maxResultRows'),
    maxResultBytes: budgetInteger(budget.maxResultBytes, DEFAULT_MARKET_READ_BUDGET.maxResultBytes, 1, 10_000_000, 'maxResultBytes'),
    maxPages: budgetInteger(budget.maxPages, DEFAULT_MARKET_READ_BUDGET.maxPages, 1, 256, 'maxPages'),
    deadlineMs: budgetInteger(budget.deadlineMs, DEFAULT_MARKET_READ_BUDGET.deadlineMs, 1, 60_000, 'deadlineMs'),
    ...(budget.maxScannedBlocks === undefined
      ? {}
      : { maxScannedBlocks: budgetInteger(budget.maxScannedBlocks, 1, 1, 10_000_000, 'maxScannedBlocks') }),
  }
  return result
}

function instrumentOf(value: MarketInstrumentIdentity): MarketInstrumentIdentity {
  if (typeof value !== 'object' || value === null) throw badSource('instrument must be an object')
  const base = asset(value.base, 'instrument base')
  const quote = asset(value.quote, 'instrument quote')
  if (base === quote) throw badSource('instrument base and quote must differ')
  return { base, quote }
}

function asset(value: unknown, label: string): string {
  const output = textOf(value, 1, 128, label).toUpperCase()
  if (!/^[A-Z0-9:_-]+$/.test(output)) throw badSource(`${label} contains unsupported characters`)
  return output
}

function networkOf(value: unknown): string {
  const output = textOf(value, 1, 64, 'provider network').toLowerCase()
  if (!/^[a-z][a-z0-9.-]*$/.test(output)) throw badSource('provider network is not a canonical namespace')
  return output
}

function textOf(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw badSource(`${label} must be a printable string of ${minimum}-${maximum} characters`)
  return value
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw badSource(`${label} must be a safe integer from ${minimum} through ${maximum}`)
  return value as number
}

function budgetInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const chosen = value ?? fallback
  if (!Number.isSafeInteger(chosen) || chosen < minimum || chosen > maximum) throw new KeiError('bad-market-budget', `${label} must be a safe whole number from ${minimum} through ${maximum}; got ${String(chosen)}.`)
  return chosen
}

function clock(now: () => number, what: string): number {
  let value: unknown
  try {
    value = now()
  } catch {
    throw new KeiError('bad-market-clock', `${what} cannot use a clock that throws.`)
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new KeiError('bad-market-clock', `${what} needs a non-negative safe whole-millisecond clock.`)
  return value as number
}

function remainingMs(now: () => number, deadlineAt: number): number {
  const remaining = deadlineAt - clock(now, 'Account-chain ingestion')
  if (remaining < 1) throw new KeiError('market-deadline', 'Account-chain ingestion exceeded its total deadline.')
  return remaining
}

function stopped(signal: AbortSignal | undefined, now: () => number, deadlineAt: number): void {
  if (signal?.aborted === true) throw new KeiError('read-aborted', 'Account-chain ingestion was stopped; no new provider or storage work was started.')
  if (clock(now, 'Account-chain ingestion') >= deadlineAt) throw new KeiError('market-deadline', 'Account-chain ingestion exceeded its total deadline.')
}

async function within<T>(work: Promise<T>, signal: AbortSignal | undefined, now: () => number, deadlineAt: number): Promise<T> {
  stopped(signal, now, deadlineAt)
  const remaining = remainingMs(now, deadlineAt)
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const stop = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new KeiError('market-deadline', 'Account-chain ingestion exceeded its total deadline.')), Math.min(remaining, 2_147_483_647))
    if (signal && typeof signal.addEventListener === 'function') {
      abort = () => reject(new KeiError('read-aborted', 'Account-chain ingestion was stopped.'))
      signal.addEventListener('abort', abort, { once: true })
    }
  })
  try {
    return await Promise.race([work, stop])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abort && typeof signal?.removeEventListener === 'function') signal.removeEventListener('abort', abort)
  }
}

function isStop(error: unknown): error is KeiError {
  return error instanceof KeiError && (error.code === 'read-aborted' || error.code === 'market-deadline')
}

function offerBytes(offer: StoredMarketOfferInput): number {
  return (
    offer.network.length + offer.hash.length + offer.author.length + offer.give.asset.length + offer.give.raw.length +
    offer.want.asset.length + offer.want.raw.length + (offer.counterparty?.length ?? 0) + (offer.acceptedBy?.length ?? 0) +
    (offer.settledBy?.length ?? 0) + offer.source.length + 128
  ) * 2
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

function ownProviderValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badSource('provider row is not a plain offer object')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw badSource('provider rows cannot inherit offer fields')
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw badSource(`provider row ${key} must be an own data property`)
  return descriptor.value
}

function badSource(problem: string): KeiError {
  return new KeiError('bad-market-source', `The account-chain market source is invalid: ${problem}. No provider rows were trusted.`)
}
