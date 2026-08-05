/**
 * Proof that a wallet controls its address, and nothing else.
 *
 * A Kei address is public, so a game server cannot take a connecting client's
 * word for the one it claims. Asking for a signature is the only answer, and
 * the dangerous way to build one is to let the server name 32 bytes and have
 * the wallet sign them: the bytes a hostile server would pick are the hash of a
 * send. So a wallet signs only a digest it derived itself, from a structured
 * challenge, under a domain no block hash can share.
 *
 * The shape is `claimStoreAdmissionHash` (client.ts) generalised — a fixed
 * domain constant, then canonical JSON of exactly the fields that are signed.
 * The caller's own namespace travels *inside* that JSON rather than as the byte
 * prefix, so no `domain` a caller can choose moves the leading bytes of the
 * preimage.
 *
 * | what             | preimage begins with                                  |
 * |------------------|-------------------------------------------------------|
 * | consensus block  | `blake2b-256("kei-block-v1")`, 32 raw bytes            |
 * | local-only block | the ASCII `kei-block-local-v0` and a newline           |
 * | claim store      | the ASCII `kei-claim-store-admission-v2` and a newline |
 * | ownership        | the ASCII `kei-ownership-challenge-v1` and a newline   |
 *
 * `packages/kei/test/ownership.test.ts` asserts that against the real hasher
 * rather than trusting this table.
 *
 * Nothing here reads a seed. `signOwnershipChallenge` needs the private key and
 * therefore lives on `KeiClient`; everything a server does is in this file and
 * needs only the address (SPEC §6.3, §6.6).
 */

import { isAddress, publicKeyFromAddress } from './address.js'
import { blake2b, verifyHash } from './crypto.js'
import { fail } from './errors.js'
import { canonicalJson } from './hash.js'
import { bytesToHex, isHex, utf8 } from './hex.js'
import { randomSalt } from './merkle.js'

const OWNERSHIP_DOMAIN = 'kei-ownership-challenge-v1\n'

/** Long enough for a URL-shaped namespace with a version on the end. */
export const MAX_CHALLENGE_DOMAIN = 128
export const MAX_CHALLENGE_CONTEXT_ENTRIES = 16
export const MAX_CHALLENGE_CONTEXT_KEY = 64
export const MAX_CHALLENGE_CONTEXT_VALUE = 256

/** What a context entry may hold. Anything else is refused, not coerced. */
export type ChallengeContextValue = string | number | boolean | null

export interface OwnershipChallenge {
  /**
   * The caller's own namespace, e.g. `'example.com/my-game/session/v1'`.
   *
   * Signed, so a proof made for one game does not verify for another, and a
   * version bump retires every outstanding proof of the old shape.
   */
  domain: string
  /** The address being proved. Must be the signing wallet's own. */
  address: string
  /** Server-generated, one use. `randomChallengeNonce()` produces one. */
  nonce: string
  /** Whatever else the proof is bound to — a room, a session, a match. */
  context?: Readonly<Record<string, ChallengeContextValue>>
}

/**
 * A challenge as it arrives over a wire, where `hash` is a courtesy.
 *
 * A server that computed the digest may send it so the wallet can say "we are
 * not hashing the same thing" instead of producing a signature nobody can
 * verify. It is checked against the digest this SDK derives and never signed as
 * given — that distinction is the whole security property.
 */
export interface OwnershipChallengeMessage extends OwnershipChallenge {
  hash?: string
}

export interface OwnershipProof {
  address: string
  signature: string
  challenge: OwnershipChallenge
}

export interface OwnershipExpectation extends OwnershipChallenge {
  /**
   * Where one-use is enforced. Without it a proof verifies every time it is
   * presented, which is a replay.
   */
  nonces?: NonceStore
}

export interface NonceStore {
  /**
   * Claim a nonce. `false` means it was claimed before, which is a replay.
   *
   * One synchronous step on purpose: a `has` followed by an `add` is two, and
   * two concurrent verifications of the same proof both pass between them.
   */
  use(nonce: string): boolean
}

const SIGNED_FIELDS = ['domain', 'address', 'nonce', 'context']
const CHALLENGE_FIELDS = [...SIGNED_FIELDS, 'hash']
const PROOF_FIELDS = ['address', 'signature', 'challenge']
const SIGNATURE = /^[0-9a-fA-F]{128}$/

/** A nonce is 32 bytes in hex. Not a secret, just unrepeatable. */
export function randomChallengeNonce(): string {
  return randomSalt()
}

/**
 * The digest a proof covers.
 *
 * Parses first, so there is no way to hash a structure that was never checked
 * and no second definition of what "the challenge" means.
 */
export function ownershipChallengeHash(challenge: OwnershipChallengeMessage): string {
  return digestOf(parseOwnershipChallenge(challenge))
}

/**
 * The strict reading of a challenge, wherever it came from.
 *
 * It rebuilds the challenge rather than blessing the object it was handed, so
 * the digest covers exactly the four known fields — a fifth would otherwise
 * ride along into `canonicalJson` and change what was signed. Unknown fields
 * are refused rather than dropped, because whoever sent one is not speaking
 * this version and should be told so.
 */
export function parseOwnershipChallenge(value: unknown): OwnershipChallenge {
  if (typeof value === 'string') {
    fail(
      'bad-challenge',
      'An ownership challenge is an object, not a digest: pass { domain, address, nonce }. A wallet that signed 32 bytes it was handed would sign whatever the other side chose, including the hash of a send.',
    )
  }
  const source = plainObject(value, 'ownership challenge')
  for (const key of Object.keys(source)) {
    if (!CHALLENGE_FIELDS.includes(key)) {
      fail(
        'bad-challenge',
        `An ownership challenge carries domain, address, nonce, and an optional context — ${label(key)} is not one of them. Put your own fields inside context, where they are signed too.`,
      )
    }
  }

  const context = contextOf(source.context)
  const challenge: OwnershipChallenge = {
    domain: domainOf(source.domain),
    address: addressOf(source.address),
    nonce: nonceOf(source.nonce),
    ...(context === undefined ? {} : { context }),
  }

  if (source.hash !== undefined) {
    const hash = source.hash
    if (typeof hash !== 'string' || hash.toUpperCase() !== digestOf(challenge)) {
      fail(
        'challenge-hash-mismatch',
        'That challenge does not hash to the digest it arrived with, so it is not safe to sign. Send the challenge without a hash to sign it as written, or fix whichever side is building a different one.',
      )
    }
  }
  return challenge
}

/**
 * Check a proof against the challenge you issued. Needs the address and no key.
 *
 * Returns `false` for anything an untrusted client could have sent — a bad
 * signature, a proof of some other challenge, a replay — and never puts the
 * proof in an error. It throws only when `expected` is itself malformed, which
 * is the calling server's own bug and the one case a sentence can fix.
 */
export async function verifyOwnershipProof(
  proof: unknown,
  expected: OwnershipExpectation,
): Promise<boolean> {
  const challenge = parseOwnershipChallenge(stripStore(expected))
  const digest = digestOf(challenge)

  let signature: string
  try {
    const source = plainObject(proof, 'ownership proof')
    for (const key of Object.keys(source)) {
      if (!PROOF_FIELDS.includes(key)) return false
    }
    if (source.address !== challenge.address) return false
    if (digestOf(parseOwnershipChallenge(source.challenge)) !== digest) return false
    if (typeof source.signature !== 'string' || !SIGNATURE.test(source.signature)) return false
    signature = source.signature
  } catch {
    return false
  }

  if (!(await verifyHash(digest, signature, publicKeyFromAddress(challenge.address)))) return false
  // Last, and only once the signature is good: a wrong guess must not burn the
  // nonce an honest client is still holding.
  return expected.nonces === undefined ? true : expected.nonces.use(challenge.nonce)
}

/**
 * Remember which nonces have been spent, in this process, up to a limit.
 *
 * Be honest about the two edges. Eviction is what bounds the memory, so the
 * oldest nonce becomes replayable again — size the limit above the number of
 * challenges you have outstanding at once, and stop accepting a challenge long
 * before it could be evicted. And this is one process: a fleet behind a load
 * balancer needs one shared store, which is what the `NonceStore` interface is
 * for.
 */
export function createNonceStore(options: { limit?: number } = {}): NonceStore {
  const limit = options.limit ?? 10_000
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) {
    fail(
      'bad-nonce-store',
      `A nonce store holds a whole number of nonces from 1 through 1,000,000, not ${String(limit)}. There is deliberately no unlimited setting.`,
    )
  }

  const seen = new Set<string>()
  return {
    use(nonce: string): boolean {
      const key = nonce.toUpperCase()
      if (seen.has(key)) return false
      seen.add(key)
      if (seen.size > limit) {
        const oldest = seen.values().next()
        if (!oldest.done) seen.delete(oldest.value)
      }
      return true
    },
  }
}

function digestOf(challenge: OwnershipChallenge): string {
  return bytesToHex(blake2b(utf8(`${OWNERSHIP_DOMAIN}${canonicalJson(challenge)}`), 32))
}

/** `nonces` is the server's own machinery and is not part of the challenge. */
function stripStore(expected: OwnershipExpectation): unknown {
  if (typeof expected !== 'object' || expected === null) return expected
  const { nonces: _nonces, ...challenge } = expected
  return challenge
}

function domainOf(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_CHALLENGE_DOMAIN ||
    hasControlCharacter(value)
  ) {
    fail(
      'bad-challenge',
      `A challenge domain is your own namespace, 1 to ${MAX_CHALLENGE_DOMAIN} printable characters, for example 'example.com/my-game/session/v1'. Version it, so changing what you bind a session to retires the proofs of the old shape.`,
    )
  }
  return value
}

function addressOf(value: unknown): string {
  if (!isAddress(value)) {
    fail(
      'bad-challenge',
      `A challenge names the Kei address it is proving — ${label(String(value))} is not one. Use the address the client claimed, and the wallet will refuse it unless it is that wallet's own.`,
    )
  }
  return value
}

function nonceOf(value: unknown): string {
  if (!isHex(value, 32)) {
    fail(
      'bad-challenge',
      'A challenge nonce is 64 hexadecimal characters, generated by whoever is asking: randomChallengeNonce(). It is what makes a proof answer this request and no other.',
    )
  }
  return value.toUpperCase()
}

function contextOf(value: unknown): Record<string, ChallengeContextValue> | undefined {
  if (value === undefined) return undefined
  const source = plainObject(value, 'challenge context')
  const keys = Object.keys(source)
  // An absent context and an empty one say the same thing, so they hash the
  // same: two sides that build the challenge differently still agree.
  if (keys.length === 0) return undefined
  if (keys.length > MAX_CHALLENGE_CONTEXT_ENTRIES) {
    fail(
      'bad-challenge',
      `A challenge context holds up to ${MAX_CHALLENGE_CONTEXT_ENTRIES} entries, not ${keys.length}. It binds a proof to one session; it is not a place to carry game state.`,
    )
  }

  const out: Record<string, ChallengeContextValue> = {}
  for (const key of keys) {
    if (key.length < 1 || key.length > MAX_CHALLENGE_CONTEXT_KEY || hasControlCharacter(key)) {
      fail(
        'bad-challenge',
        `A challenge context key is 1 to ${MAX_CHALLENGE_CONTEXT_KEY} printable characters — ${label(key)} is not.`,
      )
    }
    out[key] = contextValueOf(source[key], key)
  }
  return out
}

function contextValueOf(value: unknown, key: string): ChallengeContextValue {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('bad-challenge', `The challenge context entry ${label(key)} must be a finite number.`)
    }
    return value
  }
  if (typeof value === 'string') {
    if (value.length > MAX_CHALLENGE_CONTEXT_VALUE || hasControlCharacter(value)) {
      fail(
        'bad-challenge',
        `The challenge context entry ${label(key)} must be at most ${MAX_CHALLENGE_CONTEXT_VALUE} printable characters.`,
      )
    }
    return value
  }
  fail(
    'bad-challenge',
    `A challenge context holds strings, numbers, booleans and null — ${label(key)} holds a ${Array.isArray(value) ? 'array' : typeof value}. Flatten it, or put the whole thing in one string, so both sides sign the same bytes.`,
  )
}

/** Own data properties only — a getter or an inherited field is not a message. */
function plainObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('bad-challenge', `That ${what} is not an object.`)
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    // A getter can answer once for the check and differently for the use, so
    // "checked and signed the same bytes" would be likely rather than true.
    if (!descriptor || !('value' in descriptor)) {
      fail('bad-challenge', `That ${what} has an accessor where a value belongs.`)
    }
    out[key] = descriptor.value
  }
  return out
}

/** Quoted and cut, because the text being described came from somebody else. */
function label(value: string): string {
  return JSON.stringify(value.slice(0, 64))
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}
