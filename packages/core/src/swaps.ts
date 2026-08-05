/**
 * What a node says about a swap, checked before anything believes it.
 *
 * Every other RPC in this client parses JSON and returns it through a
 * TypeScript assertion, which is a compile-time claim about a value the
 * compiler never saw. For most reads that costs a confusing stack trace. For
 * the two swap reads it costs more: an offer row is the market's whole read
 * model, and `accept()` re-reads one as its last authority before a signature.
 * A row that arrives malformed, truncated, or doctored is used as a verified
 * market fact — a forged `from`, an amount `BigInt()` cannot parse, an
 * "accepted" offer with nothing that accepted it.
 *
 * So both actions parse through the one reader below, and the row that comes
 * out is built field by field rather than passed through. Two consequences are
 * deliberate:
 *
 * **A row is rejected whole, and a page with a bad row in it is rejected
 * whole.** Dropping the bad row and keeping the rest would make an offer
 * disappear silently, and a listing that vanishes from one read and returns in
 * the next is how a double-sale story starts. The caller finds out instead:
 * over a multi-account market read the refusal lands in `coverage.failed` for
 * that one account while the other chains still answer, and a direct read fails
 * closed before anything is signed.
 *
 * **Fields this SDK does not know about are dropped, not carried.** A
 * structurally valid row is a row whose *shape* is trustworthy; it is not a
 * confirmed one. The node contract has no confirmation or finality metadata yet
 * (keicoin-org/kei-node#27), and nothing here infers any from a height, a
 * state, or a timestamp — `seenAt` and `settledAt` stay what docs/rpc.md says
 * they are, one node's local observation. Chain revalidation before signing
 * stays mandatory (SPEC §9.4).
 *
 * No message here repeats a value the node sent. A bad row is untrusted input
 * on its way into a log or an issue and SPEC §6.6 has no exceptions in it, so a
 * refusal names the action, the row's index and the field, and describes what
 * arrived by its type alone.
 */

import { isAddress } from './address.js'
import { KeiError } from './errors.js'
import type { SwapOffer, SwapState } from './node.js'

/** Raw amounts are 16 bytes wide on the wire (`wire.ts`), so this is the widest one a block can carry. */
const MAX_RAW = 2n ** 128n - 1n

/** Hashes and asset ids are 32 bytes of hex, and this SDK writes them uppercase (`hex.ts`). */
const HEX_32 = /^[0-9A-Fa-f]{64}$/

/** Raw units, canonical: no sign, no leading zero, no exponent, and never zero. */
const RAW = /^[1-9][0-9]*$/

const STATES = new Set<string>(['open', 'accepted', 'cancelled'])

const ADVICE =
  'Nothing from that answer was used and nothing was signed. Read this from a node you operate or trust, or retry once it has synced.'

/**
 * One offer row, validated.
 *
 * `where` names the row inside its response — `'The offer'` for `swap_info`,
 * `'Offer at index 3'` for a page — so a caller reading a coverage failure
 * knows which row it was without being handed the row.
 */
export function parseSwapOffer(value: unknown, action: string, where = 'The offer'): SwapOffer {
  const bad = (problem: string): KeiError =>
    new KeiError(
      'invalid-node-response',
      `${where} in the node's "${action}" answer cannot be trusted: ${problem}. ${ADVICE}`,
    )

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw bad(`an offer is an object, and this is ${describe(value)}`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw bad('an offer cannot inherit its fields from another object')
  }

  // Read through the descriptor rather than the property: a getter answers a
  // different value every time it is asked, and a row that can change between
  // being checked and being used was never checked.
  const field = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined) throw bad(`${key} is missing`)
    if (!Object.hasOwn(descriptor, 'value')) {
      throw bad(`${key} must be a plain field, not one the offer computes on every read`)
    }
    return descriptor.value
  }

  const hex = (key: string): string => {
    const raw = field(key)
    if (typeof raw !== 'string' || !HEX_32.test(raw)) {
      throw bad(`${key} must be 64 hexadecimal characters, and it is ${describe(raw)}`)
    }
    return raw.toUpperCase()
  }

  const address = (key: string): string => {
    const raw = field(key)
    if (!isAddress(raw)) throw bad(`${key} must be a Kei address, and it is ${describe(raw)}`)
    return raw
  }

  const amount = (key: string): string => {
    const raw = field(key)
    if (typeof raw !== 'string' || !RAW.test(raw)) {
      throw bad(
        `${key} must be a positive whole number of raw units written as a decimal string, and it is ${describe(raw)}`,
      )
    }
    if (BigInt(raw) > MAX_RAW) throw bad(`${key} is larger than any amount a block can carry`)
    return raw
  }

  const whole = (key: string, floor: number, what: string): number => {
    const raw = field(key)
    if (!Number.isSafeInteger(raw) || (raw as number) < floor) {
      throw bad(`${key} must be ${what}, and it is ${describe(raw)}`)
    }
    return raw as number
  }

  const orNull = <T>(key: string, read: (key: string) => T): T | null =>
    field(key) === null ? null : read(key)

  const observed = 'a whole number of milliseconds since the epoch'

  const hash = hex('hash')
  const from = address('from')
  const asset = hex('asset')
  const amountRaw = amount('amount')
  const wantAsset = hex('wantAsset')
  const wantAmount = amount('wantAmount')
  const counterparty = orNull('counterparty', address)
  const expiresAt = orNull('expiresAt', (key) => whole(key, 1, observed))
  const rawState = field('state')
  if (typeof rawState !== 'string' || !STATES.has(rawState)) {
    throw bad(`state must be "open", "accepted" or "cancelled", and it is ${describe(rawState)}`)
  }
  const state = rawState as SwapState
  const settledBy = orNull('settledBy', hex)
  const acceptedBy = orNull('acceptedBy', address)
  // Height counts from the account's first block, so an offer's is never 0.
  const height = whole('height', 1, 'a whole number from 1 upward')
  const seenAt = whole('seenAt', 0, observed)
  const settledAt = orNull('settledAt', (key) => whole(key, 0, observed))

  // An offer is consumed by exactly one of accept or cancel and never both
  // (SPEC §9.2), so the settlement fields are not independent of `state`. A row
  // that disagrees with itself is the shape a forged trade takes: an "accepted"
  // offer nobody accepted is a price print with no counterparty behind it.
  if (state === 'open' && (settledBy !== null || acceptedBy !== null || settledAt !== null)) {
    throw bad('an open offer has nothing that settled it, so settledBy, acceptedBy and settledAt are all null')
  }
  if (state === 'accepted' && (settledBy === null || acceptedBy === null || settledAt === null)) {
    throw bad('an accepted offer names the block that settled it, who accepted it, and when this node saw that')
  }
  if (state === 'cancelled' && (settledBy === null || acceptedBy !== null || settledAt === null)) {
    throw bad('a cancelled offer names the block that cancelled it and when this node saw that, and nobody accepted it')
  }

  return {
    hash,
    from,
    asset,
    amount: amountRaw,
    wantAsset,
    wantAmount,
    counterparty,
    expiresAt,
    state,
    settledBy,
    acceptedBy,
    height,
    seenAt,
    settledAt,
  }
}

/**
 * A `swap_info` answer, including the check that it answers the question asked.
 *
 * A response carrying some *other* offer is the cheapest substitution attack
 * there is on `accept()`, and it costs a proxy nothing to make.
 */
export function parseSwapInfo(body: unknown, hash: string): SwapOffer | null {
  const envelope = responseObject(body, 'swap_info')
  const offer = envelopeField(envelope, 'offer', 'swap_info')
  if (offer === null) return null
  const parsed = parseSwapOffer(offer, 'swap_info')
  const asked = String(hash).toUpperCase()
  if (parsed.hash !== asked) {
    throw new KeiError(
      'invalid-node-response',
      `The node answered a request for offer ${asked} with offer ${parsed.hash}. ${ADVICE}`,
    )
  }
  return parsed
}

/**
 * An `account_swaps` page: bounded, every row valid, and every row this
 * account's own.
 *
 * `limit` is the `count` the request carried. More rows than were asked for is
 * not a generous node — it is rows the walk's own paging never accounted for.
 */
export function parseAccountSwaps(
  body: unknown,
  account: string,
  options: { limit: number; state?: SwapState },
): SwapOffer[] {
  const envelope = responseObject(body, 'account_swaps')
  const offers = envelopeField(envelope, 'offers', 'account_swaps')
  if (!Array.isArray(offers)) {
    throw badPage(`offers must be a list of offers, and it is ${describe(offers)}`)
  }
  const length: unknown = offers.length
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    throw badPage('the list of offers has no usable length')
  }
  if ((length as number) > options.limit) {
    throw badPage(
      `the list holds ${length as number} offers and this read asked for at most ${options.limit}`,
    )
  }
  const rows: SwapOffer[] = []
  for (let index = 0; index < (length as number); index += 1) {
    const where = `Offer at index ${index}`
    if (!Object.hasOwn(offers, index)) throw badPage(`there is no offer at index ${index}`)
    const row = parseSwapOffer(offers[index], 'account_swaps', where)
    // An offer lives on its author's chain (SPEC §9.1), so a row written by
    // somebody else is not this account's page, whatever it says about itself.
    if (row.from !== account) {
      throw badPage(`the offer at index ${index} was written by a different account than ${account}`)
    }
    if (options.state !== undefined && row.state !== options.state) {
      throw badPage(
        `the offer at index ${index} is ${row.state} and this read asked only for ${options.state} offers`,
      )
    }
    rows.push(row)
  }
  return rows
}

function badPage(problem: string): KeiError {
  return new KeiError(
    'invalid-node-response',
    `The node's "account_swaps" answer cannot be trusted: ${problem}. ${ADVICE}`,
  )
}

function responseObject(body: unknown, action: string): object {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new KeiError(
      'invalid-node-response',
      `The node's "${action}" answer is ${describe(body)} rather than a response object. ${ADVICE}`,
    )
  }
  return body
}

/**
 * The one field the envelope is about, and it has to be there. An absent one
 * used to default to "no offers", which reads on screen as an empty market and
 * is the one thing a broken answer must never be mistaken for.
 */
function envelopeField(envelope: object, key: string, action: string): unknown {
  if (!Object.hasOwn(envelope, key)) {
    throw new KeiError(
      'invalid-node-response',
      `The node's "${action}" answer has no "${key}" in it, so there is nothing to read — an answer missing its ${key} is not an empty one. ${ADVICE}`,
    )
  }
  return (envelope as Record<string, unknown>)[key]
}

/** What arrived, by type alone. Never the value: this is untrusted text. */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'absent'
  if (Array.isArray(value)) return 'a list'
  const type = typeof value
  if (type === 'number') return Number.isFinite(value) ? 'a number' : 'not a finite number'
  if (type === 'object') return 'an object'
  return `a ${type}`
}
