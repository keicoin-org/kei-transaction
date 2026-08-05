/**
 * Tokens.
 *
 * The issuer picks two policy values at issuance and never thinks about them
 * again (SPEC §5.4): `transfer` is protocol-enforced and immutable, `swap` is
 * immutable on-chain metadata the node stores and never acts on, and `rate` is
 * issuer configuration that never touches the chain because pricing has to stay
 * adjustable.
 */

import type { AssetId, AssetInfo, KeiClient, SwapPolicy, TransferPolicy } from '@keicoin/core'
import {
  KEI_DECIMALS,
  issuanceBurn,
  assertAddress,
  deriveAssetId,
  fail,
  formatRaw,
  fromRaw,
  normalizeSymbol,
  toRaw,
} from '@keicoin/core'
import { buildCommit, type CommitEntry } from '@keicoin/claims'
import type { BuiltCommit } from '@keicoin/claims'

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

/**
 * Every `IssueOptions` field the chain stores, and so every field a re-issue can
 * contradict.
 *
 * `symbol` is absent because it is the identity being looked up rather than a
 * property of it, and `rate` because it is issuer configuration that never
 * reaches a block (SPEC §5.4) — changing your desk's price is not a re-issue.
 * Those two are the whole of what `issue()` does not compare.
 */
export type IssuanceField =
  | 'name'
  | 'decimals'
  | 'maxSupply'
  | 'transfer'
  | 'swap'
  | 'description'
  | 'image'
  | 'kind'

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
  /**
   * Destroy units this wallet holds.
   *
   * Burning is the holder's own block, not the issuer's — the ledger checks who
   * holds the units, not who issued them (SPEC §5.6.6) — so a repair fee, a
   * re-roll, or a consumable is one signed block from the player and needs no
   * issuer round trip. It is also the only thing a soulbound token can do
   * (SPEC §5.4), and the only way a capped supply gets its headroom back.
   */
  burn(amount: number | string): Promise<{ hash: string; amount: number }>
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
 * paying for another one (SPEC §5.6.1, §6.7). That matters more than it used to:
 * the nth asset an account issues burns n Kei, so a duplicate would not merely
 * cost again, it would cost more.
 *
 * Idempotent, not indifferent. Issuance parameters are immutable (SPEC §5.4,
 * §7), so reusing the stored asset is only honest when the stored asset is the
 * one being asked for. Every field the caller actually passed is compared
 * against the chain first, and a difference is refused with the field named —
 * because the developer's source file is the only place the intent exists, and
 * this is the one call that can see both it and the ledger.
 *
 * `defaulted` names fields in `options` that a layer above resolved from its own
 * defaults rather than from something the caller asked for. `items.create()`
 * turns an omitted `supply` into `maxSupply: 1`; that is the items API's
 * default, not the game's request, so an item stored with a larger supply is
 * reuse rather than a contradiction. Fields the caller genuinely omitted are
 * simply absent from `options` and are never compared.
 */
export async function issueToken(
  client: KeiClient,
  options: IssueOptions,
  defaulted: readonly IssuanceField[] = [],
): Promise<IssuerToken> {
  if (client.role !== 'issuer') {
    fail(
      'not-issuer-context',
      'Only an issuer can create a token. Use Kei.server() on your game server — a browser must never hold the issuer seed (SPEC §6.3).',
    )
  }
  const symbol = normalizeSymbol(options.symbol)
  const decimals = options.decimals ?? 0
  const existing = await client.node.assetInfo(deriveAssetId(client.publicKey, symbol))
  if (existing) {
    assertIssuanceMatches(existing, options, defaulted)
    return wrapIssuerToken(client, existing, options.rate)
  }

  // The nth asset an account issues burns n Kei (SPEC §5.6.5), so the price of
  // this one depends on how many came before it. The node is the only thing
  // that knows, and the block has to state the burn exactly.
  const issuer = await client.node.accountInfo(client.address)
  const ordinal = (issuer?.issuedCount ?? 0) + 1
  const burn = issuanceBurn(ordinal - 1)
  const balance = await client.balanceRaw()
  if (balance < burn) {
    fail(
      'insufficient-kei',
      `${symbol} is this account's asset number ${ordinal}, which burns ${formatRaw(burn, KEI_DECIMALS)} Kei (SPEC §5.6.5), and it holds ${formatRaw(balance, KEI_DECIMALS)} Kei. Fund ${client.address} first; on testnet call faucet().`,
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
    -burn,
  )

  const info = await client.node.assetInfo(deriveAssetId(client.publicKey, symbol))
  if (!info) fail('issue-failed', `${symbol} was published but cannot be read back. This is a node bug.`)
  return wrapIssuerToken(client, info, options.rate)
}

/**
 * Refuse a re-issue that contradicts the asset already stored at this symbol.
 *
 * Nothing here writes a block, so the refusal costs nothing and changes nothing;
 * it exists so that "you asked for X and the chain says Y" is a sentence rather
 * than a shrug. Every mismatch is reported at once, because a developer whose
 * source has drifted from the chain usually has more than one field to hear
 * about.
 */
function assertIssuanceMatches(
  existing: AssetInfo,
  options: IssueOptions,
  defaulted: readonly IssuanceField[],
): void {
  // A type predicate so each branch below narrows its own option away from
  // `undefined` rather than asserting it.
  const asked = <T>(field: IssuanceField, value: T | undefined): value is T =>
    value !== undefined && !defaulted.includes(field)
  const differs: Array<{ field: IssuanceField; stored: string; wanted: string }> = []
  const note = (field: IssuanceField, stored: string, wanted: string): void => {
    differs.push({ field, stored, wanted })
  }

  if (asked('name', options.name) && options.name !== existing.name) {
    note('name', quoted(existing.name), quoted(options.name))
  }
  if (asked('decimals', options.decimals) && options.decimals !== existing.decimals) {
    note('decimals', String(existing.decimals), String(options.decimals))
  }
  if (asked('maxSupply', options.maxSupply)) {
    // A cap is stated in whole units and stored raw, so the comparison is
    // BigInt: at 18 decimals a `number` cannot even hold the difference. The
    // scale is the caller's own `decimals` when they passed one — that is what
    // their cap means — and otherwise the chain's, because a caller who omitted
    // `decimals` did not ask for zero of them.
    const scale = options.decimals ?? existing.decimals
    const wanted = toRaw(options.maxSupply, scale, 'maxSupply')
    const stored = existing.maxSupply === null ? null : BigInt(existing.maxSupply)
    if (stored === null || stored !== wanted) {
      note(
        'maxSupply',
        stored === null ? 'uncapped' : formatRaw(stored, existing.decimals),
        formatRaw(wanted, scale),
      )
    }
  }
  if (asked('transfer', options.transfer) && options.transfer !== existing.transfer) {
    note('transfer', quoted(existing.transfer), quoted(options.transfer))
  }
  if (asked('swap', options.swap) && options.swap !== existing.swap) {
    note('swap', quoted(existing.swap), quoted(options.swap))
  }
  if (asked('description', options.description) && options.description !== existing.description) {
    note('description', unsetOr(existing.description), quoted(options.description))
  }
  if (asked('image', options.image) && options.image !== existing.image) {
    note('image', unsetOr(existing.image), quoted(options.image))
  }
  if (asked('kind', options.kind) && options.kind !== existing.kind) {
    note('kind', unsetOr(existing.kind), quoted(options.kind))
  }

  if (differs.length === 0) return
  const clauses = differs
    .map((one) => `${one.field} is ${one.stored} and you asked for ${one.wanted}`)
    .join('; ')
  const drop =
    differs.length === 1
      ? `the '${(differs[0] as { field: IssuanceField }).field}' argument`
      : `those arguments (${differs.map((one) => one.field).join(', ')})`
  fail(
    'issuance-mismatch',
    `${existing.symbol} already exists on this account and does not match what you asked for: ${clauses}. Issuance parameters are immutable (SPEC §5.4, §7) — a token's policy and metadata cannot be changed after the fact, and nothing was written just now. Issue this under a new symbol, or drop ${drop} to accept ${existing.symbol} as it stands.`,
  )
}

function quoted(value: string): string {
  return `'${value}'`
}

/** The chain stores no empty metadata, so "absent" and "empty" are one state. */
function unsetOr(value: string | undefined): string {
  return value === undefined ? 'unset' : quoted(value)
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
    async burn(amount) {
      const raw = toRaw(amount, facts.decimals, 'Burn amount')
      if (raw <= 0n) fail('bad-amount', 'Burn amount must be greater than zero.')
      const { hash } = await client.submitAsset({
        kind: 'burn',
        asset: facts.id,
        amount: raw.toString(),
      })
      return { hash, amount: fromRaw(raw, facts.decimals) }
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
