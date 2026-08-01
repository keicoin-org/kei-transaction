/**
 * The node contract.
 *
 * This interface *is* the M0 deliverable that matters (SPEC §5.10): the SDK is
 * written against it, `MockNode` implements it in memory, and at M3 `HttpNode`
 * implements the same thing over RPC without the public API moving. Raw amounts
 * cross this boundary as decimal strings, never as numbers.
 */

import type { AssetId, Block, SwapPolicy, TransferPolicy, WorkTier } from './blocks.js'

export type NetworkName = 'mock' | 'testnet' | 'mainnet'

export interface AccountInfo {
  address: string
  frontier: string
  height: number
  /** Kei raw. */
  balance: string
  representative: string
  receivableCount: number
  /**
   * How many assets this account has issued, which prices its next one — the
   * nth burns n Kei (SPEC §5.6.5). Needed to construct a valid `issue` block.
   */
  issuedCount: number
}

export interface AssetInfo {
  id: AssetId
  issuer: string
  name: string
  symbol: string
  decimals: number
  /** Raw, or null for uncapped. */
  maxSupply: string | null
  transfer: TransferPolicy
  swap: SwapPolicy
  description?: string
  image?: string
  kind?: 'token' | 'item'
  /** Raw units currently in existence (SPEC §5.6.6). */
  circulating: string
}

export interface Holding {
  asset: AssetId
  /** Raw. */
  balance: string
}

export interface HolderEntry {
  account: string
  /** Raw. */
  balance: string
}

export interface Receivable {
  /** Hash of the block that created it. */
  hash: string
  from: string
  asset: AssetId
  /** Raw. */
  amount: string
  memo?: string
}

export interface CommitInfo {
  root: string
  issuer: string
  asset: AssetId
  count: number
  /** Raw. */
  total: string
  /** Closed roots accept no further claims and become prunable (SPEC §5.5). */
  closed: boolean
}

/** An offer is consumed by exactly one of accept or cancel, and never both (SPEC §9.2). */
export type SwapState = 'open' | 'accepted' | 'cancelled'

/**
 * One `swap_offer` block and what became of its lock.
 *
 * This is a *read model*, not a block: the block is on the offerer's chain and
 * the state comes from the locked entry it created, which some later block on
 * some other chain may have consumed.
 */
export interface SwapOffer {
  /** The `swap_offer` block's hash. It is the offer's id and the lock's key. */
  hash: string
  /** The offerer. The only party who ever locks anything (SPEC §9.2). */
  from: string
  /** The locked asset, and how much of it. Raw. */
  asset: AssetId
  amount: string
  /** What the offerer wants for it. Raw. */
  wantAsset: AssetId
  wantAmount: string
  /** Only this account may accept, or null if anyone may. */
  counterparty: string | null
  /** Advisory, never enforced — this chain has no clock (SPEC §9.3). */
  expiresAt: number | null
  state: SwapState
  /** The `swap_accept` or `swap_cancel` that consumed the lock. */
  settledBy: string | null
  /** Who accepted, when `state` is 'accepted'. */
  acceptedBy: string | null
  /** Height of the offer block on the offerer's own chain. Consensus-derived. */
  height: number
  /**
   * When this node first saw the offer, in milliseconds. **Node-local, not
   * consensus** — the block-lattice has no clock (SPEC §5.5), so two nodes will
   * disagree and a restarted node forgets. Fine for "hide listings older than a
   * week"; never a fact to settle a dispute with.
   */
  seenAt: number
  /** Node-local, on the same terms as `seenAt`. Null while the offer is open. */
  settledAt: number | null
}

export interface Notification {
  kind: 'receivable' | 'block'
  account: string
  hash: string
}

export type Unsubscribe = () => void

export interface KeiNode {
  readonly network: NetworkName

  accountInfo(address: string): Promise<AccountInfo | null>
  accountHistory(address: string, options?: { limit?: number }): Promise<Block[]>
  blockInfo(hash: string): Promise<Block | null>

  receivables(address: string): Promise<Receivable[]>
  process(block: Block): Promise<{ hash: string }>

  /** Minimum acceptable work value per tier, as a decimal string (SPEC §5.6.4). */
  workThresholds(): Promise<Record<WorkTier, string>>

  assetInfo(asset: AssetId): Promise<AssetInfo | null>
  assetBySymbol(issuer: string, symbol: string): Promise<AssetInfo | null>

  /** One account's holdings — a prefix scan of the `holdings` table (SPEC §7). */
  holdings(address: string): Promise<Holding[]>
  /** One lookup in the `holders` table (SPEC §7, §14.3). */
  holderBalance(asset: AssetId, address: string): Promise<string>
  /** Holders of one asset — a prefix scan of the `holders` table (SPEC §7). */
  holders(asset: AssetId, options?: { limit?: number }): Promise<HolderEntry[]>

  commitInfo(root: string): Promise<CommitInfo | null>
  hasClaimed(address: string, root: string): Promise<boolean>

  /** One offer and the state of its lock (SPEC §9.2). */
  swapOffer(hash: string): Promise<SwapOffer | null>
  /**
   * The offers *written by* one account, newest first — a bounded walk of that
   * account's own chain, which is the only shape SPEC §9.1 allows a scan to
   * take. There is deliberately no "every offer on the network" call: that is
   * an indexer, and §9.4 says Kei does not provide one.
   */
  accountSwaps(
    address: string,
    options?: { limit?: number; state?: SwapState },
  ): Promise<SwapOffer[]>

  subscribe(address: string, listener: (event: Notification) => void): Unsubscribe

  /** Testnet and mock only. Throws elsewhere (SPEC §6.7). */
  faucet(address: string, amount?: string): Promise<{ hash: string }>
}
