/**
 * The player side of a claim.
 *
 * The chain cannot tell a player what they are owed: a root is one hash, and the
 * entitlement behind it lives in the batch the issuer built. So the game hands
 * the player a bundle (`drop.proofFor(player)`), the player's SDK holds it, and
 * the claim itself is written by the player from their own account — in parallel
 * with every other player (SPEC §5.5).
 *
 * Claiming happens automatically in the background, because a player who has to
 * press "claim" for every sword will hate it (SPEC §5.5, cost 3).
 */

import type { AssetId, KeiClient } from '@keicoin/core'
import { assertRoot, fail, fromRaw, isHex } from '@keicoin/core'

import type { ClaimBundle } from './tree.js'

export interface PendingClaim {
  root: string
  asset: AssetId
  symbol: string
  name: string
  amount: number
}

export interface ClaimResult extends PendingClaim {
  hash: string
}

export interface ClaimsOptions {
  /** Claim in the background as bundles arrive. Default true. */
  autoClaim?: boolean
}

export interface ClaimsApi {
  /** Hand the SDK one or more bundles. Claims them unless autoClaim is off. */
  add(bundles: ClaimBundle | readonly ClaimBundle[]): Promise<ClaimResult[]>
  /** Entitlements this wallet holds a proof for and has not yet claimed. */
  pending(): Promise<PendingClaim[]>
  claimAll(): Promise<ClaimResult[]>
  claim(bundle: ClaimBundle): Promise<ClaimResult>
}

function validate(bundle: ClaimBundle): ClaimBundle {
  if (!bundle || typeof bundle !== 'object') {
    fail('bad-bundle', 'A claim bundle looks like { root, asset, amount, proof } — the game gives you one.')
  }
  const root = assertRoot(bundle.root)
  if (!isHex(bundle.asset, 32)) fail('bad-bundle', 'A claim bundle\'s asset is 64 hex characters.')
  if (!/^\d+$/.test(String(bundle.amount))) {
    fail('bad-bundle', 'A claim bundle\'s amount is a whole number of raw units, as a string.')
  }
  if (!Array.isArray(bundle.proof)) fail('bad-bundle', 'A claim bundle\'s proof is an array of hashes.')
  return { ...bundle, root, asset: bundle.asset.toUpperCase() }
}

export function createClaims(client: KeiClient, options: ClaimsOptions = {}): ClaimsApi {
  const autoClaim = options.autoClaim !== false
  /** One bundle per root: a root commits to at most one entitlement per account. */
  const held = new Map<string, ClaimBundle>()

  const describe = async (bundle: ClaimBundle): Promise<PendingClaim> => {
    const info = await client.assetInfo(bundle.asset)
    return {
      root: bundle.root,
      asset: bundle.asset,
      symbol: info?.symbol ?? '?',
      name: info?.name ?? 'unknown asset',
      amount: fromRaw(BigInt(bundle.amount), info?.decimals ?? 0),
    }
  }

  const claim = async (input: ClaimBundle): Promise<ClaimResult> => {
    const bundle = validate(input)
    const description = await describe(bundle)
    const { hash } = await client.submitAsset({
      kind: 'claim',
      root: bundle.root,
      asset: bundle.asset,
      amount: bundle.amount,
      proof: bundle.proof,
    })
    held.delete(bundle.root)
    return { ...description, hash }
  }

  const pending = async (): Promise<PendingClaim[]> => {
    const out: PendingClaim[] = []
    for (const bundle of [...held.values()]) {
      if (await client.node.hasClaimed(client.address, bundle.root)) {
        held.delete(bundle.root)
        continue
      }
      const commit = await client.node.commitInfo(bundle.root)
      if (!commit || commit.closed) {
        // Closed roots accept no further claims, so the bundle is dead weight.
        held.delete(bundle.root)
        continue
      }
      out.push(await describe(bundle))
    }
    return out
  }

  const claimAll = async (): Promise<ClaimResult[]> => {
    const results: ClaimResult[] = []
    for (const entitlement of await pending()) {
      const bundle = held.get(entitlement.root)
      if (!bundle) continue
      results.push(await claim(bundle))
    }
    return results
  }

  const add = async (input: ClaimBundle | readonly ClaimBundle[]): Promise<ClaimResult[]> => {
    const bundles = (Array.isArray(input) ? input : [input]) as readonly ClaimBundle[]
    for (const bundle of bundles) {
      const checked = validate(bundle)
      held.set(checked.root, checked)
    }
    return autoClaim ? claimAll() : []
  }

  return { add, pending, claimAll, claim }
}
