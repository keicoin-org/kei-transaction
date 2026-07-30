/**
 * Tokens.
 *
 * The issuer picks two policy values at issuance and never thinks about them
 * again (SPEC §5.4): `transfer` is protocol-enforced and immutable, `swap` is
 * immutable on-chain metadata the node stores and never acts on, and `rate` is
 * issuer configuration that never touches the chain because pricing has to stay
 * adjustable.
 */

import type { AssetId, AssetInfo, KeiClient, SwapPolicy, TransferPolicy } from '@kei/core'
import {
  ISSUANCE_BURN,
  KEI_DECIMALS,
  assertAddress,
  deriveAssetId,
  fail,
  formatRaw,
  fromRaw,
  normalizeSymbol,
  toRaw,
} from '@kei/core'
import { buildCommit, type CommitEntry } from '@kei/claims'
import type { BuiltCommit } from '@kei/claims'

export interface IssueOptions {
  name: string
  symbol: string
  decimals?: number
  /** Omit for uncapped. Caps circulating supply, so burning frees headroom. */
  maxSupply?: number | string
  transfer?: TransferPolicy
  swap?: SwapPolicy
  /** Units per Kei at this issuer's own desk. Local config, never on-chain. */
  rate?: number
  description?: string
  /** An IPFS CID, or anything the configured uploader understands. */
  image?: string
  /** A hint for wallets. `items.create()` sets 'item'; nothing enforces it (SPEC §7). */
  kind?: 'token' | 'item'
}

export interface TokenFacts {
  id: AssetId
  name: string
  symbol: string
  decimals: number
  issuer: string
  maxSupply: number | null
  /**
   * The immutable, protocol-enforced policy (SPEC §5.4). Named `transferPolicy`
   * here because `transfer()` is the method §6.7 calls; the option passed to
   * `issue()` is still spelled `transfer`.
   */
  transferPolicy: TransferPolicy
  swap: SwapPolicy
}

export interface IssuerToken extends TokenFacts {
  /** The issuer's own swap rate. Local configuration (SPEC §5.4). */
  readonly rate: number | undefined
  /** Last known circulating supply. `supply()` re-reads it from the chain. */
  readonly totalSupply: number
  supply(): Promise<number>
  info(): Promise<AssetInfo>
  mint(to: string, amount: number | string): Promise<{ hash: string; to: string; amount: number }>
  burn(amount: number | string): Promise<{ hash: string; amount: number }>
  transfer(to: string, amount: number | string): Promise<{ hash: string; to: string; amount: number }>
  balance(): Promise<number>
  balanceOf(address: string): Promise<number>
  holders(limit?: number): Promise<Array<{ account: string; balance: number }>>
  /** Publish one root covering a whole batch of entitlements (SPEC §5.5). */
  commit(entries: readonly CommitEntry[]): Promise<PublishedCommit>
  /** Mark a root as accepting no further claims, making it prunable (SPEC §5.5). */
  close(root: string): Promise<{ hash: string }>
}

export interface PublishedCommit extends BuiltCommit {
  hash: string
}

export interface PlayerToken extends TokenFacts {
  info(): Promise<AssetInfo>
  balance(): Promise<number>
  balanceOf(address: string): Promise<number>
  transfer(to: string, amount: number | string): Promise<{ hash: string; to: string; amount: number }>
  on(event: 'transfer', listener: (transfer: TokenTransfer) => void): () => void
}

export interface TokenTransfer {
  from: string
  to: string
  amount: number
  hash: string
}

function factsOf(info: AssetInfo): TokenFacts {
  return {
    id: info.id,
    name: info.name,
    symbol: info.symbol,
    decimals: info.decimals,
    issuer: info.issuer,
    maxSupply: info.maxSupply === null ? null : fromRaw(BigInt(info.maxSupply), info.decimals),
    transferPolicy: info.transfer,
    swap: info.swap,
  }
}

/**
 * Idempotent per (issuer, symbol): asset ids are derived, so re-issuing the same
 * symbol from the same account returns the token that already exists rather than
 * burning another 1,000 Kei (SPEC §5.6.1, §6.7).
 */
export async function issueToken(client: KeiClient, options: IssueOptions): Promise<IssuerToken> {
  if (client.role !== 'issuer') {
    fail(
      'not-issuer-context',
      'Only an issuer can create a token. Use Kei.server() on your game server — a browser must never hold the issuer seed (SPEC §6.3).',
    )
  }
  const symbol = normalizeSymbol(options.symbol)
  const decimals = options.decimals ?? 0
  const existing = await client.node.assetInfo(deriveAssetId(client.publicKey, symbol))
  if (existing) return wrapIssuerToken(client, existing, options.rate)

  const balance = await client.balanceRaw()
  if (balance < ISSUANCE_BURN) {
    fail(
      'insufficient-kei',
      `Issuing ${symbol} burns 1,000 Kei (SPEC §5.6.5) and this account holds ${formatRaw(balance, KEI_DECIMALS)} Kei. Fund ${client.address} first; on testnet call faucet().`,
    )
  }

  await client.submitAsset(
    {
      kind: 'issue',
      name: options.name,
      symbol,
      decimals,
      maxSupply: options.maxSupply === undefined ? null : toRaw(options.maxSupply, decimals, 'maxSupply').toString(),
      transfer: options.transfer ?? 'open',
      swap: options.swap ?? 'one-way',
      ...(options.description === undefined && options.image === undefined && options.kind === undefined
        ? {}
        : {
            metadata: {
              ...(options.description === undefined ? {} : { description: options.description }),
              ...(options.image === undefined ? {} : { image: options.image }),
              ...(options.kind === undefined ? {} : { kind: options.kind }),
            },
          }),
    },
    -ISSUANCE_BURN,
  )

  const info = await client.node.assetInfo(deriveAssetId(client.publicKey, symbol))
  if (!info) fail('issue-failed', `${symbol} was published but cannot be read back. This is a node bug.`)
  return wrapIssuerToken(client, info, options.rate)
}

export function wrapIssuerToken(client: KeiClient, info: AssetInfo, rate?: number): IssuerToken {
  const facts = factsOf(info)
  let circulating = fromRaw(BigInt(info.circulating), info.decimals)

  const refresh = async (): Promise<AssetInfo> => {
    const current = await client.node.assetInfo(facts.id)
    if (!current) fail('no-such-asset', `${facts.symbol} no longer exists on this network.`)
    circulating = fromRaw(BigInt(current.circulating), current.decimals)
    return current
  }

  const amountRaw = (amount: number | string, label: string): bigint => {
    const raw = toRaw(amount, facts.decimals, label)
    if (raw <= 0n) fail('bad-amount', `${label} must be greater than zero.`)
    return raw
  }

  return {
    ...facts,
    rate,
    get totalSupply() {
      return circulating
    },
    async supply() {
      await refresh()
      return circulating
    },
    info: refresh,

    async mint(to, amount) {
      const raw = amountRaw(amount, 'Mint amount')
      const { hash } = await client.submitAsset({
        kind: 'mint',
        asset: facts.id,
        to: assertAddress(to, 'recipient address'),
        amount: raw.toString(),
      })
      await refresh()
      return { hash, to, amount: fromRaw(raw, facts.decimals) }
    },

    async burn(amount) {
      const raw = amountRaw(amount, 'Burn amount')
      const { hash } = await client.submitAsset({ kind: 'burn', asset: facts.id, amount: raw.toString() })
      await refresh()
      return { hash, amount: fromRaw(raw, facts.decimals) }
    },

    async transfer(to, amount) {
      const raw = amountRaw(amount, 'Transfer amount')
      const { hash } = await client.submitAsset({
        kind: 'transfer',
        asset: facts.id,
        to: assertAddress(to, 'recipient address'),
        amount: raw.toString(),
      })
      return { hash, to, amount: fromRaw(raw, facts.decimals) }
    },

    async balance() {
      return this.balanceOf(client.address)
    },

    async balanceOf(address) {
      const raw = await client.node.holderBalance(facts.id, assertAddress(address, 'address'))
      return fromRaw(BigInt(raw), facts.decimals)
    },

    async holders(limit) {
      const entries = await client.node.holders(facts.id, limit === undefined ? {} : { limit })
      return entries.map((entry) => ({
        account: entry.account,
        balance: fromRaw(BigInt(entry.balance), facts.decimals),
      }))
    },

    async commit(entries) {
      const built = buildCommit({ asset: facts.id, decimals: facts.decimals, entries })
      const { hash } = await client.submitAsset({
        kind: 'commit',
        root: built.root,
        asset: facts.id,
        count: built.count,
        total: built.total,
      })
      return { ...built, hash }
    },

    async close(root) {
      return client.submitAsset({ kind: 'commit_close', root })
    },
  }
}

/** Read a token somebody else issued, from the player's side (SPEC §6.7). */
export async function readToken(
  client: KeiClient,
  symbolOrId: string,
  issuer?: string,
): Promise<PlayerToken> {
  const info = await lookup(client, symbolOrId, issuer)
  const facts = factsOf(info)

  return {
    ...facts,
    async info() {
      const current = await client.node.assetInfo(facts.id)
      if (!current) fail('no-such-asset', `${facts.symbol} no longer exists on this network.`)
      return current
    },
    async balance() {
      return fromRaw(BigInt(await client.node.holderBalance(facts.id, client.address)), facts.decimals)
    },
    async balanceOf(address) {
      const raw = await client.node.holderBalance(facts.id, assertAddress(address, 'address'))
      return fromRaw(BigInt(raw), facts.decimals)
    },
    async transfer(to, amount) {
      const raw = toRaw(amount, facts.decimals, 'Transfer amount')
      if (raw <= 0n) fail('bad-amount', 'Transfer amount must be greater than zero.')
      const { hash } = await client.submitAsset({
        kind: 'transfer',
        asset: facts.id,
        to: assertAddress(to, 'recipient address'),
        amount: raw.toString(),
      })
      return { hash, to, amount: fromRaw(raw, facts.decimals) }
    },
    on(event, listener) {
      if (event !== 'transfer') fail('no-such-event', `A token emits "transfer", not "${String(event)}".`)
      const offReceived = client.on('asset-received', (payload) => {
        if (payload.asset !== facts.id) return
        listener({ from: payload.from, to: client.address, amount: payload.amount, hash: payload.hash })
      })
      return offReceived
    },
  }
}

async function lookup(client: KeiClient, symbolOrId: string, issuer?: string): Promise<AssetInfo> {
  if (issuer) {
    const info = await client.node.assetBySymbol(assertAddress(issuer, 'issuer address'), symbolOrId)
    if (info) return info
    fail(
      'no-such-asset',
      `${issuer} has not issued "${symbolOrId}". Check the symbol and the issuer address with the game.`,
    )
  }
  const info = await client.node.assetInfo(symbolOrId)
  if (info) return info
  fail(
    'no-such-asset',
    `No asset "${symbolOrId}" found. Pass the issuer's address as the second argument to look a token up by symbol.`,
  )
}
