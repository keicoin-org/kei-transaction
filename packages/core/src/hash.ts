/**
 * Block hashing.
 *
 * M0 hashes a canonical JSON encoding of the block body under a versioned
 * domain-separation preamble. That is deliberately not a wire format: the byte
 * layout of `asset` blocks is the node fork's decision (M2), and inventing one
 * here would only mean inventing it twice. What M0 needs is a hash that is
 * deterministic, injective over the fields, and impossible to confuse with a
 * later version — see docs/decisions-m0.md.
 */

import type { BlockBody } from './blocks.js'
import { blake2b } from './crypto.js'
import { fail } from './errors.js'
import { bytesToHex, utf8 } from './hex.js'

const PREAMBLE = 'kei-block-v0'

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** Deterministic JSON: object keys sorted, `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

function normalize(value: unknown): Json {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(normalize)
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      if (!Number.isFinite(value)) fail('bad-block', `Cannot hash a non-finite number (${value}).`)
      return value
    case 'bigint':
      return value.toString()
    case 'object': {
      const source = value as Record<string, unknown>
      const out: { [key: string]: Json } = {}
      for (const key of Object.keys(source).sort()) {
        if (source[key] !== undefined) out[key] = normalize(source[key])
      }
      return out
    }
    default:
      fail('bad-block', `Cannot hash a value of type ${typeof value}.`)
  }
}

export function hashBlock(body: BlockBody): string {
  return bytesToHex(blake2b(utf8(`${PREAMBLE}\n${canonicalJson(body)}`), 32))
}
