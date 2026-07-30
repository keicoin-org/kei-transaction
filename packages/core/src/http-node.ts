/**
 * `HttpNode` speaks the RPC surface documented in docs/rpc.md.
 *
 * It exists at M0 on purpose, even though no server answers it yet: writing the
 * client here is what turns "swap the mock for RPC" (M3) into a one-line change
 * at the call site, and it pins the request and response shapes the node fork
 * has to serve. Actions and field names follow Nano/Banano's conventions so
 * existing tooling ports rather than gets rewritten (SPEC §5.6.8).
 */

import type { AssetId, Block, WorkTier } from './blocks.js'
import { KeiError, fail } from './errors.js'
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
} from './node.js'

export interface HttpNodeOptions {
  url: string
  network?: NetworkName
  /** Milliseconds between receivable polls. Sockets are a later optimisation. */
  pollInterval?: number
  headers?: Record<string, string>
  fetch?: typeof globalThis.fetch
}

export class HttpNode implements KeiNode {
  readonly network: NetworkName
  private readonly url: string
  private readonly pollInterval: number
  private readonly headers: Record<string, string>
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: HttpNodeOptions) {
    if (!options?.url) {
      fail('no-node-url', 'HttpNode needs a node URL, for example https://node.kei.dev.')
    }
    this.url = options.url
    this.network = options.network ?? 'testnet'
    this.pollInterval = options.pollInterval ?? 2_000
    this.headers = { 'content-type': 'application/json', ...options.headers }
    const impl = options.fetch ?? globalThis.fetch
    if (typeof impl !== 'function') {
      fail('no-fetch', 'No fetch available. Pass one to HttpNode, or use Node 18+, Bun, or a browser.')
    }
    // Bound, because a browser's `fetch` insists on being called with `window`
    // as its receiver: stored on an instance and called as `this.fetchImpl(...)`
    // it throws "Illegal invocation", which then reads as an unreachable node.
    // Node and Bun do not care, so this only ever failed in the one place that
    // matters most (SPEC §6.3 — the player is a browser).
    this.fetchImpl = impl.bind(globalThis)
  }

  private async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ action, ...payload }),
      })
    } catch (cause) {
      throw new KeiError(
        'node-unreachable',
        `Could not reach the Kei node at ${this.url}. Check the URL and that the node is running.`,
      )
    }
    if (!response.ok) {
      throw new KeiError(
        'node-error',
        `The Kei node at ${this.url} answered ${response.status} for "${action}".`,
      )
    }
    const body = (await response.json()) as { error?: string } & T
    if (body && typeof body === 'object' && typeof body.error === 'string') {
      throw new KeiError('node-error', `The node rejected "${action}": ${body.error}`)
    }
    return body
  }

  async accountInfo(address: string): Promise<AccountInfo | null> {
    const result = await this.call<{ account?: AccountInfo | null }>('account_info', { account: address })
    return result.account ?? null
  }

  async accountHistory(address: string, options?: { limit?: number }): Promise<Block[]> {
    const result = await this.call<{ history?: Block[] }>('account_history', {
      account: address,
      count: options?.limit ?? 100,
    })
    return result.history ?? []
  }

  async blockInfo(hash: string): Promise<Block | null> {
    const result = await this.call<{ block?: Block | null }>('block_info', { hash })
    return result.block ?? null
  }

  async receivables(address: string): Promise<Receivable[]> {
    const result = await this.call<{ receivables?: Receivable[] }>('accounts_receivable', {
      account: address,
    })
    return result.receivables ?? []
  }

  async process(block: Block): Promise<{ hash: string }> {
    return this.call<{ hash: string }>('process', { block })
  }

  async workThresholds(): Promise<Record<WorkTier, string>> {
    const result = await this.call<{ thresholds: Record<WorkTier, string> }>('work_thresholds')
    return result.thresholds
  }

  async assetInfo(asset: AssetId): Promise<AssetInfo | null> {
    const result = await this.call<{ asset?: AssetInfo | null }>('asset_info', { asset })
    return result.asset ?? null
  }

  async assetBySymbol(issuer: string, symbol: string): Promise<AssetInfo | null> {
    const result = await this.call<{ asset?: AssetInfo | null }>('asset_by_symbol', { issuer, symbol })
    return result.asset ?? null
  }

  async holdings(address: string): Promise<Holding[]> {
    const result = await this.call<{ holdings?: Holding[] }>('account_holdings', { account: address })
    return result.holdings ?? []
  }

  async holderBalance(asset: AssetId, address: string): Promise<string> {
    const result = await this.call<{ balance?: string }>('asset_balance', { asset, account: address })
    return result.balance ?? '0'
  }

  async holders(asset: AssetId, options?: { limit?: number }): Promise<HolderEntry[]> {
    const result = await this.call<{ holders?: HolderEntry[] }>('asset_holders', {
      asset,
      count: options?.limit ?? 100,
    })
    return result.holders ?? []
  }

  async commitInfo(root: string): Promise<CommitInfo | null> {
    const result = await this.call<{ commit?: CommitInfo | null }>('commit_info', { root })
    return result.commit ?? null
  }

  async hasClaimed(address: string, root: string): Promise<boolean> {
    const result = await this.call<{ claimed?: boolean }>('claim_status', { account: address, root })
    return result.claimed === true
  }

  /** Polling, because a plain RPC node has nothing to push with. */
  subscribe(address: string, listener: (event: Notification) => void): Unsubscribe {
    const seen = new Set<string>()
    let stopped = false

    const poll = async (): Promise<void> => {
      try {
        for (const receivable of await this.receivables(address)) {
          if (seen.has(receivable.hash)) continue
          seen.add(receivable.hash)
          if (!stopped) listener({ kind: 'receivable', account: address, hash: receivable.hash })
        }
      } catch {
        // A missed poll is not an error worth surfacing; the next one retries.
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), this.pollInterval)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }

  async faucet(address: string, amount?: string): Promise<{ hash: string }> {
    if (this.network === 'mainnet') {
      fail('no-faucet', 'There is no faucet on mainnet. Send Kei to the address instead.')
    }
    return this.call<{ hash: string }>('faucet', {
      account: address,
      ...(amount === undefined ? {} : { amount }),
    })
  }
}
