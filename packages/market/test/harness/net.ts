/**
 * Adversarial node layer for the market conformance harness.
 *
 * Every wrapper here implements `KeiNode` by delegation over a real
 * `MockNode`, so the ledger underneath stays honest and every scenario is a
 * *node-shaped* fault, never an invented one: a page cap the RPC contract
 * allows (docs/rpc.md `count`), a read model that lies (SPEC §9.4 says an
 * index is never an authority — this is the node playing the dishonest
 * index), a call that fails, or a call held mid-flight so a race resolves in
 * the order the test chose rather than whichever order the scheduler felt
 * like. Determinism is the point: none of these wait on wall-clock anything.
 */

import type {
  AccountInfo,
  AssetId,
  AssetInfo,
  Block,
  CommitInfo,
  HolderEntry,
  Holding,
  KeiNode,
  NetworkName,
  Notification,
  Receivable,
  SwapOffer,
  SwapState,
  Unsubscribe,
  WorkTier,
} from '@keicoin/core'

/** Forwards everything. Subclasses override only the calls they distort. */
export class DelegateNode implements KeiNode {
  constructor(protected readonly inner: KeiNode) {}

  get network(): NetworkName {
    return this.inner.network
  }

  accountInfo(address: string): Promise<AccountInfo | null> {
    return this.inner.accountInfo(address)
  }
  accountHistory(address: string, options?: { limit?: number }): Promise<Block[]> {
    return this.inner.accountHistory(address, options)
  }
  blockInfo(hash: string): Promise<Block | null> {
    return this.inner.blockInfo(hash)
  }
  receivables(address: string): Promise<Receivable[]> {
    return this.inner.receivables(address)
  }
  process(block: Block): Promise<{ hash: string }> {
    return this.inner.process(block)
  }
  workThresholds(): Promise<Record<WorkTier, string>> {
    return this.inner.workThresholds()
  }
  assetInfo(asset: AssetId): Promise<AssetInfo | null> {
    return this.inner.assetInfo(asset)
  }
  assetBySymbol(issuer: string, symbol: string): Promise<AssetInfo | null> {
    return this.inner.assetBySymbol(issuer, symbol)
  }
  holdings(address: string): Promise<Holding[]> {
    return this.inner.holdings(address)
  }
  holderBalance(asset: AssetId, address: string): Promise<string> {
    return this.inner.holderBalance(asset, address)
  }
  holders(asset: AssetId, options?: { limit?: number }): Promise<HolderEntry[]> {
    return this.inner.holders(asset, options)
  }
  commitInfo(root: string): Promise<CommitInfo | null> {
    return this.inner.commitInfo(root)
  }
  hasClaimed(address: string, root: string): Promise<boolean> {
    return this.inner.hasClaimed(address, root)
  }
  swapOffer(hash: string): Promise<SwapOffer | null> {
    return this.inner.swapOffer(hash)
  }
  accountSwaps(
    address: string,
    options?: { limit?: number; state?: SwapState },
  ): Promise<SwapOffer[]> {
    return this.inner.accountSwaps(address, options)
  }
  subscribe(address: string, listener: (event: Notification) => void): Unsubscribe {
    return this.inner.subscribe(address, listener)
  }
  faucet(address: string, amount?: string): Promise<{ hash: string }> {
    return this.inner.faucet(address, amount)
  }
}

export type CountedMethod =
  | 'accountInfo'
  | 'accountHistory'
  | 'receivables'
  | 'process'
  | 'assetInfo'
  | 'holderBalance'
  | 'swapOffer'
  | 'accountSwaps'

const COUNTED: readonly CountedMethod[] = [
  'accountInfo',
  'accountHistory',
  'receivables',
  'process',
  'assetInfo',
  'holderBalance',
  'swapOffer',
  'accountSwaps',
]

/**
 * Counts calls per method, so a test can assert *complexity* — "a book over N
 * accounts is exactly N `account_swaps` calls" — instead of timing anything.
 * Wall-clock thresholds flake; call counts are the same on every machine.
 */
export class CountingNode extends DelegateNode {
  readonly calls: Record<CountedMethod, number> = {
    accountInfo: 0,
    accountHistory: 0,
    receivables: 0,
    process: 0,
    assetInfo: 0,
    holderBalance: 0,
    swapOffer: 0,
    accountSwaps: 0,
  }

  reset(): void {
    for (const method of COUNTED) this.calls[method] = 0
  }

  /** A machine-readable snapshot, for evidence in assertion messages. */
  report(): Record<CountedMethod, number> {
    return { ...this.calls }
  }

  override accountInfo(address: string): Promise<AccountInfo | null> {
    this.calls.accountInfo += 1
    return super.accountInfo(address)
  }
  override accountHistory(address: string, options?: { limit?: number }): Promise<Block[]> {
    this.calls.accountHistory += 1
    return super.accountHistory(address, options)
  }
  override receivables(address: string): Promise<Receivable[]> {
    this.calls.receivables += 1
    return super.receivables(address)
  }
  override process(block: Block): Promise<{ hash: string }> {
    this.calls.process += 1
    return super.process(block)
  }
  override assetInfo(asset: AssetId): Promise<AssetInfo | null> {
    this.calls.assetInfo += 1
    return super.assetInfo(asset)
  }
  override holderBalance(asset: AssetId, address: string): Promise<string> {
    this.calls.holderBalance += 1
    return super.holderBalance(asset, address)
  }
  override swapOffer(hash: string): Promise<SwapOffer | null> {
    this.calls.swapOffer += 1
    return super.swapOffer(hash)
  }
  override accountSwaps(
    address: string,
    options?: { limit?: number; state?: SwapState },
  ): Promise<SwapOffer[]> {
    this.calls.accountSwaps += 1
    return super.accountSwaps(address, options)
  }
}

interface FaultRule {
  method: CountedMethod
  /** Fault only calls whose first argument (account, hash, asset) matches. */
  key?: string
  /** How many calls to fault before healing. Infinity if omitted. */
  times?: number
  message: string
}

/**
 * Fails chosen calls with a plain Error, the way an unreachable node fails —
 * `HttpNode` throws `KeiError('node-unreachable')`, a proxying setup throws
 * whatever it throws, and the market must treat both as "this chain did not
 * answer", so the harness deliberately throws the *less* structured shape.
 */
export class FaultNode extends DelegateNode {
  private readonly rules: FaultRule[] = []

  breakCall(rule: FaultRule): void {
    this.rules.push({ ...rule })
  }

  heal(): void {
    this.rules.length = 0
  }

  private trip(method: CountedMethod, key: string): void {
    for (const rule of this.rules) {
      if (rule.method !== method) continue
      if (rule.key !== undefined && rule.key !== key) continue
      if (rule.times !== undefined) {
        if (rule.times <= 0) continue
        rule.times -= 1
      }
      throw new Error(rule.message)
    }
  }

  override accountInfo(address: string): Promise<AccountInfo | null> {
    this.trip('accountInfo', address)
    return super.accountInfo(address)
  }
  override accountSwaps(
    address: string,
    options?: { limit?: number; state?: SwapState },
  ): Promise<SwapOffer[]> {
    this.trip('accountSwaps', address)
    return super.accountSwaps(address, options)
  }
  override swapOffer(hash: string): Promise<SwapOffer | null> {
    this.trip('swapOffer', hash)
    return super.swapOffer(hash)
  }
  override accountHistory(address: string, options?: { limit?: number }): Promise<Block[]> {
    this.trip('accountHistory', address)
    return super.accountHistory(address, options)
  }
  override process(block: Block): Promise<{ hash: string }> {
    this.trip('process', block.account)
    return super.process(block)
  }
}

/**
 * A node whose pages are capped server-side, whatever limit the client asked
 * for. docs/rpc.md's `account_swaps` takes a `count`, and nothing in the
 * contract promises a server honours a large one — a public node bounds its
 * own work. `HttpNode` also defaults `count` to 100 when the SDK passes no
 * limit, while `MockNode` returns everything; this wrapper reproduces the
 * HTTP shape over the mock so the divergence is pinned instead of latent.
 */
export class PagingNode extends DelegateNode {
  constructor(
    inner: KeiNode,
    private readonly pageSize: number,
  ) {
    super(inner)
  }

  private cap(limit: number | undefined): number {
    return limit === undefined ? this.pageSize : Math.min(limit, this.pageSize)
  }

  override accountSwaps(
    address: string,
    options?: { limit?: number; state?: SwapState },
  ): Promise<SwapOffer[]> {
    return super.accountSwaps(address, { ...options, limit: this.cap(options?.limit) })
  }
  override accountHistory(address: string, options?: { limit?: number }): Promise<Block[]> {
    return super.accountHistory(address, { limit: this.cap(options?.limit) })
  }
  override holders(asset: AssetId, options?: { limit?: number }): Promise<HolderEntry[]> {
    return super.holders(asset, { limit: this.cap(options?.limit) })
  }
}

/**
 * A read model that lies. The ledger underneath still validates every block,
 * which is the property under test: SPEC §9.4 says whatever told the wallet
 * about a listing is a list of where to look and never an authority, and the
 * exact-restatement rule (SPEC §9.2, `swap-terms-mismatch`) is what makes a
 * lying node unable to move funds it was never signed over.
 */
export class TwoFacedNode extends DelegateNode {
  private readonly offerLies = new Map<string, (offer: SwapOffer) => SwapOffer | null>()
  private swapsLie: ((address: string, offers: SwapOffer[]) => SwapOffer[]) | null = null

  /** Doctor what `swap_info` reports for one offer. Return null to deny it exists. */
  lieAboutOffer(hash: string, lie: (offer: SwapOffer) => SwapOffer | null): void {
    this.offerLies.set(hash.toUpperCase(), lie)
  }

  /** Doctor whole `account_swaps` pages — duplicates, foreign rows, fabrications. */
  lieAboutSwaps(lie: (address: string, offers: SwapOffer[]) => SwapOffer[]): void {
    this.swapsLie = lie
  }

  override async swapOffer(hash: string): Promise<SwapOffer | null> {
    const honest = await super.swapOffer(hash)
    const lie = this.offerLies.get(String(hash).toUpperCase())
    if (!lie || !honest) return honest
    return lie(structuredClone(honest))
  }

  override async accountSwaps(
    address: string,
    options?: { limit?: number; state?: SwapState },
  ): Promise<SwapOffer[]> {
    const honest = await super.accountSwaps(address, options)
    return this.swapsLie ? this.swapsLie(address, structuredClone(honest)) : honest
  }
}

export type GateableMethod = 'process' | 'accountSwaps' | 'swapOffer'

export interface Held {
  method: GateableMethod
  /** The account (accountSwaps/process) or hash (swapOffer) the call names. */
  key: string
  /** The held block, when the method is `process`. */
  block?: Block
  /** Let the call through. The original caller's promise then settles normally. */
  release(): void
}

/**
 * Holds chosen calls mid-flight until the test releases them, which is what
 * turns "two writers race" from a coin flip into a schedule. Both writers get
 * past their own reads, both submit, and the test decides which block the
 * ledger sees first — the §9.2 conflict, pinned to whichever order the
 * scenario is about.
 */
export class GateNode extends DelegateNode {
  private matchers = new Map<GateableMethod, (key: string, block?: Block) => boolean>()
  private held: Held[] = []
  private waiters: Array<(held: Held) => void> = []

  /** Start holding calls to `method` whose key (or block) matches. */
  hold(method: GateableMethod, match?: (key: string, block?: Block) => boolean): void {
    this.matchers.set(method, match ?? (() => true))
  }

  /** Stop holding new calls. Already-held calls stay held until released. */
  open(method: GateableMethod): void {
    this.matchers.delete(method)
  }

  /** The next held call, in arrival order, or a bounded diagnostic failure. */
  captured(timeout = 2_000): Promise<Held> {
    const ready = this.held.shift()
    if (ready) return Promise.resolve(ready)
    return new Promise((resolve, reject) => {
      let settled = false
      const waiter = (held: Held): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(held)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error(`Timed out after ${timeout}ms waiting for a gated node call`))
      }, timeout)
      this.waiters.push(waiter)
    })
  }

  private async maybeHold(method: GateableMethod, key: string, block?: Block): Promise<void> {
    const match = this.matchers.get(method)
    if (!match || !match(key, block)) return
    await new Promise<void>((resolve) => {
      const held: Held = { method, key, release: resolve, ...(block ? { block } : {}) }
      const waiter = this.waiters.shift()
      if (waiter) waiter(held)
      else this.held.push(held)
    })
  }

  override async process(block: Block): Promise<{ hash: string }> {
    await this.maybeHold('process', block.account, block)
    return super.process(block)
  }
  override async accountSwaps(
    address: string,
    options?: { limit?: number; state?: SwapState },
  ): Promise<SwapOffer[]> {
    await this.maybeHold('accountSwaps', address)
    return super.accountSwaps(address, options)
  }
  override async swapOffer(hash: string): Promise<SwapOffer | null> {
    await this.maybeHold('swapOffer', hash)
    return super.swapOffer(hash)
  }
}
