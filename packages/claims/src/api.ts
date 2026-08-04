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
import {
  MAX_PENDING_CLAIMS,
  createMemoryClaimStore,
  isClaimStoreCapacityError,
  type ClaimStore,
  type ClaimStoreScope,
} from './store.js'

/** Finite by design: delivered proofs are untrusted browser input. */
export const MAX_CLAIM_RECORD_BYTES = 16_384
export const MAX_CLAIM_PROOF_LENGTH = 128
export { MAX_PENDING_CLAIMS } from './store.js'
const MAX_CLAIM_DIAGNOSTICS = 32
const CLAIM_ENVELOPE_VERSION = 1

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
  /** Optional durable adapter. A fresh in-memory store preserves legacy behaviour. */
  store?: ClaimStore
}

export type ClaimStoreDiagnosticCode =
  | 'claim-store-unreadable'
  | 'claim-store-corrupt'
  | 'claim-store-version'
  | 'claim-store-overflow'
  | 'claim-store-write-refused'
  | 'claim-store-readback-mismatch'
  | 'claim-store-remove-refused'
  | 'claim-retry-failed'

export interface ClaimStoreDiagnostic {
  readonly code: ClaimStoreDiagnosticCode
  readonly message: string
  readonly root?: string
}

export interface ClaimStorageStatus {
  readonly durability: 'persistent' | 'session'
  readonly namespace: ClaimStoreScope
  readonly diagnostics: readonly ClaimStoreDiagnostic[]
}

export interface ClaimsApi {
  /** Hand the SDK one or more bundles. Claims them unless autoClaim is off. */
  add(bundles: ClaimBundle | readonly ClaimBundle[]): Promise<ClaimResult[]>
  /** Entitlements this wallet holds a proof for and has not yet claimed. */
  pending(): Promise<PendingClaim[]>
  claimAll(): Promise<ClaimResult[]>
  claim(bundle: ClaimBundle): Promise<ClaimResult>
}

/** The additive storage-aware API returned by `createClaims()`. */
export interface DurableClaimsApi extends ClaimsApi {
  /** Hydrate, reconcile, and attempt the configured startup auto-claim. */
  ready(): Promise<void>
  /** Honest adapter durability plus bounded, non-secret startup diagnostics. */
  storageStatus(): Promise<ClaimStorageStatus>
}

function utf8Bytes(value: string): number {
  let bytes = 0
  for (const character of value) {
    const point = character.codePointAt(0) as number
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (bytes > MAX_CLAIM_RECORD_BYTES) return bytes
  }
  return bytes
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
  if (bundle.proof.length > MAX_CLAIM_PROOF_LENGTH) {
    fail(
      'claim-proof-too-long',
      `A claim proof has ${bundle.proof.length} hashes; the wallet limit is ${MAX_CLAIM_PROOF_LENGTH}. Split the issuer batch or provide a bounded proof.`,
    )
  }
  if (bundle.proof.some((hash) => !isHex(hash, 32))) {
    fail('bad-bundle', 'Every entry in a claim bundle\'s proof must be 64 hex characters.')
  }
  return {
    root,
    asset: bundle.asset.toUpperCase(),
    amount: String(bundle.amount),
    proof: bundle.proof.map((hash) => hash.toUpperCase()),
  }
}

export function createClaims(client: KeiClient, options: ClaimsOptions = {}): DurableClaimsApi {
  const autoClaim = options.autoClaim !== false
  const store = options.store ?? createMemoryClaimStore()
  const namespace: ClaimStoreScope = { network: client.node.network, address: client.address }
  /** One bundle per root: a root commits to at most one entitlement per account. */
  const held = new Map<string, ClaimBundle>()
  const diagnostics: ClaimStoreDiagnostic[] = []
  let hydration: Promise<void> | undefined
  let startup: Promise<void> | undefined

  const diagnose = (diagnostic: ClaimStoreDiagnostic): void => {
    if (diagnostics.length < MAX_CLAIM_DIAGNOSTICS) diagnostics.push(diagnostic)
  }

  const envelopeFor = (bundle: ClaimBundle): string => {
    const value = JSON.stringify({ version: CLAIM_ENVELOPE_VERSION, bundle })
    const bytes = utf8Bytes(value)
    if (bytes > MAX_CLAIM_RECORD_BYTES) {
      fail(
        'claim-record-too-large',
        `This claim bundle needs ${bytes} bytes; the wallet limit is ${MAX_CLAIM_RECORD_BYTES}. Split the issuer batch or provide a smaller proof.`,
      )
    }
    return value
  }

  const bundleFromEnvelope = (root: string, value: string): ClaimBundle | null => {
    if (utf8Bytes(value) > MAX_CLAIM_RECORD_BYTES) {
      diagnose({
        code: 'claim-store-corrupt',
        root,
        message: `Stored claim ${root} exceeds the ${MAX_CLAIM_RECORD_BYTES}-byte limit and was ignored; remove or replace that record.`,
      })
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      diagnose({
        code: 'claim-store-corrupt',
        root,
        message: `Stored claim ${root} is not valid JSON and was ignored; remove or replace that record.`,
      })
      return null
    }
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed)) {
      diagnose({
        code: 'claim-store-corrupt',
        root,
        message: `Stored claim ${root} has no versioned envelope and was ignored; remove or replace that record.`,
      })
      return null
    }
    const record = parsed as { version?: unknown; bundle?: unknown }
    if (record.version !== CLAIM_ENVELOPE_VERSION) {
      diagnose({
        code: 'claim-store-version',
        root,
        message: `Stored claim ${root} uses unsupported version ${String(record.version)}; upgrade the adapter or remove that record.`,
      })
      return null
    }
    try {
      const bundle = validate(record.bundle as ClaimBundle)
      if (bundle.root !== root) {
        diagnose({
          code: 'claim-store-corrupt',
          root,
          message: `Stored claim ${root} contains a different root and was ignored; remove or replace that record.`,
        })
        return null
      }
      return bundle
    } catch {
      diagnose({
        code: 'claim-store-corrupt',
        root,
        message: `Stored claim ${root} is malformed or over budget and was ignored; remove or replace that record.`,
      })
      return null
    }
  }

  const hydrate = (): Promise<void> => {
    if (hydration) return hydration
    hydration = (async () => {
      let listed: readonly string[]
      try {
        listed = await store.list(namespace, MAX_PENDING_CLAIMS + 1)
      } catch {
        diagnose({
          code: 'claim-store-unreadable',
          message: 'The claim store could not list this wallet\'s records; fix or replace the adapter before relying on reload recovery.',
        })
        return
      }
      if (!Array.isArray(listed)) {
        diagnose({
          code: 'claim-store-unreadable',
          message: 'The claim store returned an invalid root list; fix or replace the adapter before relying on reload recovery.',
        })
        return
      }

      if (listed.length > MAX_PENDING_CLAIMS + 1) {
        diagnose({
          code: 'claim-store-overflow',
          message: `The claim store ignored its bounded read and returned more than ${MAX_PENDING_CLAIMS + 1} roots; none were loaded. Fix the adapter before retrying.`,
        })
        return
      }
      const roots = new Set<string>()
      for (const candidate of listed.slice(0, MAX_PENDING_CLAIMS + 1)) {
        if (typeof candidate !== 'string' || !isHex(candidate, 32)) {
          diagnose({
            code: 'claim-store-corrupt',
            message: 'The claim store listed a malformed root; that entry was ignored and will never be signed.',
          })
          continue
        }
        roots.add(candidate.toUpperCase())
      }
      if (roots.size > MAX_PENDING_CLAIMS) {
        diagnose({
          code: 'claim-store-overflow',
          message: `The claim store has more than ${MAX_PENDING_CLAIMS} records for this wallet and network; none were loaded. Remove old records before retrying.`,
        })
        return
      }

      for (const root of roots) {
        let value: string | null
        try {
          value = await store.read(namespace, root)
        } catch {
          diagnose({
            code: 'claim-store-unreadable',
            root,
            message: `Stored claim ${root} could not be read and was ignored; fix or replace the adapter before retrying.`,
          })
          continue
        }
        if (typeof value !== 'string') {
          diagnose({
            code: 'claim-store-corrupt',
            root,
            message: `The claim store listed ${root} but returned no record; repair or remove that entry.`,
          })
          continue
        }
        const bundle = bundleFromEnvelope(root, value)
        if (bundle) held.set(root, bundle)
      }
    })()
    return hydration
  }

  const persistenceFailure = (diagnostic: ClaimStoreDiagnostic): never => {
    diagnose(diagnostic)
    fail(diagnostic.code, diagnostic.message)
  }

  const verifyPersisted = async (bundle: ClaimBundle, value: string): Promise<void> => {
    let readBack: string | null = null
    try {
      readBack = await store.read(namespace, bundle.root)
    } catch {
      persistenceFailure({
        code: 'claim-store-readback-mismatch',
        root: bundle.root,
        message: `The claim store would not read ${bundle.root} back; no claim was attempted because reload recovery was not established. Fix or replace the adapter, then add the bundle again.`,
      })
    }
    if (readBack !== value) {
      persistenceFailure({
        code: 'claim-store-readback-mismatch',
        root: bundle.root,
        message: `The claim store did not return the exact bundle written for ${bundle.root}; no claim was attempted. Fix or replace the adapter, then add the bundle again.`,
      })
    }
  }

  const persist = async (bundle: ClaimBundle, value = envelopeFor(bundle)): Promise<void> => {
    try {
      await store.write(namespace, bundle.root, value)
    } catch (error) {
      if (isClaimStoreCapacityError(error)) {
        persistenceFailure({
          code: 'claim-store-overflow',
          root: bundle.root,
          message: `The claim store reached its ${MAX_PENDING_CLAIMS}-record limit while retaining ${bundle.root}; no claim was attempted. Another wallet tab may have filled the last slot. Claim or reconcile an existing entry, then add the bundle again.`,
        })
      }
      persistenceFailure({
        code: 'claim-store-write-refused',
        root: bundle.root,
        message: `The claim store refused ${bundle.root}; no claim was attempted because reload recovery was not established. Free storage, retry after another wallet tab finishes, or replace the adapter, then add the bundle again.`,
      })
    }
    await verifyPersisted(bundle, value)
  }

  const retain = async (bundle: ClaimBundle): Promise<ClaimBundle> => {
    const value = envelopeFor(bundle)
    const existing = held.get(bundle.root)
    if (existing) {
      if (envelopeFor(existing) !== value) {
        fail(
          'claim-root-conflict',
          `Claim root ${bundle.root} is already retained with different terms. Keep the original bundle or reconcile it before replacing anything.`,
        )
      }
      await verifyPersisted(existing, value)
      return existing
    }
    if (held.size >= MAX_PENDING_CLAIMS) {
      fail(
        'claim-store-overflow',
        `Keeping this bundle would exceed the ${MAX_PENDING_CLAIMS}-claim wallet limit. Claim or reconcile an existing entry before adding it.`,
      )
    }
    await persist(bundle, value)
    held.set(bundle.root, bundle)
    return bundle
  }

  const removePersisted = async (root: string): Promise<void> => {
    try {
      await store.remove(namespace, root)
      if ((await store.read(namespace, root)) === null) return
    } catch {
      // The fixed diagnostic below is intentionally free of adapter details.
    }
    persistenceFailure({
      code: 'claim-store-remove-refused',
      root,
      message: `Claim ${root} is settled or no longer claimable, but its stored proof could not be removed. Fix or replace the adapter; reconciliation will retry without signing it again.`,
    })
  }

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
    await hydrate()
    const bundle = await retain(validate(input))
    const description = await describe(bundle)
    const { hash } = await client.submitAsset({
      kind: 'claim',
      root: bundle.root,
      asset: bundle.asset,
      amount: bundle.amount,
      proof: bundle.proof,
    })
    await removePersisted(bundle.root)
    held.delete(bundle.root)
    return { ...description, hash }
  }

  const reconcile = async (): Promise<void> => {
    await hydrate()
    for (const bundle of [...held.values()]) {
      if (await client.node.hasClaimed(client.address, bundle.root)) {
        await removePersisted(bundle.root)
        held.delete(bundle.root)
        continue
      }
      const commit = await client.node.commitInfo(bundle.root)
      if (!commit || commit.closed) {
        // Closed roots accept no further claims, so the bundle is dead weight.
        await removePersisted(bundle.root)
        held.delete(bundle.root)
        continue
      }
    }
  }

  const pending = async (): Promise<PendingClaim[]> => {
    await reconcile()
    const out: PendingClaim[] = []
    for (const bundle of held.values()) out.push(await describe(bundle))
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
    await hydrate()
    const bundles = (Array.isArray(input) ? input : [input]) as readonly ClaimBundle[]
    const checkedByRoot = new Map<string, ClaimBundle>()
    for (const bundle of bundles) {
      const checked = validate(bundle)
      envelopeFor(checked)
      const duplicate = checkedByRoot.get(checked.root) ?? held.get(checked.root)
      if (duplicate && envelopeFor(duplicate) !== envelopeFor(checked)) {
        fail(
          'claim-root-conflict',
          `Claim root ${checked.root} is already retained with different terms. Keep the original bundle or reconcile it before replacing anything.`,
        )
      }
      checkedByRoot.set(checked.root, checked)
    }
    const additions = [...checkedByRoot.values()].filter((bundle) => !held.has(bundle.root))
    if (held.size + additions.length > MAX_PENDING_CLAIMS) {
      fail(
        'claim-store-overflow',
        `Keeping these bundles would exceed the ${MAX_PENDING_CLAIMS}-claim wallet limit. Claim or reconcile existing entries before adding more.`,
      )
    }
    for (const checked of additions) {
      await retain(checked)
    }
    return autoClaim ? claimAll() : []
  }

  const ready = (): Promise<void> => {
    if (startup) return startup
    startup = (async () => {
      await hydrate()
      if (held.size === 0) return
      try {
        if (autoClaim) await claimAll()
        else await reconcile()
      } catch {
        diagnose({
          code: 'claim-retry-failed',
          message: 'A retained claim could not be reconciled or submitted during startup. It remains stored; call claims.claimAll() after the node or adapter recovers.',
        })
      }
    })()
    return startup
  }

  const storageStatus = async (): Promise<ClaimStorageStatus> => {
    await hydrate()
    return {
      durability: store.durability,
      namespace: { ...namespace },
      diagnostics: diagnostics.map((diagnostic) => ({ ...diagnostic })),
    }
  }

  return { add, pending, claimAll, claim, ready, storageStatus }
}
