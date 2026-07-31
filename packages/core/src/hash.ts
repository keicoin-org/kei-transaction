/**
 * Block hashing.
 *
 * M0 hashed canonical JSON under a `kei-block-v0` preamble because the byte
 * layout of `asset` blocks was the node fork's decision to make. It has been
 * made — decisions-m2.md §7 and §14 — so a block the node can validate now
 * hashes over the node's own bytes, which `wire.ts` produces. Signatures verify
 * across the two implementations only because of that.
 *
 * Two kinds of block have no such layout yet, and those keep a JSON hash under a
 * domain that says out loud it is not consensus. `nodeLayoutGap` names them and
 * says why. The separate domain is the point: such a block is *rejected* by a
 * node rather than accepted with a field quietly dropped, because the node
 * computes a different hash and the signature does not verify. Failing loudly at
 * `process` is the cheapest place to find out.
 */

import type { BlockBody } from './blocks.js'
import { blake2b } from './crypto.js'
import { fail } from './errors.js'
import { bytesToHex, utf8 } from './hex.js'
import { blockPreimage, nodeLayoutGap } from './wire.js'

/** Hashed by this SDK alone. No node computes it, which is the point. */
const LOCAL_PREAMBLE = 'kei-block-local-v0'

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

/**
 * The hash a signature covers.
 *
 * Consensus bytes where the node has a layout for this block, and a
 * self-declared local hash where it does not.
 */
export function hashBlock(body: BlockBody): string {
  if (nodeLayoutGap(body) !== null) {
    return bytesToHex(blake2b(utf8(`${LOCAL_PREAMBLE}\n${canonicalJson(body)}`), 32))
  }
  return bytesToHex(blake2b(blockPreimage(body), 32))
}
