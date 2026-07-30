/**
 * Addresses. Encoding is identical to Nano/Banano — base32-encoded public key
 * plus checksum — so tooling ports with a constant change (SPEC §5.8, §5.6.8).
 * Only the prefix differs: `kei_`.
 *
 * Encoding is delegated to bananojs. Decoding is implemented here because
 * bananojs validates the `ban_`/`nano_` prefixes and rejects `kei_`; the test
 * suite pins this decoder against bananojs's encoder in both prefixes so the
 * two cannot drift.
 */

import { blake2b, encodeAddress } from './crypto.js'
import { fail } from './errors.js'
import { bytesToHex, hexToBytes, isHex } from './hex.js'

export const ADDRESS_PREFIX = 'kei_'

/** Nano's base32 alphabet: no 0, 2, l, or v. */
const ALPHABET = '13456789abcdefghijkmnopqrstuwxyz'
const BODY_LENGTH = 52
const CHECKSUM_LENGTH = 8

export function addressFromPublicKey(publicKey: string): string {
  if (!isHex(publicKey, 32)) {
    fail('bad-public-key', `A public key is 64 hex characters — got "${publicKey}".`)
  }
  return encodeAddress(publicKey.toUpperCase(), ADDRESS_PREFIX)
}

function decodeBase32(text: string): bigint {
  let value = 0n
  for (const character of text) {
    const digit = ALPHABET.indexOf(character)
    if (digit < 0) fail('bad-address', `"${character}" is not a valid character in a Kei address.`)
    value = value * 32n + BigInt(digit)
  }
  return value
}

function bigintToFixedBytes(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length)
  let rest = value
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}

/** Checksum bytes for a public key: blake2b-40 of the key, reversed. */
function checksumOf(publicKey: Uint8Array): Uint8Array {
  return blake2b(publicKey, 5).slice().reverse()
}

export function publicKeyFromAddress(address: string): string {
  if (typeof address !== 'string' || !address.startsWith(ADDRESS_PREFIX)) {
    fail('bad-address', `A Kei address starts with "${ADDRESS_PREFIX}" — got "${String(address)}".`)
  }
  const body = address.slice(ADDRESS_PREFIX.length)
  if (body.length !== BODY_LENGTH + CHECKSUM_LENGTH) {
    fail(
      'bad-address',
      `A Kei address is ${ADDRESS_PREFIX.length + BODY_LENGTH + CHECKSUM_LENGTH} characters long — "${address}" is ${address.length}.`,
    )
  }

  const keyValue = decodeBase32(body.slice(0, BODY_LENGTH))
  if (keyValue >= 1n << 256n) fail('bad-address', `"${address}" is not a valid Kei address.`)
  const publicKey = bigintToFixedBytes(keyValue, 32)

  const expected = checksumOf(publicKey)
  const actual = bigintToFixedBytes(decodeBase32(body.slice(BODY_LENGTH)), 5)
  for (let i = 0; i < 5; i++) {
    if (expected[i] !== actual[i]) {
      fail('bad-address', `"${address}" failed its checksum — check for a typo.`)
    }
  }
  return bytesToHex(publicKey)
}

/** The all-zero public key, encoded. Nothing can sign for it. */
export const ZERO_ADDRESS = addressFromPublicKey('0'.repeat(64))

/**
 * A representative that cannot vote. Reserve accounts must name it, so reserve
 * Kei carries neither governance nor consensus weight (SPEC §5.7).
 */
export const NULL_REPRESENTATIVE = ZERO_ADDRESS

export function isAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    publicKeyFromAddress(value)
    return true
  } catch {
    return false
  }
}

/** Throw a sentence naming the fix if `value` is not a usable address. */
export function assertAddress(value: unknown, label = 'address'): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('bad-address', `Missing ${label} — pass a Kei address like ${ADDRESS_PREFIX}3abc...`)
  }
  publicKeyFromAddress(value)
  return value
}

export function publicKeyBytesFromAddress(address: string): Uint8Array {
  return hexToBytes(publicKeyFromAddress(address))
}
