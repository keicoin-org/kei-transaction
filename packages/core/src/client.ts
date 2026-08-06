/**
 * `KeiClient` is one account: it holds one key pair, writes to one chain, and
 * hides every mechanic SPEC §6.1 says a developer should never meet — raw units,
 * frontiers, work, and the receive step.
 *
 * It is deliberately not the public `Kei` class. `kei-transaction` composes this
 * with the token, claim and wallet namespaces (SPEC §10.1 keeps `@keicoin/core`
 * depending on nothing else in the tree).
 */

import { assertAddress, publicKeyFromAddress } from './address.js'
import { KEI_DECIMALS, formatRaw, fromRaw, toRaw } from './amount.js'
import type { AssetId, AssetOp, Block, BlockBody } from './blocks.js'
import { KEI_ASSET, ZERO_HASH, tierFor } from './blocks.js'
import { blake2b, signHash } from './crypto.js'
import { KeiError, fail, registerSecret } from './errors.js'
import { Emitter } from './events.js'
import { hashBlock } from './hash.js'
import { bytesToHex, utf8 } from './hex.js'
import type { KeyPair } from './keys.js'
import type { AssetInfo, KeiNode, Receivable, Unsubscribe } from './node.js'
import type { OwnershipChallengeMessage, OwnershipProof } from './ownership.js'
import { ownershipChallengeHash, parseOwnershipChallenge } from './ownership.js'
import type { WorkProvider } from './work.js'
import { workRoot } from './work.js'

/** Whether a player can see their own seed (SPEC §6.6). */
export type RevealPolicy = 'on-request' | 'never' | 'always'

/** Player context signs for a player; issuer context signs for the game (SPEC §6.3). */
export type Role = 'player' | 'issuer'

export interface PaymentEvent {
  from: string
  /**
   * Display value only — `fromRaw(raw, KEI_DECIMALS)`, a double. Above about
   * 0.009 Kei this loses precision, so never feed it back into a mint or
   * anything else the ledger has to agree with. Use `raw` for that.
   */
  amount: number
  /**
   * The exact amount paid, in raw KEI_DECIMALS units. Authoritative:
   * `BigInt(raw)` round-trips the receivable's amount exactly, which `amount`
   * cannot promise once it has been through a double.
   */
  raw: string
  /**
   * The receive block this account just wrote. It lives on the payee's own
   * chain, so the payer has never seen it.
   */
  hash: string
  /**
   * The payer's send block — the one id both parties hold, and what `pay()`
   * returned to them. Correlate an order by this, not by `hash`.
   */
  sendHash: string
  memo?: string
}

export interface ClientEvents extends Record<string, unknown> {
  received: PaymentEvent
  sent: { to: string; amount: number; raw: string; hash: string; memo?: string }
  'asset-received': {
    asset: AssetId
    symbol: string
    amount: number
    /** The exact amount received, in the asset's own raw decimal units. */
    raw: string
    from: string
    /** The receive block this account wrote. */
    hash: string
    /** The sender's send block — the id both parties hold. */
    sendHash: string
  }
  /** Anything that could change what a wallet panel shows. */
  update: { reason: string }
  error: KeiError
}

export interface ClientConfig {
  node: KeiNode
  work: WorkProvider
  keys: KeyPair
  role: Role
  reveal?: RevealPolicy
  autoReceive?: boolean
  representative?: string
}

export interface BlockDraft {
  previous: string
  balance: bigint
  representative: string
  height: number
}

const CLAIM_STORE_ADMISSION_DOMAIN = 'kei-claim-store-admission-v2\n'

/**
 * Hash the exact local claim-store record a wallet authorises.
 *
 * This is deliberately not a block hash and never reaches the ledger. The
 * network, account, root, and exact stored bytes are all signed so authority
 * cannot move between namespaces or records.
 */
export function claimStoreAdmissionHash(
  network: string,
  address: string,
  root: string,
  value: string,
): string {
  return bytesToHex(blake2b(utf8(
    `${CLAIM_STORE_ADMISSION_DOMAIN}${JSON.stringify([network, address, root, value])}`,
  ), 32))
}

export class KeiClient {
  readonly address: string
  readonly publicKey: string
  readonly node: KeiNode
  readonly role: Role
  readonly reveal: RevealPolicy

  /**
   * A real private field, not a `private` annotation. TypeScript's `private` is
   * a compile-time courtesy: the property would still be enumerable, so a crash
   * reporter calling JSON.stringify on this client would ship the seed
   * (SPEC §6.6 — no seed in any log, error, or network request).
   */
  readonly #keys: KeyPair
  private readonly work: WorkProvider
  private readonly emitter = new Emitter<ClientEvents>()
  private readonly assetMeta = new Map<AssetId, { symbol: string; decimals: number }>()
  private readonly defaultRepresentative: string

  private queue: Promise<unknown> = Promise.resolve()
  private unsubscribe: Unsubscribe | undefined
  private closed = false
  private receiving: Promise<number> | null = null
  private receiveAgain = false

  constructor(config: ClientConfig) {
    this.#keys = config.keys
    this.node = config.node
    this.work = config.work
    this.role = config.role
    this.reveal = config.reveal ?? 'on-request'
    this.address = config.keys.address
    this.publicKey = config.keys.publicKey
    this.defaultRepresentative = config.representative ?? config.keys.address
    registerSecret(config.keys.seed)
    registerSecret(config.keys.privateKey)
  }

  /**
   * The seed, for backup. Never logged, never transmitted, never in an error
   * (SPEC §6.4, §6.6).
   */
  get seed(): string {
    if (this.reveal === 'never') {
      fail(
        'seed-hidden',
        'This wallet was created with reveal: \'never\', so its seed cannot be read. Change the reveal policy at Kei.start() if players should be able to back up or move their wallet.',
      )
    }
    return this.#keys.seed
  }

  /**
   * Authorise exact bytes for this wallet's local claim store.
   *
   * The fixed domain cannot produce a ledger-valid block signature. Storage
   * receives only the resulting signature, never this client's private key.
   */
  async authorizeClaimStore(root: string, value: string): Promise<string> {
    return signHash(
      this.#keys.privateKey,
      claimStoreAdmissionHash(this.node.network, this.address, root, value),
    )
  }

  /**
   * Prove this wallet controls its address, to whoever asked (SPEC §6.3).
   *
   * The same fixed-domain shape as `authorizeClaimStore` and the same promise:
   * the digest is derived here from the parsed challenge, so the party asking
   * never names the bytes. Works under every `reveal` policy, because proving
   * control is what a wallet does with its key rather than something anyone
   * needs its seed for (SPEC §6.6).
   */
  async signOwnershipChallenge(challenge: OwnershipChallengeMessage): Promise<OwnershipProof> {
    const parsed = parseOwnershipChallenge(challenge)
    if (parsed.address !== this.address) {
      fail(
        'challenge-not-mine',
        'That challenge names a different wallet, so this one cannot answer it. Ask whoever issued it for one naming kei.address, which is the address this wallet can prove.',
      )
    }
    return {
      address: this.address,
      signature: await signHash(this.#keys.privateKey, ownershipChallengeHash(parsed)),
      challenge: parsed,
    }
  }

  // -------------------------------------------------------------- lifecycle

  /** Collect anything waiting, then keep collecting in the background. */
  async start(options: { autoReceive?: boolean } = {}): Promise<void> {
    if (options.autoReceive === false) return
    await this.receiveAll()
    this.unsubscribe = this.node.subscribe(this.address, (event) => {
      if (event.kind !== 'receivable') return
      void this.receiveAll().catch((error: unknown) => this.reportError(error))
    })
  }

  close(): void {
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.emitter.clear()
  }

  on<Key extends keyof ClientEvents & string>(
    event: Key,
    listener: (payload: ClientEvents[Key]) => void,
  ): () => void {
    return this.emitter.on(event, listener)
  }

  off<Key extends keyof ClientEvents & string>(
    event: Key,
    listener: (payload: ClientEvents[Key]) => void,
  ): void {
    this.emitter.off(event, listener)
  }

  /**
   * React to incoming Kei. The issuer half of a purchase (SPEC §6.7).
   *
   * The receive block has already landed by the time `handler` runs — the Kei
   * cannot be un-received — so a failure in here has to be reported, not lost.
   * `handler` is called inside an async function rather than invoked directly,
   * so a *synchronous* throw becomes a rejected promise before it can reach
   * `Emitter.emit`'s own blanket catch (`events.ts`, right for `update`, wrong
   * for money): either way, `handler`'s failure reaches `reportError` and
   * emits `error` (#164).
   */
  onPayment(handler: (payment: PaymentEvent) => void | Promise<void>): () => void {
    return this.on('received', (payment) => {
      void (async () => handler(payment))().catch((error: unknown) => this.reportError(error))
    })
  }

  // ------------------------------------------------------------------ money

  async balanceRaw(): Promise<bigint> {
    const info = await this.node.accountInfo(this.address)
    return info ? BigInt(info.balance) : 0n
  }

  async balance(): Promise<number> {
    return fromRaw(await this.balanceRaw(), KEI_DECIMALS)
  }

  async send(to: string, amount: number | string, memo?: string): Promise<{
    hash: string
    amount: number
    to: string
    memo?: string
  }> {
    assertAddress(to, 'destination address')
    const raw = toRaw(amount, KEI_DECIMALS, 'Amount')
    if (raw === 0n) fail('bad-amount', 'Amount must be greater than zero.')
    if (to === this.address) {
      fail('self-send', 'That is this wallet\'s own address. Send to somebody else\'s address.')
    }
    if (memo !== undefined) {
      // decisions-m2.md §17: a Kei send has no field to carry a memo, and the
      // SDK refuses the same way it refuses commit/commit_close/claim — up
      // front, rather than building a block the node would reject or, worse,
      // silently strip the memo from. Correlate the payment by the hash
      // returned here instead: it is the send hash, and the recipient reads the
      // same value off `PaymentEvent.sendHash`, so nothing has to be passed out
      // of band for the two sides to agree on which payment this was.
      fail(
        'no-memo-yet',
        'kei.pay({ memo }) is not available yet — a memo on a Kei payment has no wire representation until M4. Correlate the payment by its hash instead: the hash this call returns is the send hash, and the recipient sees the same value as `sendHash` on the payment it receives. That match is exact, where a memo would only have narrowed an amount/timing guess.',
      )
    }

    const { hash } = await this.submit((draft) => {
      if (draft.balance < raw) {
        fail(
          'insufficient-kei',
          `Not enough Kei — balance is ${formatRaw(draft.balance, KEI_DECIMALS)}, tried to send ${formatRaw(raw, KEI_DECIMALS)}.`,
        )
      }
      return {
        type: 'state',
        subtype: 'send',
        account: this.address,
        previous: draft.previous,
        representative: draft.representative,
        balance: (draft.balance - raw).toString(),
        link: publicKeyFromAddress(to),
      }
    })

    const sent = { to, amount: fromRaw(raw, KEI_DECIMALS), raw: raw.toString(), hash }
    this.emitter.emit('sent', sent)
    return { hash, amount: sent.amount, to }
  }

  /** Testnet self-funding, so an agent needs no human step (SPEC §12). */
  async faucet(amount?: number | string): Promise<{ hash: string }> {
    if (this.node.network === 'mainnet') {
      fail(
        'no-faucet',
        'There is no faucet on mainnet. Send Kei to this address instead: ' + this.address,
      )
    }
    const raw = amount === undefined ? undefined : toRaw(amount, KEI_DECIMALS, 'Faucet amount').toString()
    const result = await this.node.faucet(this.address, raw)
    await this.receiveAll()
    return result
  }

  /**
   * Collect every receivable. Called automatically; the developer never learns
   * this step exists (SPEC §6.1, §5.6.3).
   */
  async receiveAll(): Promise<number> {
    if (this.closed) return 0
    // One drain at a time. A notification arriving mid-drain must not start a
    // second pass over the same receivables — both would try to collect them,
    // and one would lose.
    if (this.receiving) {
      this.receiveAgain = true
      return this.receiving
    }
    this.receiving = this.drain()
    try {
      return await this.receiving
    } finally {
      this.receiving = null
    }
  }

  private async drain(): Promise<number> {
    let collected = 0
    do {
      this.receiveAgain = false
      // Bounded, so a busy account cannot trap the caller here forever.
      for (let round = 0; round < 64; round++) {
        const receivables = await this.node.receivables(this.address)
        if (receivables.length === 0) break
        for (const receivable of receivables) {
          if (await this.receiveOne(receivable)) collected++
        }
      }
    } while (this.receiveAgain && !this.closed)
    return collected
  }

  /** True if this call collected it; false if somebody else already had. */
  private async receiveOne(receivable: Receivable): Promise<boolean> {
    try {
      await this.collect(receivable)
      return true
    } catch (error) {
      if (error instanceof KeiError && error.code === 'no-such-receivable') return false
      throw error
    }
  }

  private async collect(receivable: Receivable): Promise<void> {
    if (receivable.asset === KEI_ASSET) {
      const amount = BigInt(receivable.amount)
      const { hash } = await this.submit((draft) => ({
        type: 'state',
        subtype: draft.height === 0 ? 'open' : 'receive',
        account: this.address,
        previous: draft.previous,
        representative: draft.representative,
        balance: (draft.balance + amount).toString(),
        link: receivable.hash,
      }))
      this.emitter.emit('received', {
        from: receivable.from,
        amount: fromRaw(amount, KEI_DECIMALS),
        raw: amount.toString(),
        hash,
        sendHash: receivable.hash,
        ...(receivable.memo === undefined ? {} : { memo: receivable.memo }),
      })
      return
    }

    const meta = await this.assetMetaFor(receivable.asset)
    const assetRaw = BigInt(receivable.amount)
    const { hash } = await this.submitAsset({ kind: 'asset_receive', link: receivable.hash })
    this.emitter.emit('asset-received', {
      asset: receivable.asset,
      symbol: meta.symbol,
      amount: fromRaw(assetRaw, meta.decimals),
      raw: assetRaw.toString(),
      from: receivable.from,
      hash,
      sendHash: receivable.hash,
    })
  }

  // ------------------------------------------------------------- block plumbing

  /** Submit an asset operation. Used by `@keicoin/tokens` and `@keicoin/claims`. */
  async submitAsset(op: AssetOp, keiDelta = 0n): Promise<{ hash: string }> {
    return this.submit((draft) => ({
      type: 'asset',
      account: this.address,
      previous: draft.previous,
      representative: draft.representative,
      balance: (draft.balance + keiDelta).toString(),
      op,
    }))
  }

  /**
   * Build, sign, and publish one block.
   *
   * Serialised, because one account has one chain (SPEC §5.6.1): two blocks in
   * flight at once would fork it.
   */
  async submit(build: (draft: BlockDraft) => BlockBody): Promise<{ hash: string; block: Block }> {
    const run = this.queue.then(async () => {
      const info = await this.node.accountInfo(this.address)
      const draft: BlockDraft = {
        previous: info?.frontier ?? ZERO_HASH,
        balance: info ? BigInt(info.balance) : 0n,
        representative: info?.representative ?? this.defaultRepresentative,
        height: info?.height ?? 0,
      }
      const body = build(draft)
      const hash = hashBlock(body)
      const block: Block = {
        ...body,
        work: await this.work.generate(workRoot(body), tierFor(body)),
        signature: await signHash(this.#keys.privateKey, hash),
      }
      await this.node.process(block)
      // The next block will build on this one, so its work can be found now
      // rather than while the player waits (SPEC §5.5).
      this.work.precompute?.(hash, 'B')
      this.emitter.emit('update', { reason: describeBlock(body) })
      return { hash, block }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  // ------------------------------------------------------------------ assets

  async assetInfo(asset: AssetId): Promise<AssetInfo | null> {
    const info = await this.node.assetInfo(asset)
    if (info) this.assetMeta.set(info.id, { symbol: info.symbol, decimals: info.decimals })
    return info
  }

  /** Symbol and decimals are immutable, so they are worth caching. */
  async assetMetaFor(asset: AssetId): Promise<{ symbol: string; decimals: number }> {
    const cached = this.assetMeta.get(asset)
    if (cached) return cached
    const info = await this.node.assetInfo(asset)
    if (!info) {
      fail('no-such-asset', `No asset with id ${asset} exists on ${this.node.network}.`)
    }
    const meta = { symbol: info.symbol, decimals: info.decimals }
    this.assetMeta.set(asset, meta)
    return meta
  }

  /**
   * What a logger, crash reporter, or `console.log` sees. Explicit, so nothing
   * secret can be added to this class later and leak by default.
   */
  toJSON(): { address: string; network: string; role: Role; reveal: RevealPolicy } {
    return { address: this.address, network: this.node.network, role: this.role, reveal: this.reveal }
  }

  private reportError(error: unknown): void {
    const wrapped =
      error instanceof KeiError
        ? error
        : new KeiError('unexpected', error instanceof Error ? error.message : String(error))
    this.emitter.emit('error', wrapped)
  }
}

function describeBlock(body: BlockBody): string {
  return body.type === 'state' ? body.subtype : body.op.kind
}
