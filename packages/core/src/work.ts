/**
 * Proof-of-work: the algorithm and its thresholds.
 *
 * The algorithm lives in core because the node has to *validate* work. Anything
 * to do with *obtaining* work — local generation, precompute, the work server
 * that SPEC §5.5 makes required v1 infrastructure — lives in `@kei/work`.
 *
 * Same shape as Nano/Banano: an 8-byte nonce whose blake2b digest against the
 * block's work root, read as a little-endian u64, must reach the tier
 * threshold (SPEC §5.6.4).
 */

import type { BlockBody, WorkTier } from './blocks.js'
import { ZERO_HASH } from './blocks.js'
import { publicKeyFromAddress } from './address.js'
import { blake2b } from './crypto.js'
import { fail } from './errors.js'
import { bytesToHex, concat, hexToBytes, isHex } from './hex.js'

/** Tier A is highest because minting is the cheapest abuse with the worst residue. */
export const DEFAULT_THRESHOLDS: Record<WorkTier, string> = {
  A: BigInt('0xFFFFFFC000000000').toString(),
  B: BigInt('0xFFFFFE0000000000').toString(),
  C: BigInt('0xFFFFC00000000000').toString(),
}

/**
 * The mock's thresholds. Low enough that a test suite is not a mining rig, high
 * enough that the generate-and-validate path is genuinely exercised.
 */
export const MOCK_THRESHOLDS: Record<WorkTier, string> = {
  A: BigInt('0xFF00000000000000').toString(),
  B: BigInt('0xF000000000000000').toString(),
  C: BigInt('0xC000000000000000').toString(),
}

/** Work is computed over the predecessor, or over the public key for a first block. */
export function workRoot(body: Pick<BlockBody, 'account' | 'previous'>): string {
  return body.previous === ZERO_HASH ? publicKeyFromAddress(body.account) : body.previous.toUpperCase()
}

export function workValue(root: string, nonce: string): bigint {
  if (!isHex(nonce, 8)) {
    fail('bad-work', `Work is 16 hex characters — got "${nonce}".`)
  }
  const digest = blake2b(concat(hexToBytes(nonce).slice().reverse(), hexToBytes(root)), 8)
  let value = 0n
  for (let i = digest.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(digest[i] as number)
  return value
}

export function meetsThreshold(root: string, nonce: string, threshold: bigint): boolean {
  return workValue(root, nonce) >= threshold
}

/**
 * Find a nonce for `root`. Synchronous and CPU-bound by design — this is what a
 * work server exists to keep off the game's main thread.
 */
export function generateWork(root: string, threshold: bigint, maxAttempts = 50_000_000): string {
  const nonce = new Uint8Array(8)
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    for (let i = 0; i < 8; i++) nonce[i] = Math.floor(Math.random() * 256)
    const candidate = bytesToHex(nonce)
    if (meetsThreshold(root, candidate, threshold)) return candidate
  }
  fail(
    'work-failed',
    `Could not find proof-of-work for ${root} in ${maxAttempts} attempts. Use a work server (@kei/work) instead of generating locally.`,
  )
}

/** How the client obtains work. Implemented by `@kei/work`. */
export interface WorkProvider {
  generate(root: string, tier: WorkTier): Promise<string>
  /**
   * Optional: get work for `root` ready before anybody asks. The client calls
   * this with its new frontier after every block, which is what keeps the next
   * action from pausing the game (SPEC §5.5).
   */
  precompute?(root: string, tier: WorkTier): void
}
