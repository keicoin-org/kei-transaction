/**
 * Merkle-rooted claims (SPEC §5.5). The node verifies proofs, so leaf hashing
 * and proof folding live here; tree building lives in `@keicoin/claims`.
 *
 * Leaves and internal nodes are domain-separated, and internal pairs are sorted
 * so a proof is a bare list of siblings with no direction bits to get wrong.
 */

import type { AssetId } from './blocks.js'
import { blake2b } from './crypto.js'
import { fail } from './errors.js'
import { bigintToBytes, bytesToHex, concat, hexToBytes, isHex } from './hex.js'

const LEAF_TAG = new Uint8Array([0x00])
const NODE_TAG = new Uint8Array([0x01])
const SALT_TAG = new Uint8Array([0x02])

/** No legitimate tree needs more than 2^48 leaves. */
export const MAX_PROOF_LENGTH = 48

/** One leaf per account per root (SPEC §5.5). */
export function leafHash(recipientPublicKey: string, asset: AssetId, amount: bigint): string {
  return bytesToHex(
    blake2b(
      concat(
        LEAF_TAG,
        hexToBytes(recipientPublicKey),
        hexToBytes(asset),
        bigintToBytes(amount, 16),
      ),
      32,
    ),
  )
}

/**
 * A leaf nobody can claim, which exists to make the root unique.
 *
 * Without one, a root is a pure function of who is owed what — so a game that
 * drops 20 coins to the same player twice builds the same tree twice, and the
 * ledger rejects the second as a duplicate root. That is not a rare case; it is
 * Tuesday.
 *
 * Domain-separated and a different length from a real leaf, so no salt can be
 * mistaken for an entitlement, and invisible to a node: it verifies the
 * claimant's leaf against the root and never enumerates the others.
 */
export function saltLeaf(salt: string): string {
  if (!isHex(salt, 32)) fail('bad-salt', 'A commit salt is 64 hexadecimal characters.')
  return bytesToHex(blake2b(concat(SALT_TAG, hexToBytes(salt)), 32))
}

/** 32 random bytes from the platform CSPRNG. Not a secret; just unique. */
export function randomSalt(): string {
  const bytes = new Uint8Array(32)
  const source = (globalThis as { crypto?: { getRandomValues?(into: Uint8Array): Uint8Array } }).crypto
  if (!source?.getRandomValues) {
    fail('no-randomness', 'No secure random source available. Use Node 18+, Bun, or a modern browser.')
  }
  source.getRandomValues(bytes)
  return bytesToHex(bytes)
}

export function combineHashes(left: string, right: string): string {
  const [first, second] = left <= right ? [left, right] : [right, left]
  return bytesToHex(blake2b(concat(NODE_TAG, hexToBytes(first), hexToBytes(second)), 32))
}

export function verifyProof(leaf: string, proof: readonly string[], root: string): boolean {
  if (!isHex(leaf, 32) || !isHex(root, 32)) return false
  if (proof.length > MAX_PROOF_LENGTH) return false
  let current = leaf
  for (const sibling of proof) {
    if (!isHex(sibling, 32)) return false
    current = combineHashes(current, sibling)
  }
  return current === root
}

export function assertRoot(root: unknown): string {
  if (!isHex(root, 32)) {
    fail('bad-root', `A commit root is 64 hex characters — got "${String(root)}".`)
  }
  return root.toUpperCase()
}
