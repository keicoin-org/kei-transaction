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
import { safeEndpoint } from './endpoint.js'
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
  SwapOffer,
  SwapState,
  Unsubscribe,
} from './node.js'

/** Long enough for a public node paying for DNS, TCP and TLS at once; short enough to be a bound. */
const DEFAULT_REQUEST_TIMEOUT = 30_000

/**
 * How far backoff is allowed to grow a failing poll's wait — a ceiling on the
 * doubling, not on the wait itself: a `pollInterval` already longer than this
 * is honoured rather than shortened to it.
 */
const MAX_POLL_BACKOFF = 30_000

export interface HttpNodeOptions {
  url: string
  network?: NetworkName
  /** Milliseconds between receivable polls. Sockets are a later optimisation. */
  pollInterval?: number
  /**
   * Milliseconds before a request is abandoned and fails as `node-timeout`.
   * Defaults to 30 seconds, and must be a finite number above zero: a node or
   * proxy that accepts a request and never finishes the response otherwise
   * leaves `Kei.start()`, a send, or a read pending forever.
   *
   * The bound is the client's own — it holds even against a `fetch` that
   * ignores the abort it is given — and it covers reading the response body,
   * not just opening the connection.
   */
  requestTimeout?: number
  headers?: Record<string, string>
  fetch?: typeof globalThis.fetch
}

export class HttpNode implements KeiNode {
  readonly network: NetworkName
  private readonly url: string
  /** `url` with everything an error must not repeat taken out of it. */
  private readonly endpoint: string
  private readonly pollInterval: number
  private readonly requestTimeout: number
  private readonly headers: Record<string, string>
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: HttpNodeOptions) {
    if (!options?.url) {
      fail('no-node-url', 'HttpNode needs a node URL, for example https://node.kei.dev.')
    }
    this.url = options.url
    this.endpoint = safeEndpoint(options.url)
    this.network = options.network ?? 'testnet'
    this.pollInterval = options.pollInterval ?? 2_000
    const timeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT
    if (!Number.isFinite(timeout) || timeout <= 0) {
      fail(
        'bad-request-timeout',
        `requestTimeout must be a finite number of milliseconds above zero, not ${String(options.requestTimeout)}. There is deliberately no "wait forever": a node that accepts a request and never answers it would hang every call made through this client.`,
      )
    }
    this.requestTimeout = timeout
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

  /**
   * One RPC round trip, bounded.
   *
   * The bound is a raced promise and not just an `AbortSignal`, because a
   * signal is a request an implementation is free to ignore: an injected,
   * proxied or simply buggy `fetch` that never looks at it would hang the call
   * for as long as the process lives, which is the failure this is here to
   * remove. The signal is still passed and still aborted, because that is what
   * frees a real socket, DNS lookup or TLS handshake; it just is not what makes
   * the call settle.
   *
   * The bound covers the whole exchange rather than the connection alone: a
   * node that sends headers and then stops mid-body hangs `response.json()`
   * exactly as a node that never answers hangs `fetch`, so the race is only
   * given up once the body has been read.
   *
   * `signal` belongs to a subscription, so unsubscribing settles the poll it is
   * in the middle of. Nothing else passes one, and nothing here retries: a
   * direct call is one attempt, because replaying `process` would be replaying
   * a signed block whose first attempt may well have landed.
   */
  private async call<T>(
    action: string,
    payload: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw this.cancelled(action)

    const controller = new AbortController()
    // Why the request stopped, when it stopped for a reason of this client's
    // own. A cancelled subscription and a node that went quiet are different
    // facts and the caller acts on them differently.
    let stopped: KeiError | undefined
    let abandon!: (reason: KeiError) => void
    const deadline = new Promise<never>((_resolve, reject) => {
      abandon = reject
    })
    const stop = (reason: KeiError): void => {
      if (stopped) return
      stopped = reason
      controller.abort()
      abandon(reason)
    }

    const timer = setTimeout(() => stop(this.timedOut(action)), this.requestTimeout)
    const relay = (): void => stop(this.cancelled(action))
    signal?.addEventListener('abort', relay)

    const request = (async (): Promise<T> => {
      let response: Response
      try {
        response = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({ action, ...payload }),
          signal: controller.signal,
        })
      } catch {
        throw (
          stopped ??
          new KeiError(
            'node-unreachable',
            `Could not reach the Kei node at ${this.endpoint}. Check the URL and that the node is running.`,
          )
        )
      }
      if (!response.ok) {
        throw new KeiError(
          'node-error',
          `The Kei node at ${this.endpoint} answered ${response.status} for "${action}".`,
        )
      }
      let body: { error?: string } & T
      try {
        body = (await response.json()) as { error?: string } & T
      } catch (cause) {
        // An abort mid-body arrives here rather than at the fetch above.
        if (stopped) throw stopped
        throw cause
      }
      if (body && typeof body === 'object' && typeof body.error === 'string') {
        throw new KeiError('node-error', `The node rejected "${action}": ${body.error}`)
      }
      return body
    })()

    try {
      // `Promise.race` subscribes to both sides, so a request that loses and
      // rejects afterwards — an abort a well-behaved `fetch` did honour, say —
      // is already handled rather than an unhandled rejection.
      return await Promise.race([request, deadline])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', relay)
      // Nothing rejects `deadline` after this point, so the losing side of a
      // race the request won stays pending and is collected.
    }
  }

  private timedOut(action: string): KeiError {
    return new KeiError(
      'node-timeout',
      `The Kei node at ${this.endpoint} did not answer "${action}" within ${this.requestTimeout}ms, so the request was abandoned. Check that the node is healthy, or raise requestTimeout if it is simply slow.`,
    )
  }

  private cancelled(action: string): KeiError {
    return new KeiError(
      'request-cancelled',
      `The "${action}" request to ${this.endpoint} was cancelled before it finished.`,
    )
  }

  async accountInfo(address: string): Promise<AccountInfo | null> {
    const result = await this.call<{ account?: AccountInfo | null }>('account_info', { account: address })
    return result.account ?? null
  }

  async accountHistory(address: string, options?: { limit?: number }): Promise<Block[]> {
    // `account_history` is the one action a Kei node and its Banano ancestor
    // answer differently under the same name and the same parameters, and the
    // two answers cannot be told apart by looking at them: Nano's entries put
    // the subtype in `type` and the counterparty in `account`, which parses
    // cleanly as a block and describes a different one. `shape` is what asks
    // for ours. Omitting it does not fail — it silently reads Nano's entries
    // as blocks — so it is not optional here.
    const result = await this.call<{ history?: Block[] }>('account_history', {
      account: address,
      count: options?.limit ?? 100,
      shape: 'block',
    })
    return result.history ?? []
  }

  async blockInfo(hash: string): Promise<Block | null> {
    const result = await this.call<{ block?: Block | null }>('block_info', { hash })
    return result.block ?? null
  }

  async receivables(address: string): Promise<Receivable[]> {
    return this.pollReceivables(address)
  }

  /** `receivables`, with the subscription's signal threaded through it. */
  private async pollReceivables(address: string, signal?: AbortSignal): Promise<Receivable[]> {
    const result = await this.call<{ receivables?: Receivable[] }>(
      'accounts_receivable',
      { account: address },
      signal,
    )
    return result.receivables ?? []
  }

  /**
   * One attempt, always. A `process` that timed out may still have been
   * accepted, so resending it is a decision about a signed block that belongs
   * to the caller rather than to the transport.
   */
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

  async swapOffer(hash: string): Promise<SwapOffer | null> {
    const result = await this.call<{ offer?: SwapOffer | null }>('swap_info', { hash })
    return result.offer ?? null
  }

  async accountSwaps(
    address: string,
    options?: { limit?: number; state?: SwapState },
  ): Promise<SwapOffer[]> {
    const result = await this.call<{ offers?: SwapOffer[] }>('account_swaps', {
      account: address,
      count: options?.limit ?? 100,
      ...(options?.state === undefined ? {} : { state: options.state }),
    })
    return result.offers ?? []
  }

  /**
   * Polling, because a plain RPC node has nothing to push with.
   *
   * One poll at a time. An interval starts the next request whether or not the
   * last one was ever answered, so against a slow or hung node the outstanding
   * requests grow without bound; scheduling from `finally` instead means a
   * wallet asks a struggling node less rather than more.
   */
  subscribe(address: string, listener: (event: Notification) => void): Unsubscribe {
    const seen = new Set<string>()
    const cancel = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let failures = 0

    const schedule = (delay: number): void => {
      if (stopped) return
      timer = setTimeout(() => {
        timer = undefined
        void poll()
      }, delay)
    }

    const poll = async (): Promise<void> => {
      if (stopped) return
      try {
        const receivables = await this.pollReceivables(address, cancel.signal)
        if (stopped) return
        failures = 0
        for (const receivable of receivables) {
          if (seen.has(receivable.hash)) continue
          seen.add(receivable.hash)
          // Checked per event, not once: a listener is free to unsubscribe from
          // inside one, and the rest of this batch is then no longer wanted.
          if (stopped) return
          listener({ kind: 'receivable', account: address, hash: receivable.hash })
        }
        // `seen` only needs to remember what could still come back from the
        // next poll. Once a hash is off the node's own list it cannot match
        // again, so keeping it is pure residue — prune to exactly what this
        // poll said is outstanding. Only on success: a failed poll answers
        // nothing, and reading that as "the backlog is empty" would clear
        // `seen` and re-notify everything on the next one that works.
        const outstanding = new Set(receivables.map((receivable) => receivable.hash))
        for (const hash of seen) if (!outstanding.has(hash)) seen.delete(hash)
        schedule(this.pollInterval)
      } catch {
        // A missed poll has no caller to surface it to, so it stays quiet — but
        // it is still a reason to slow down rather than to keep the same rate.
        if (stopped) return
        failures += 1
        schedule(this.retryDelay(failures))
      }
    }

    void poll()

    return () => {
      if (stopped) return
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      // Aborts the request this poll is inside. Without it, unsubscribing only
      // ever stopped the *next* one.
      cancel.abort()
    }
  }

  /**
   * How long a failed poll waits before trying again: doubling from one poll
   * interval, capped, and jittered across the top half of the window so a node
   * coming back up does not meet every wallet that was waiting for it in the
   * same millisecond.
   *
   * The floor is the poll interval, and it outranks the cap: a wallet that
   * asked to be polled once a minute is not moved to every thirty seconds by
   * the node failing. That is the point of backing off at all — a node that is
   * timing out must never be asked more often than a healthy one.
   */
  private retryDelay(failures: number): number {
    const interval = Math.max(this.pollInterval, 1)
    const ceiling = Math.min(interval * 2 ** Math.min(failures, 10), Math.max(interval, MAX_POLL_BACKOFF))
    return Math.max(interval, ceiling / 2 + Math.random() * (ceiling / 2))
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
