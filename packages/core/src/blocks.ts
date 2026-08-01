/**
 * Block shapes.
 *
 * One chain per account (SPEC §5.6.1): asset operations use a new `asset` block
 * type whose `previous` links into the same chain as ordinary `state` blocks,
 * and every `asset` block still carries the account's Kei balance so that a
 * Banano-derived tool which ignores the asset payload still tracks Kei
 * correctly (SPEC §5.6.8).
 */

import { blake2b } from './crypto.js'
import { fail } from './errors.js'
import { bytesToHex, concat, hexToBytes, utf8 } from './hex.js'

export const ZERO_HASH = '0'.repeat(64)

/** Kei itself is asset 0, so inherited "base currency" paths stay correct (SPEC §5.6.1). */
export const KEI_ASSET = ZERO_HASH

export type AssetId = string

/** Who may move units. Protocol-enforced and immutable (SPEC §5.4). */
export type TransferPolicy = 'open' | 'issuer-only' | 'none'

/** Whether the issuer's own SDK runs a swap desk. Stored, never enforced (SPEC §5.4). */
export type SwapPolicy = 'two-way' | 'one-way' | 'off'

export interface AssetMetadata {
  description?: string
  /** An IPFS CID. The chain stores the pointer; the asset lives on IPFS (SPEC §7). */
  image?: string
  /**
   * An SDK-level hint so a wallet can tell a currency from a sword. The protocol
   * does not know or care: an item is a token with supply 1 and 0 decimals, and
   * grouping is the SDK's job (SPEC §7, "group them in the SDK").
   */
  kind?: 'token' | 'item'
}

export interface IssueOp {
  kind: 'issue'
  name: string
  symbol: string
  decimals: number
  /** Raw units, or null for uncapped. Caps circulating supply (SPEC §5.6.6). */
  maxSupply: string | null
  transfer: TransferPolicy
  swap: SwapPolicy
  metadata?: AssetMetadata
}

export interface MintOp {
  kind: 'mint'
  asset: AssetId
  to: string
  amount: string
}

export interface BurnOp {
  kind: 'burn'
  asset: AssetId
  amount: string
}

export interface TransferOp {
  kind: 'transfer'
  asset: AssetId
  to: string
  amount: string
  memo?: string
}

/** Collect an asset receivable. The recipient signs for their own state (SPEC §5.6.3). */
export interface AssetReceiveOp {
  kind: 'asset_receive'
  link: string
}

export interface CommitOp {
  kind: 'commit'
  root: string
  asset: AssetId
  /** Informational: how many entitlements the root covers, and their total. */
  count: number
  total: string
}

export interface CommitCloseOp {
  kind: 'commit_close'
  root: string
}

export interface ClaimOp {
  kind: 'claim'
  root: string
  asset: AssetId
  amount: string
  proof: string[]
}

/**
 * Lock one's own asset and declare what it is wanted for (SPEC §9.2).
 *
 * The offerer is the only party who locks anything, and it is their own asset:
 * `amount` of `asset` leaves their spendable balance into a locked entry keyed by
 * this block's hash. Nothing moves to anyone.
 */
export interface SwapOfferOp {
  kind: 'swap_offer'
  /** The asset being locked. Kei is `KEI_ASSET`. */
  asset: AssetId
  /** Raw units of `asset` to lock. */
  amount: string
  wantAsset: AssetId
  /** Raw units of `wantAsset` the offerer wants for it. */
  wantAmount: string
  /** Only this account may accept. Absent means anyone may (SPEC §9.2). */
  counterparty?: string
  /**
   * Advisory wall-clock expiry, milliseconds since the epoch. **Never
   * consensus-enforced and it cannot be** — this chain has no clock (SPEC §9.3).
   * Clients hide expired listings; the offerer's own `swap_cancel` is what
   * actually removes one from the ledger.
   */
  expiresAt?: number
}

/**
 * Take an offer: one block that debits the accepter and credits both parties
 * (SPEC §9.2). Valid exactly once.
 *
 * It names only the offer's hash, because the offer already commits to what the
 * accepter pays — so the two legs cannot disagree about the price, and the
 * accepter's signature covers it through the reference.
 */
export interface SwapAcceptOp {
  kind: 'swap_accept'
  /** The `swap_offer` block's hash. */
  offer: string
}

/** Recover one's own locked asset. Valid only while the offer is unaccepted. */
export interface SwapCancelOp {
  kind: 'swap_cancel'
  offer: string
}

export type AssetOp =
  | IssueOp
  | MintOp
  | BurnOp
  | TransferOp
  | AssetReceiveOp
  | CommitOp
  | CommitCloseOp
  | ClaimOp
  | SwapOfferOp
  | SwapAcceptOp
  | SwapCancelOp

export type StateSubtype = 'open' | 'send' | 'receive' | 'change'

export interface StateBlockBody {
  type: 'state'
  subtype: StateSubtype
  account: string
  previous: string
  representative: string
  /** Kei raw, as a decimal string. */
  balance: string
  /** Destination public key (send), source block hash (receive), or zeros. */
  link: string
  /** See docs/decisions-m0.md — the on-chain home of a memo is M2's decision. */
  memo?: string
}

export interface AssetBlockBody {
  type: 'asset'
  account: string
  previous: string
  representative: string
  /** Kei raw, unchanged from the predecessor except at issuance (SPEC §5.6.5). */
  balance: string
  op: AssetOp
}

export type BlockBody = StateBlockBody | AssetBlockBody

export type Block = BlockBody & {
  work: string
  signature: string
}

/** Proof-of-work tiers, priced by how attractive the operation is to abuse (SPEC §5.6.4). */
export type WorkTier = 'A' | 'B' | 'C'

export function tierFor(body: BlockBody): WorkTier {
  if (body.type === 'state') {
    switch (body.subtype) {
      case 'send':
        return 'B'
      case 'change':
        return 'B'
      default:
        return 'C'
    }
  }
  switch (body.op.kind) {
    case 'issue':
    case 'mint':
    case 'commit':
    case 'commit_close':
      return 'A'
    case 'transfer':
    // All three swap legs are tier B (SPEC §5.6.4). A cancel is cheap to
    // validate, but it is the block an offerer races an accept with, so pricing
    // it below the accept would hand the racer an advantage the protocol has no
    // reason to give (SPEC §9.2, conflict 4).
    case 'swap_offer':
    case 'swap_accept':
    case 'swap_cancel':
      return 'B'
    case 'burn':
    case 'claim':
    case 'asset_receive':
      return 'C'
  }
}

const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,19}$/

export function normalizeSymbol(symbol: string): string {
  const upper = String(symbol ?? '').trim().toUpperCase()
  if (!SYMBOL_PATTERN.test(upper)) {
    fail(
      'bad-symbol',
      `"${String(symbol)}" is not a usable symbol. Use 1-20 characters, A-Z, 0-9 or "-", starting with a letter or digit — for example "GEM".`,
    )
  }
  return upper
}

/**
 * Asset identity is derived, not assigned (SPEC §5.6.1), which is what makes
 * `token.issue()` idempotent structurally rather than by lookup.
 */
export function deriveAssetId(issuerPublicKey: string, symbol: string): AssetId {
  return bytesToHex(
    blake2b(concat(hexToBytes(issuerPublicKey), utf8(normalizeSymbol(symbol))), 32),
  )
}
