/**
 * `MockNode` is the M0 chain: it implements `KeiNode` over `MockLedger`, in
 * process, with no network. SPEC §5.10 — build the SDK against a local mock from
 * day one, because four months of node work with nothing demonstrable is the
 * condition under which projects die.
 */

import type { AssetId, Block, WorkTier } from '../blocks.js'
import { fail } from '../errors.js'
import type {
  AccountInfo,
  AssetInfo,
  CommitInfo,
  HolderEntry,
  Holding,
  KeiNode,
  NetworkName,
  Notification,
  Receivable,
  Unsubscribe,
} from '../node.js'
import { MockLedger, type LedgerOptions } from './ledger.js'

export class MockNode implements KeiNode {
  readonly network: NetworkName
  readonly ledger: MockLedger

  private constructor(ledger: MockLedger) {
    this.ledger = ledger
    this.network = ledger.network
  }

  static async create(options: LedgerOptions = {}): Promise<MockNode> {
    return new MockNode(await MockLedger.create(options))
  }

  async accountInfo(address: string): Promise<AccountInfo | null> {
    return this.ledger.accountInfo(address)
  }

  async accountHistory(address: string, options?: { limit?: number }): Promise<Block[]> {
    return this.ledger.accountHistory(address, options?.limit)
  }

  async blockInfo(hash: string): Promise<Block | null> {
    return this.ledger.blockInfo(hash)
  }

  async receivables(address: string): Promise<Receivable[]> {
    return this.ledger.receivablesFor(address)
  }

  async process(block: Block): Promise<{ hash: string }> {
    return this.ledger.process(block)
  }

  async workThresholds(): Promise<Record<WorkTier, string>> {
    return { ...this.ledger.thresholds }
  }

  async assetInfo(asset: AssetId): Promise<AssetInfo | null> {
    return this.ledger.assetInfo(asset)
  }

  async assetBySymbol(issuer: string, symbol: string): Promise<AssetInfo | null> {
    return this.ledger.assetBySymbol(issuer, symbol)
  }

  async holdings(address: string): Promise<Holding[]> {
    return this.ledger.holdingsOf(address)
  }

  async holderBalance(asset: AssetId, address: string): Promise<string> {
    return this.ledger.holderBalance(asset, address).toString()
  }

  async holders(asset: AssetId, options?: { limit?: number }): Promise<HolderEntry[]> {
    return this.ledger.holdersOf(asset, options?.limit)
  }

  async commitInfo(root: string): Promise<CommitInfo | null> {
    return this.ledger.commitInfo(root)
  }

  async hasClaimed(address: string, root: string): Promise<boolean> {
    return this.ledger.hasClaimed(address, root)
  }

  subscribe(address: string, listener: (event: Notification) => void): Unsubscribe {
    return this.ledger.subscribe(address, listener)
  }

  async faucet(address: string, amount?: string): Promise<{ hash: string }> {
    if (this.network === 'mainnet') {
      fail('no-faucet', 'There is no faucet on mainnet. Send Kei to the address instead.')
    }
    return this.ledger.faucet(address, amount === undefined ? undefined : BigInt(amount))
  }
}
