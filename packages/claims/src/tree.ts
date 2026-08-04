/**
 * Building a commit.
 *
 * SPEC §5.5: the issuer publishes one block containing a Merkle root committing
 * to thousands of entitlements, and each player writes their own claim block.
 * One issuer write underwrites an unbounded number of parallel player writes,
 * which is what stops the issuer becoming a global write lock.
 */

import type { AssetId } from '@keicoin/core'
import {
  assertAddress,
  combineHashes,
  fail,
  leafHash,
  publicKeyFromAddress,
  randomSalt,
  saltLeaf,
  toRaw,
} from '@keicoin/core'

export interface CommitEntry {
  to: string
  amount: number | string
}

/** What a player needs in order to claim: handed to them by the game. */
export interface ClaimBundle {
  root: string
  asset: AssetId
  /** Raw units, as a string, so no precision is lost in transit. */
  amount: string
  proof: string[]
}

export interface BuiltCommit {
  root: string
  asset: AssetId
  /** Recipients covered, after merging duplicates. */
  count: number
  /** Raw total. */
  total: string
  recipients: string[]
  /** What made this root unique. Worth logging; not worth hiding. */
  salt: string
  /**
   * The sibling path from the salt leaf to the root.
   *
   * Nothing claims against it — the salt is not an entitlement. It is here
   * because a salt that means something is a salt somebody wants to check: a
   * drop table hashes itself into the salt, and this path is what lets a player
   * fold `saltLeaf(salt)` up to a root the ledger already accepted and see that
   * the batch really was published for the table the game showed them
   * (`@keicoin/economy`, SPEC §5.5). For a random salt it proves only that the
   * salt is this root's, which is true and uninteresting.
   */
  saltProof: string[]
  /** The bundle for one recipient, ready to hand over or serialise. */
  proofFor(address: string): ClaimBundle
  amountFor(address: string): string
}

export interface BuildCommitOptions {
  asset: AssetId
  decimals: number
  entries: readonly CommitEntry[]
  /**
   * Pass one only to reproduce a specific root. Left alone it is random, which
   * is what makes two identical batches two different drops.
   */
  salt?: string
}

/**
 * One leaf per account per root (SPEC §5.5), so two rewards for the same player
 * in one batch are merged rather than being two leaves the double-claim index
 * could never both honour.
 */
export function buildCommit(options: BuildCommitOptions): BuiltCommit {
  const { asset, decimals, entries } = options
  if (!Array.isArray(entries) || entries.length === 0) {
    fail('empty-commit', 'A commit needs at least one entitlement. Pass [{ to, amount }, ...].')
  }

  const merged = new Map<string, bigint>()
  for (const entry of entries) {
    const address = assertAddress(entry?.to, 'recipient address')
    const amount = toRaw(entry.amount, decimals, 'Entitlement amount')
    if (amount <= 0n) fail('bad-amount', `Entitlement for ${address} must be greater than zero.`)
    merged.set(address, (merged.get(address) ?? 0n) + amount)
  }

  // Sorted, so the order the game accumulated its drops in cannot change the
  // proofs; salted, so two identical batches are still two different drops
  // rather than a root the ledger has already seen.
  const recipients = [...merged.keys()].sort()
  const salt = options.salt ?? randomSalt()
  const leaves = [
    ...recipients.map((address) => leafHash(publicKeyFromAddress(address), asset, merged.get(address) as bigint)),
    saltLeaf(salt),
  ]

  const layers: string[][] = [leaves]
  while ((layers[layers.length - 1] as string[]).length > 1) {
    const below = layers[layers.length - 1] as string[]
    const next: string[] = []
    for (let i = 0; i < below.length; i += 2) {
      const left = below[i] as string
      const right = (below[i + 1] ?? left) as string
      next.push(combineHashes(left, right))
    }
    layers.push(next)
  }

  const root = (layers[layers.length - 1] as string[])[0] as string
  const indexOf = new Map(recipients.map((address, index) => [address, index]))
  let total = 0n
  for (const amount of merged.values()) total += amount

  const pathTo = (leafIndex: number): string[] => {
    const path: string[] = []
    let position = leafIndex
    for (let level = 0; level < layers.length - 1; level++) {
      const layer = layers[level] as string[]
      const sibling = position % 2 === 0 ? layer[position + 1] ?? layer[position] : layer[position - 1]
      path.push(sibling as string)
      position = Math.floor(position / 2)
    }
    return path
  }

  const proofFor = (address: string): ClaimBundle => {
    const index = indexOf.get(address)
    if (index === undefined) {
      fail('not-in-commit', `${address} is not in this drop, so there is no proof to give them.`)
    }
    return { root, asset, amount: (merged.get(address) as bigint).toString(), proof: pathTo(index) }
  }

  return {
    root,
    asset,
    // Recipients, not leaves: the salt is not an entitlement and nothing can
    // claim it.
    count: recipients.length,
    total: total.toString(),
    recipients,
    salt,
    // The salt is the last leaf, always: it is appended after the recipients.
    saltProof: pathTo(leaves.length - 1),
    proofFor,
    amountFor: (address) => (merged.get(address) ?? 0n).toString(),
  }
}
