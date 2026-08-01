/**
 * The in-memory ledger.
 *
 * This is not a simulation of the API — it enforces the rules SPEC §5.6 and §7
 * settle, because the point of M0 is that the SDK is written against real
 * semantics and M3 can swap the transport without the API moving:
 *
 *   - one chain per account, asset ops alongside Kei ops (§5.6.1)
 *   - derived asset ids, so issuance idempotency is structural (§5.6.1)
 *   - assets arrive as receivable and are collected by the recipient (§5.6.3)
 *   - work tiers (§5.6.4), the nth asset an account issues burns n Kei (§5.6.5)
 *   - maxSupply caps circulating supply, so burning frees headroom (§5.6.6)
 *   - transfer policy enforced by the ledger, not requested by the SDK (§5.4)
 *   - holdings and holders indexed both ways, zero entries deleted (§7)
 *   - claims keyed (account, root), one leaf per account per root (§5.5)
 *   - reserve accounts name a null representative; weight is Kei-only (§5.6.2, §5.7)
 */

import { NULL_REPRESENTATIVE, addressFromPublicKey, assertAddress, publicKeyFromAddress } from '../address.js'
import { issuanceBurn, KEI_DECIMALS, KEI_TOTAL_SUPPLY } from '../amount.js'
import type {
  AssetBlockBody,
  AssetId,
  Block,
  BlockBody,
  StateBlockBody,
  SwapPolicy,
  TransferPolicy,
  WorkTier,
} from '../blocks.js'
import { KEI_ASSET, ZERO_HASH, deriveAssetId, normalizeSymbol, tierFor } from '../blocks.js'
import { signHash, verifyHash } from '../crypto.js'
import { fail } from '../errors.js'
import { hashBlock } from '../hash.js'
import { isHex } from '../hex.js'
import { keyPairFromSeed, type KeyPair } from '../keys.js'
import { leafHash, verifyProof } from '../merkle.js'
import type {
  AccountInfo,
  AssetInfo,
  CommitInfo,
  HolderEntry,
  Holding,
  NetworkName,
  Notification,
  Receivable,
  Unsubscribe,
} from '../node.js'
import { MOCK_THRESHOLDS, generateWork, meetsThreshold, workRoot } from '../work.js'

/** SPEC §7: unbounded per-account state in consensus code is how nodes die. */
export const MAX_ASSETS_PER_ACCOUNT = 1_024

const TRANSFER_POLICIES: readonly TransferPolicy[] = ['open', 'issuer-only', 'none']
const SWAP_POLICIES: readonly SwapPolicy[] = ['two-way', 'one-way', 'off']

interface LedgerAccount {
  address: string
  publicKey: string
  frontier: string
  height: number
  balance: bigint
  representative: string
}

interface AssetRecord {
  id: AssetId
  issuer: string
  name: string
  symbol: string
  decimals: number
  maxSupply: bigint | null
  transfer: TransferPolicy
  swap: SwapPolicy
  description?: string
  image?: string
  kind?: 'token' | 'item'
  circulating: bigint
}

interface CommitRecord {
  root: string
  issuer: string
  asset: AssetId
  count: number
  total: bigint
  closed: boolean
}

interface StoredReceivable extends Receivable {
  to: string
}

/**
 * Genesis allocation (SPEC §5.7). The seeds are fixed and public because this is
 * a mock: they exist so tests and the demo have a funded faucet, and M2 replaces
 * them with a real genesis block.
 */
const GENESIS_SEEDS = {
  reserve: '1'.repeat(64),
  grants: '2'.repeat(64),
  community: '3'.repeat(64),
  bounty: '4'.repeat(64),
  team: '5'.repeat(64),
} as const

type GenesisRole = keyof typeof GENESIS_SEEDS

const ALLOCATION_KEI: Record<GenesisRole, bigint> = {
  reserve: 900_000_000_000n,
  grants: 37_000_000_000n,
  community: 28_000_000_000n,
  bounty: 18_000_000_000n,
  team: 17_000_000_000n,
}

const CIRCULATING_ROLES: readonly GenesisRole[] = ['grants', 'community', 'bounty', 'team']

export interface LedgerOptions {
  network?: NetworkName
  thresholds?: Record<WorkTier, string>
  /** Default faucet payout, in Kei. */
  faucetAmount?: number
}

export class MockLedger {
  readonly network: NetworkName
  readonly thresholds: Record<WorkTier, string>

  private readonly accounts = new Map<string, LedgerAccount>()
  private readonly chains = new Map<string, Block[]>()
  private readonly blocks = new Map<string, Block>()
  private readonly assets = new Map<AssetId, AssetRecord>()

  /** SPEC §7: `holdings` keyed (account, asset). */
  private readonly holdings = new Map<string, bigint>()
  private readonly holdingsByAccount = new Map<string, Set<AssetId>>()
  /** SPEC §7: `holders` keyed (asset, account). The same facts, indexed both ways. */
  private readonly holders = new Map<string, bigint>()
  private readonly holdersByAsset = new Map<AssetId, Set<string>>()

  /**
   * SPEC §5.6.5: how many assets each account has issued, which prices its
   * next one. Its own map rather than a field on the account record, because
   * `commitBlock` rebuilds that record from the block and would drop it.
   */
  private readonly issuedByAccount = new Map<string, number>()

  private readonly receivables = new Map<string, StoredReceivable>()
  private readonly receivablesByAccount = new Map<string, Set<string>>()

  private readonly commits = new Map<string, CommitRecord>()
  /** Keyed (account, root) so a claim record prunes with its account (SPEC §5.5). */
  private readonly claimed = new Set<string>()

  private readonly listeners = new Map<string, Set<(event: Notification) => void>>()

  private readonly genesisKeys = new Map<GenesisRole, KeyPair>()
  private readonly reserveAccounts = new Set<string>()
  private readonly faucetAmount: bigint

  private constructor(options: LedgerOptions) {
    this.network = options.network ?? 'mock'
    this.thresholds = options.thresholds ?? MOCK_THRESHOLDS
    this.faucetAmount = BigInt(options.faucetAmount ?? 10) * 10n ** BigInt(KEI_DECIMALS)
  }

  static async create(options: LedgerOptions = {}): Promise<MockLedger> {
    const ledger = new MockLedger(options)
    await ledger.buildGenesis()
    return ledger
  }

  // ---------------------------------------------------------------- genesis

  private async buildGenesis(): Promise<void> {
    const circulating = CIRCULATING_ROLES.reduce((sum, role) => sum + ALLOCATION_KEI[role], 0n)
    if (circulating !== 100_000_000_000n) {
      fail(
        'bad-genesis',
        `Circulating allocations must sum to exactly 100,000,000,000 Kei (SPEC §5.7) — they sum to ${circulating}. This is a launch blocker.`,
      )
    }
    const total = circulating + ALLOCATION_KEI.reserve
    if (total * 10n ** BigInt(KEI_DECIMALS) !== KEI_TOTAL_SUPPLY) {
      fail(
        'bad-genesis',
        `Genesis must produce exactly 1,000,000,000,000 Kei (SPEC §5.7) — it produces ${total}.`,
      )
    }

    for (const role of Object.keys(GENESIS_SEEDS) as GenesisRole[]) {
      const keys = await keyPairFromSeed(GENESIS_SEEDS[role], 0)
      this.genesisKeys.set(role, keys)
      if (role === 'reserve') this.reserveAccounts.add(keys.address)

      const balance = ALLOCATION_KEI[role] * 10n ** BigInt(KEI_DECIMALS)
      const body: BlockBody = {
        type: 'state',
        subtype: 'open',
        account: keys.address,
        previous: ZERO_HASH,
        representative: role === 'reserve' ? NULL_REPRESENTATIVE : keys.address,
        balance: balance.toString(),
        link: ZERO_HASH,
      }
      const hash = hashBlock(body)
      const block: Block = { ...body, work: '0'.repeat(16), signature: '0'.repeat(128) }

      this.accounts.set(keys.address, {
        address: keys.address,
        publicKey: keys.publicKey,
        frontier: hash,
        height: 1,
        balance,
        representative: body.representative,
      })
      this.chains.set(keys.address, [block])
      this.blocks.set(hash, block)
    }
  }

  /** The genesis addresses, so a test or explorer can watch them (SPEC §5.7). */
  genesisAddresses(): Record<GenesisRole, string> {
    const out = {} as Record<GenesisRole, string>
    for (const [role, keys] of this.genesisKeys) out[role] = keys.address
    return out
  }

  isReserve(address: string): boolean {
    return this.reserveAccounts.has(address)
  }

  /**
   * Representative weight, derived from Kei balances only, with reserve accounts
   * excluded entirely (SPEC §5.6.2, §5.7). Token balances never appear here.
   */
  weights(): Map<string, bigint> {
    const out = new Map<string, bigint>()
    for (const account of this.accounts.values()) {
      if (this.reserveAccounts.has(account.address)) continue
      if (account.representative === NULL_REPRESENTATIVE) continue
      out.set(account.representative, (out.get(account.representative) ?? 0n) + account.balance)
    }
    return out
  }

  // ------------------------------------------------------------------ reads

  accountInfo(address: string): AccountInfo | null {
    const account = this.accounts.get(address)
    if (!account) return null
    return {
      address: account.address,
      frontier: account.frontier,
      height: account.height,
      balance: account.balance.toString(),
      representative: account.representative,
      receivableCount: this.receivablesByAccount.get(address)?.size ?? 0,
      issuedCount: this.issuedByAccount.get(address) ?? 0,
    }
  }

  accountHistory(address: string, limit?: number): Block[] {
    const chain = this.chains.get(address) ?? []
    const ordered = [...chain].reverse()
    return limit === undefined ? ordered : ordered.slice(0, limit)
  }

  blockInfo(hash: string): Block | null {
    return this.blocks.get(hash.toUpperCase()) ?? null
  }

  receivablesFor(address: string): Receivable[] {
    const hashes = this.receivablesByAccount.get(address)
    if (!hashes) return []
    const out: Receivable[] = []
    for (const hash of hashes) {
      const entry = this.receivables.get(hash)
      if (!entry) continue
      out.push({
        hash: entry.hash,
        from: entry.from,
        asset: entry.asset,
        amount: entry.amount,
        ...(entry.memo === undefined ? {} : { memo: entry.memo }),
      })
    }
    return out
  }

  assetInfo(asset: AssetId): AssetInfo | null {
    const record = this.assets.get(asset.toUpperCase())
    if (!record) return null
    return {
      id: record.id,
      issuer: record.issuer,
      name: record.name,
      symbol: record.symbol,
      decimals: record.decimals,
      maxSupply: record.maxSupply === null ? null : record.maxSupply.toString(),
      transfer: record.transfer,
      swap: record.swap,
      ...(record.description === undefined ? {} : { description: record.description }),
      ...(record.image === undefined ? {} : { image: record.image }),
      ...(record.kind === undefined ? {} : { kind: record.kind }),
      circulating: record.circulating.toString(),
    }
  }

  assetBySymbol(issuer: string, symbol: string): AssetInfo | null {
    return this.assetInfo(deriveAssetId(publicKeyFromAddress(issuer), symbol))
  }

  holdingsOf(address: string): Holding[] {
    const owned = this.holdingsByAccount.get(address)
    if (!owned) return []
    const out: Holding[] = []
    for (const asset of owned) {
      const balance = this.holdings.get(holdingKey(address, asset))
      if (balance !== undefined && balance > 0n) out.push({ asset, balance: balance.toString() })
    }
    return out
  }

  holderBalance(asset: AssetId, address: string): bigint {
    return this.holders.get(holderKey(asset.toUpperCase(), address)) ?? 0n
  }

  holdersOf(asset: AssetId, limit?: number): HolderEntry[] {
    const accounts = this.holdersByAsset.get(asset.toUpperCase())
    if (!accounts) return []
    const out: HolderEntry[] = []
    for (const account of accounts) {
      const balance = this.holders.get(holderKey(asset.toUpperCase(), account))
      if (balance !== undefined && balance > 0n) out.push({ account, balance: balance.toString() })
      if (limit !== undefined && out.length >= limit) break
    }
    return out
  }

  commitInfo(root: string): CommitInfo | null {
    const record = this.commits.get(root.toUpperCase())
    if (!record) return null
    return {
      root: record.root,
      issuer: record.issuer,
      asset: record.asset,
      count: record.count,
      total: record.total.toString(),
      closed: record.closed,
    }
  }

  hasClaimed(address: string, root: string): boolean {
    return this.claimed.has(claimKey(address, root.toUpperCase()))
  }

  subscribe(address: string, listener: (event: Notification) => void): Unsubscribe {
    const set = this.listeners.get(address) ?? new Set()
    set.add(listener)
    this.listeners.set(address, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(address)
    }
  }

  // ----------------------------------------------------------------- writes

  /**
   * Validate and apply one block, or reject it. Nothing mutates until every
   * check has passed, signature included.
   */
  async process(block: Block): Promise<{ hash: string }> {
    const body = bodyOf(block)
    const hash = hashBlock(body)

    if (this.blocks.has(hash)) return { hash }

    this.validateEnvelope(body, block.work)
    if (!(await verifyHash(hash, block.signature, publicKeyFromAddress(body.account)))) {
      fail(
        'bad-signature',
        `This block is not signed by ${body.account}. A private key can only sign for its own account (SPEC §6.3).`,
      )
    }

    const previousBalance = this.accounts.get(body.account)?.balance ?? 0n
    const newBalance = parseRaw(body.balance, 'balance')
    if (newBalance < 0n) fail('bad-balance', 'A balance cannot be negative.')

    if (body.type === 'state') {
      this.applyState(body, hash, previousBalance, newBalance)
    } else {
      this.applyAsset(body, hash, previousBalance, newBalance)
    }

    this.commitBlock(block, body, hash, newBalance)
    return { hash }
  }

  private validateEnvelope(body: BlockBody, work: string): void {
    assertAddress(body.account, 'account')
    assertAddress(body.representative, 'representative')

    const account = this.accounts.get(body.account)
    if (!account) {
      if (body.previous !== ZERO_HASH) {
        fail(
          'bad-previous',
          `${body.account} has no chain yet, so its first block must have previous = ${ZERO_HASH}.`,
        )
      }
    } else if (body.previous !== account.frontier) {
      fail(
        'fork',
        `${body.account} is at block ${account.frontier} but this block builds on ${body.previous}. Fetch the current frontier and try again.`,
      )
    }

    if (this.reserveAccounts.has(body.account) && body.representative !== NULL_REPRESENTATIVE) {
      fail(
        'reserve-representative',
        `Reserve accounts must name the null representative ${NULL_REPRESENTATIVE} (SPEC §5.7), so reserve Kei carries no weight of any kind.`,
      )
    }

    const tier = tierFor(body)
    const threshold = BigInt(this.thresholds[tier])
    if (!meetsThreshold(workRoot(body), work, threshold)) {
      fail(
        'bad-work',
        `Work for this ${describe(body)} does not meet tier ${tier} difficulty. Ask the work provider for work over root ${workRoot(body)}.`,
      )
    }
  }

  private applyState(
    body: StateBlockBody,
    hash: string,
    previousBalance: bigint,
    newBalance: bigint,
  ): void {
    switch (body.subtype) {
      case 'send': {
        if (this.reserveAccounts.has(body.account)) {
          fail(
            'reserve-locked',
            'Reserve Kei can only move through a passed on-chain vote (SPEC §5.7). Nothing moves without one, and the voting mechanism is not part of M0.',
          )
        }
        if (body.memo !== undefined) {
          // decisions-m2.md §17: a state block has no field for a memo, and
          // the real risk is not rejection — it is silent acceptance. The
          // node's JSON deserializer reads named fields and ignores the rest,
          // so an unguarded ledger would take this block, drop the memo, and
          // never say so. Refuse it here instead, the same as client.ts does
          // before ever building the block.
          fail(
            'no-memo-yet',
            'A memo on a Kei send has no wire representation until M4 (decisions-m2.md §17) — client.send() should have refused this before it reached the ledger.',
          )
        }
        if (!isHex(body.link, 32)) {
          fail('bad-link', 'A send block\'s link is the destination public key, 64 hex characters.')
        }
        const amount = previousBalance - newBalance
        if (amount <= 0n) {
          fail('bad-send', 'A send must decrease the sender\'s balance. Check the amount.')
        }
        this.createReceivable(hash, {
          hash,
          from: body.account,
          to: addressFromPublicKey(body.link),
          asset: KEI_ASSET,
          amount: amount.toString(),
        })
        return
      }
      case 'open':
      case 'receive': {
        const receivable = this.takeReceivable(body.link, body.account, KEI_ASSET)
        const expected = previousBalance + BigInt(receivable.amount)
        if (newBalance !== expected) {
          fail(
            'bad-receive',
            `Receiving ${receivable.amount} raw should leave a balance of ${expected}, not ${newBalance}.`,
          )
        }
        return
      }
      case 'change': {
        if (newBalance !== previousBalance) {
          fail('bad-change', 'A representative change must not move any Kei.')
        }
        return
      }
    }
  }

  private applyAsset(
    body: AssetBlockBody,
    hash: string,
    previousBalance: bigint,
    newBalance: bigint,
  ): void {
    const op = body.op

    if (op.kind === 'issue') {
      // The nth asset an account issues burns n Kei (SPEC §5.6.5). Checked
      // against the count before this block, which is what the signer read.
      const ordinal = (this.issuedByAccount.get(body.account) ?? 0) + 1
      const burn = issuanceBurn(ordinal - 1)
      if (previousBalance < burn) {
        fail(
          'insufficient-kei',
          `This is ${body.account}'s asset number ${ordinal}, which burns ${formatKei(burn)} — it holds ${formatKei(previousBalance)}. Fund it first; on testnet call faucet().`,
        )
      }
      if (newBalance !== previousBalance - burn) {
        fail(
          'bad-issuance-burn',
          `The nth asset an account issues burns n Kei (SPEC §5.6.5). This is number ${ordinal}, so this block burns ${formatKei(burn)} and must leave a balance of ${previousBalance - burn}.`,
        )
      }
    } else if (newBalance !== previousBalance) {
      fail(
        'bad-asset-balance',
        'An asset block must carry the account\'s Kei balance unchanged (SPEC §5.6.1). Only issuance changes it.',
      )
    }

    switch (op.kind) {
      case 'issue': {
        const symbol = normalizeSymbol(op.symbol)
        const publicKey = publicKeyFromAddress(body.account)
        const id = deriveAssetId(publicKey, symbol)
        if (this.assets.has(id)) {
          fail(
            'already-issued',
            `${body.account} has already issued ${symbol}. Asset ids are derived from (issuer, symbol), so re-issuing is a no-op — read the existing token instead.`,
          )
        }
        if (typeof op.name !== 'string' || op.name.trim() === '' || op.name.length > 64) {
          fail('bad-name', 'A token name is 1-64 characters of text.')
        }
        if (!Number.isInteger(op.decimals) || op.decimals < 0 || op.decimals > 18) {
          fail('bad-decimals', `Decimals must be a whole number from 0 to 18 — got ${String(op.decimals)}.`)
        }
        if (!TRANSFER_POLICIES.includes(op.transfer)) {
          fail(
            'bad-transfer-policy',
            `transfer must be one of ${TRANSFER_POLICIES.join(', ')} — got "${String(op.transfer)}".`,
          )
        }
        if (!SWAP_POLICIES.includes(op.swap)) {
          fail('bad-swap-policy', `swap must be one of ${SWAP_POLICIES.join(', ')} — got "${String(op.swap)}".`)
        }
        const maxSupply = op.maxSupply === null ? null : parseRaw(op.maxSupply, 'maxSupply')
        if (maxSupply !== null && maxSupply <= 0n) {
          fail('bad-max-supply', 'maxSupply must be at least one unit, or omitted for uncapped.')
        }
        this.assets.set(id, {
          id,
          issuer: body.account,
          name: op.name,
          symbol,
          decimals: op.decimals,
          maxSupply,
          transfer: op.transfer,
          swap: op.swap,
          ...(op.metadata?.description === undefined ? {} : { description: op.metadata.description }),
          ...(op.metadata?.image === undefined ? {} : { image: op.metadata.image }),
          ...(op.metadata?.kind === undefined ? {} : { kind: op.metadata.kind }),
          circulating: 0n,
        })
        // Priced the burn above; record it, so this account's next asset costs
        // one Kei more than this one did (SPEC §5.6.5).
        this.issuedByAccount.set(body.account, (this.issuedByAccount.get(body.account) ?? 0) + 1)
        return
      }

      case 'mint': {
        const asset = this.requireAsset(op.asset)
        if (asset.issuer !== body.account) {
          fail(
            'not-issuer',
            `Only ${asset.issuer} can mint ${asset.symbol}. This block is signed by ${body.account}.`,
          )
        }
        const amount = requirePositive(op.amount, 'mint amount')
        this.requireHeadroom(asset, amount)
        asset.circulating += amount
        this.createReceivable(hash, {
          hash,
          from: body.account,
          to: assertAddress(op.to, 'recipient'),
          asset: asset.id,
          amount: amount.toString(),
        })
        return
      }

      case 'burn': {
        const asset = this.requireAsset(op.asset)
        const amount = requirePositive(op.amount, 'burn amount')
        this.debit(body.account, asset, amount)
        asset.circulating -= amount
        return
      }

      case 'transfer': {
        const asset = this.requireAsset(op.asset)
        const to = assertAddress(op.to, 'recipient')
        const amount = requirePositive(op.amount, 'transfer amount')
        this.enforceTransferPolicy(asset, body.account, to)
        this.debit(body.account, asset, amount)
        this.createReceivable(hash, {
          hash,
          from: body.account,
          to,
          asset: asset.id,
          amount: amount.toString(),
          ...(op.memo === undefined ? {} : { memo: op.memo }),
        })
        return
      }

      case 'asset_receive': {
        const receivable = this.takeReceivableAnyAsset(op.link, body.account)
        if (receivable.asset === KEI_ASSET) {
          fail('wrong-block-type', 'Incoming Kei is collected by a receive block, not an asset block.')
        }
        this.credit(body.account, this.requireAsset(receivable.asset), BigInt(receivable.amount))
        return
      }

      case 'commit': {
        const asset = this.requireAsset(op.asset)
        if (asset.issuer !== body.account) {
          fail('not-issuer', `Only ${asset.issuer} can publish a commit for ${asset.symbol}.`)
        }
        if (!isHex(op.root, 32)) fail('bad-root', 'A commit root is 64 hex characters.')
        const root = op.root.toUpperCase()
        if (this.commits.has(root)) {
          fail('duplicate-root', `Root ${root} has already been published. Build a new batch instead.`)
        }
        if (!Number.isInteger(op.count) || op.count < 1) {
          fail('bad-commit', 'A commit covers at least one entitlement.')
        }
        this.commits.set(root, {
          root,
          issuer: body.account,
          asset: asset.id,
          count: op.count,
          total: parseRaw(op.total, 'commit total'),
          closed: false,
        })
        return
      }

      case 'commit_close': {
        const record = this.commits.get(op.root.toUpperCase())
        if (!record) fail('no-such-root', `No commit with root ${op.root} exists.`)
        if (record.issuer !== body.account) {
          fail('not-issuer', `Only ${record.issuer} can close root ${record.root}.`)
        }
        if (record.closed) return
        record.closed = true
        return
      }

      case 'claim': {
        const root = op.root.toUpperCase()
        const record = this.commits.get(root)
        if (!record) {
          fail(
            'no-such-root',
            `No commit with root ${op.root} exists, so there is nothing to claim. Ask the game for a current drop.`,
          )
        }
        if (record.closed) {
          fail(
            'root-closed',
            `Drop ${root} has been closed by its issuer and accepts no further claims (SPEC §5.5).`,
          )
        }
        if (this.claimed.has(claimKey(body.account, root))) {
          fail('already-claimed', `${body.account} has already claimed from drop ${root}.`)
        }
        const asset = this.requireAsset(op.asset)
        if (record.asset !== asset.id) {
          fail('wrong-asset', `Drop ${root} pays out ${record.asset}, not ${asset.id}.`)
        }
        if (asset.issuer !== record.issuer) {
          fail('not-issuer', `Drop ${root} was published by ${record.issuer}, who does not issue ${asset.symbol}.`)
        }
        const amount = requirePositive(op.amount, 'claim amount')
        const leaf = leafHash(publicKeyFromAddress(body.account), asset.id, amount)
        if (!verifyProof(leaf, op.proof, root)) {
          fail(
            'bad-proof',
            `That proof does not put ${body.account} in drop ${root} for ${op.amount}. Re-fetch the proof from the game.`,
          )
        }
        this.requireHeadroom(asset, amount)
        this.claimed.add(claimKey(body.account, root))
        asset.circulating += amount
        this.credit(body.account, asset, amount)
        return
      }
    }
  }

  private commitBlock(block: Block, body: BlockBody, hash: string, newBalance: bigint): void {
    const existing = this.accounts.get(body.account)
    this.accounts.set(body.account, {
      address: body.account,
      publicKey: existing?.publicKey ?? publicKeyFromAddress(body.account),
      frontier: hash,
      height: (existing?.height ?? 0) + 1,
      balance: newBalance,
      representative: body.representative,
    })
    const chain = this.chains.get(body.account) ?? []
    chain.push(block)
    this.chains.set(body.account, chain)
    this.blocks.set(hash, block)
    this.notify(body.account, { kind: 'block', account: body.account, hash })
  }

  // -------------------------------------------------------------- internals

  private requireAsset(asset: AssetId): AssetRecord {
    const record = this.assets.get(String(asset).toUpperCase())
    if (!record) {
      fail('no-such-asset', `No asset with id ${String(asset)} exists on this network.`)
    }
    return record
  }

  private requireHeadroom(asset: AssetRecord, amount: bigint): void {
    if (asset.maxSupply === null) return
    if (asset.circulating + amount > asset.maxSupply) {
      const room = asset.maxSupply - asset.circulating
      fail(
        'over-max-supply',
        `${asset.symbol} has a maximum supply of ${asset.maxSupply} and ${asset.circulating} in circulation, so only ${room} can be created. Burn some first — burning frees headroom (SPEC §5.6.6).`,
      )
    }
  }

  private enforceTransferPolicy(asset: AssetRecord, from: string, to: string): void {
    switch (asset.transfer) {
      case 'open':
        return
      case 'issuer-only':
        if (from === asset.issuer || to === asset.issuer) return
        fail(
          'transfer-not-permitted',
          `${asset.symbol} is issuer-only: units may only move to or from ${asset.issuer}. Players cannot trade it with each other (SPEC §5.4).`,
        )
      case 'none':
        fail(
          'transfer-not-permitted',
          `${asset.symbol} cannot be transferred at all — it is soulbound. It can only be burned (SPEC §5.4).`,
        )
    }
  }

  private credit(account: string, asset: AssetRecord, amount: bigint): void {
    const owned = this.holdingsByAccount.get(account) ?? new Set<AssetId>()
    if (!owned.has(asset.id) && owned.size >= MAX_ASSETS_PER_ACCOUNT) {
      fail(
        'too-many-assets',
        `${account} already holds ${MAX_ASSETS_PER_ACCOUNT} different assets, which is the per-account limit (SPEC §7). Burn or transfer something before receiving more.`,
      )
    }
    const key = holdingKey(account, asset.id)
    this.holdings.set(key, (this.holdings.get(key) ?? 0n) + amount)
    owned.add(asset.id)
    this.holdingsByAccount.set(account, owned)

    const reverse = holderKey(asset.id, account)
    this.holders.set(reverse, (this.holders.get(reverse) ?? 0n) + amount)
    const holders = this.holdersByAsset.get(asset.id) ?? new Set<string>()
    holders.add(account)
    this.holdersByAsset.set(asset.id, holders)
  }

  private debit(account: string, asset: AssetRecord, amount: bigint): void {
    const key = holdingKey(account, asset.id)
    const held = this.holdings.get(key) ?? 0n
    if (held < amount) {
      fail(
        'insufficient-balance',
        `Not enough ${asset.symbol} — balance is ${held}, tried to move ${amount}.`,
      )
    }
    const remaining = held - amount
    const reverse = holderKey(asset.id, account)

    if (remaining === 0n) {
      // Zero entries are deleted, not kept at zero, so state shrinks when a
      // player spends (SPEC §7).
      this.holdings.delete(key)
      this.holdingsByAccount.get(account)?.delete(asset.id)
      if (this.holdingsByAccount.get(account)?.size === 0) this.holdingsByAccount.delete(account)
      this.holders.delete(reverse)
      this.holdersByAsset.get(asset.id)?.delete(account)
      if (this.holdersByAsset.get(asset.id)?.size === 0) this.holdersByAsset.delete(asset.id)
      return
    }
    this.holdings.set(key, remaining)
    this.holders.set(reverse, remaining)
  }

  private createReceivable(hash: string, receivable: StoredReceivable): void {
    this.receivables.set(hash, receivable)
    const set = this.receivablesByAccount.get(receivable.to) ?? new Set<string>()
    set.add(hash)
    this.receivablesByAccount.set(receivable.to, set)
    this.notify(receivable.to, { kind: 'receivable', account: receivable.to, hash })
  }

  private takeReceivable(link: string, account: string, asset: AssetId): StoredReceivable {
    const receivable = this.takeReceivableAnyAsset(link, account)
    if (receivable.asset !== asset) {
      fail('wrong-asset', `Receivable ${link} is for asset ${receivable.asset}, not ${asset}.`)
    }
    return receivable
  }

  private takeReceivableAnyAsset(link: string, account: string): StoredReceivable {
    const key = String(link).toUpperCase()
    const receivable = this.receivables.get(key)
    if (!receivable) {
      fail(
        'no-such-receivable',
        `There is nothing receivable at ${String(link)} — it may already have been received.`,
      )
    }
    if (receivable.to !== account) {
      fail('not-recipient', `Receivable ${key} belongs to ${receivable.to}, not ${account}.`)
    }
    this.receivables.delete(key)
    this.receivablesByAccount.get(account)?.delete(key)
    if (this.receivablesByAccount.get(account)?.size === 0) this.receivablesByAccount.delete(account)
    return receivable
  }

  private notify(account: string, event: Notification): void {
    const listeners = this.listeners.get(account)
    if (!listeners) return
    for (const listener of [...listeners]) {
      queueMicrotask(() => listener(event))
    }
  }

  // ---------------------------------------------------------------- faucet

  /** Testnet convenience: pay out from the community allocation (SPEC §5.7, §12). */
  async faucet(address: string, amountRaw?: bigint): Promise<{ hash: string }> {
    assertAddress(address, 'address')
    const keys = this.genesisKeys.get('community')
    if (!keys) fail('no-faucet', 'This ledger has no faucet account.')
    const amount = amountRaw ?? this.faucetAmount
    return this.sendAs(keys, address, amount)
  }

  /** Sign and process a send from a ledger-held genesis key. */
  private async sendAs(keys: KeyPair, to: string, amount: bigint): Promise<{ hash: string }> {
    const account = this.accounts.get(keys.address)
    if (!account) fail('no-such-account', `${keys.address} has no chain.`)
    if (account.balance < amount) {
      fail('insufficient-kei', `${keys.address} holds ${formatKei(account.balance)}, which is less than ${formatKei(amount)}.`)
    }
    const body: BlockBody = {
      type: 'state',
      subtype: 'send',
      account: keys.address,
      previous: account.frontier,
      representative: account.representative,
      balance: (account.balance - amount).toString(),
      link: publicKeyFromAddress(to),
    }
    const hash = hashBlock(body)
    const block: Block = {
      ...body,
      work: generateWork(workRoot(body), BigInt(this.thresholds[tierFor(body)])),
      signature: await signHash(keys.privateKey, hash),
    }
    return this.process(block)
  }
}

function bodyOf(block: Block): BlockBody {
  const { work, signature, ...body } = block
  void work
  void signature
  return body as BlockBody
}

function holdingKey(account: string, asset: AssetId): string {
  return `${account}|${asset}`
}

function holderKey(asset: AssetId, account: string): string {
  return `${asset}|${account}`
}

function claimKey(account: string, root: string): string {
  return `${account}|${root}`
}

function parseRaw(value: string, label: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    fail('bad-amount', `${label} must be a whole number of raw units as a string — got "${String(value)}".`)
  }
  return BigInt(value)
}

function requirePositive(value: string, label: string): bigint {
  const amount = parseRaw(value, label)
  if (amount <= 0n) fail('bad-amount', `${label} must be greater than zero.`)
  return amount
}

function formatKei(raw: bigint): string {
  const whole = raw / 10n ** BigInt(KEI_DECIMALS)
  return `${whole} Kei`
}

function describe(body: BlockBody): string {
  return body.type === 'state' ? `${body.subtype} block` : `${body.op.kind} block`
}
