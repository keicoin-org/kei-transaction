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

  subscribe(address: string, listener: (event: Notification) => void): Unsubscribe

  /** Testnet and mock only. Throws elsewhere (SPEC §6.7). */
  faucet(address: string, amount?: string): Promise<{ hash: string }>
}
