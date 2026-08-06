/**
 * Items.
 *
 * SPEC §7 — settled: an item *is* a native token with supply 1 and 0 decimals.
 * There is no item block type, no meta-protocol, and no indexer: ownership is
 * `balanceOf`, and item transfer is token transfer down the same code path.
 *
 * The only thing this file adds over `tokens.ts` is naming: a symbol derived
 * from the item's name, so `items.create()` is idempotent per (issuer, name) for
 * the same reason `token.issue()` is idempotent per (issuer, symbol).
 */

import type { AssetId, AssetInfo, AssetRecord, KeiClient, TransferPolicy } from '@keicoin/core'
import {
  MAX_ASSETS_PER_ACCOUNT,
  assertAddress,
  assetCacheFor,
  blake2b,
  bytesToHex,
  deriveAssetId,
  fail,
  utf8,
} from '@keicoin/core'
import { assertCommitHeadroom, buildCommit } from '@keicoin/claims'
import type { BuiltCommit } from '@keicoin/claims'

import { MockIpfsUploader, type ImageSource, type IpfsUploader } from './ipfs.js'
import {
  decodeDescription,
  encodeDescription,
  hasStats,
  statSymbolFor,
  type ItemStats,
} from './stats.js'
import { issueToken, wrapIssuerToken, type IssuerToken } from './tokens.js'

export interface CreateItemOptions {
  name: string
  description?: string
  image?: ImageSource
  /** Omit for a unique item. */
  supply?: number
  transfer?: TransferPolicy
  /** Override the symbol derived from the name. */
  symbol?: string
  /**
   * Attack, weight, rarity — whatever the game reads. Part of the item's
   * identity: the same name with different stats is a different item, because
   * issuance metadata is immutable and an edit would silently be a no-op.
   */
  stats?: ItemStats
}

/** Stats to mint with, and what else the variant overrides on the base item. */
export interface MintItemOptions {
  /** Merged over the base item's stats. */
  stats: ItemStats
  /** Names the variant — 'Flaming' gives "Flaming Iron Sword". */
  label?: string
  /** Defaults to the base item's. */
  name?: string
  description?: string
  image?: ImageSource
  /** Defaults to the base item's, so a soulbound base stays soulbound. */
  transfer?: TransferPolicy
  /**
   * How many players can hold this roll. Defaults to the base item's, so a
   * unique sword rolls unique variants. Fixed at the roll's first issuance,
   * because issuance metadata is immutable — passing a different one for a roll
   * that already exists is refused rather than ignored.
   */
  supply?: number
}

export interface Item {
  id: AssetId
  name: string
  symbol: string
  description?: string
  image?: string
  supply: number | null
  /** Matches `TokenFacts.transferPolicy`: 'none' is a soulbound item (SPEC §5.4). */
  transferPolicy: TransferPolicy
  issuer: string
  /** Absent when the item carries none. Never partially decoded. */
  stats?: ItemStats
}

export interface ItemCommitEntry {
  to: string
  item: AssetId
}

export interface MintedItem {
  id: AssetId
  hash: string
  owner: string
  /** The stats the owner actually received, base and roll merged. */
  stats?: ItemStats
}

export interface OwnedByOptions {
  /**
   * How many of the account's holdings to look at, newest-listed order being
   * the node's own. It caps the metadata fan-out, not the number of items
   * returned: whether a holding is an item is only knowable from its metadata,
   * so `limit: 20` reads twenty holdings and returns however many of them are
   * items. A whole number from 1 through 1,024 (SPEC §7's per-account cap).
   *
   * The node's `account_holdings` takes no count (`docs/rpc.md`), so the
   * holdings themselves still arrive in one response; this bounds the lookups
   * that follow, which is where the round trips are.
   */
  limit?: number
}

export interface IssuerItemsApi {
  create(options: CreateItemOptions): Promise<Item>
  /**
   * Mint one unit to an owner. Pass `stats` and the owner gets a variant of
   * `item` carrying them, so the returned `id` is the variant's, not `item`'s.
   */
  mint(item: AssetId, owner: string, options?: MintItemOptions): Promise<MintedItem>
  /** One issuer block covering a batch of drops (SPEC §5.5). */
  commit(entries: readonly ItemCommitEntry[]): Promise<Array<BuiltCommit & { hash: string }>>
  get(item: AssetId): Promise<Item | null>
  owner(item: AssetId): Promise<string | null>
  ownedBy(address: string, options?: OwnedByOptions): Promise<Item[]>
  token(item: AssetId): Promise<IssuerToken>
}

export interface PlayerItemsApi {
  transfer(item: AssetId, to: string): Promise<{ hash: string; to: string }>
  owner(item: AssetId): Promise<string | null>
  ownedBy(address?: string, options?: OwnedByOptions): Promise<Item[]>
  get(item: AssetId): Promise<Item | null>
}

/**
 * A symbol from a name: slug, truncated, plus a short digest of the full name so
 * two long names that share a prefix do not collide into one asset id.
 */
export function itemSymbolFor(name: string): string {
  const text = String(name ?? '').trim()
  if (text === '') fail('bad-name', 'An item needs a name — that is what its symbol is derived from.')
  const slug = text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 12)
    .replace(/-+$/g, '')
  const digest = bytesToHex(blake2b(utf8(text), 2))
  return `${slug === '' ? 'ITEM' : slug}-${digest}`
}

function itemFrom(info: AssetRecord): Item {
  // The chain has one description field; stats share it (stats.ts). Callers see
  // the two things separately, and `description` stays prose.
  const { description, stats } = decodeDescription(info.description)
  return {
    id: info.id,
    name: info.name,
    symbol: info.symbol,
    ...(description === undefined ? {} : { description }),
    ...(info.image === undefined ? {} : { image: info.image }),
    supply: info.maxSupply === null ? null : Number(info.maxSupply),
    transferPolicy: info.transfer,
    issuer: info.issuer,
    ...(stats === undefined ? {} : { stats }),
  }
}

/** Items are tokens; this is how the wallet tells a sword from a currency. */
export function looksLikeItem(info: AssetRecord): boolean {
  if (info.kind === 'item') return true
  if (info.kind === 'token') return false
  return info.decimals === 0 && info.image !== undefined
}

/**
 * One entry per player per item, because a root holds one leaf per account
 * (SPEC §5.5). `buildCommit` would merge the repeat into an entitlement for two
 * units of a one-unit item, which nobody could claim; repeating a recipient is
 * far likelier to be a batch assembled twice than a request for two swords.
 */
function assertOneLeafPerRecipient(info: AssetInfo, list: readonly { to: string }[]): void {
  const seen = new Set<string>()
  for (const entry of list) {
    if (seen.has(entry.to)) {
      fail(
        'duplicate-recipient',
        `${entry.to} appears twice for ${info.name} in this loot commit, and a root commits to at most one entitlement per account (SPEC §5.5) — the repeat would be merged into the first entry, committing two units to one leaf instead of dropping the item twice. List them once here and again in the next commit.`,
      )
    }
    seen.add(entry.to)
  }
}

export interface ItemsOptions {
  uploader?: IpfsUploader
}

export function createIssuerItems(client: KeiClient, options: ItemsOptions = {}): IssuerItemsApi {
  const uploader = options.uploader ?? new MockIpfsUploader()

  const readItem = async (item: AssetId): Promise<Item | null> => {
    const info = await client.node.assetInfo(item)
    return info ? itemFrom(info) : null
  }

  /**
   * A stat-bearing variant of a base item, as its own asset.
   *
   * It has to be its own asset. Issuance metadata is immutable (SPEC §7), so
   * "the same sword but with these stats" cannot be an edit — and per-holder
   * stats on one shared asset would be exactly the off-consensus interpretation
   * layer §5.2 forks to avoid. The variant is what the player holds.
   *
   * That costs Kei: the nth asset an account issues burns n Kei (SPEC §5.6.5).
   * What keeps it affordable is that the id derives from the stats, so the
   * hundredth Flaming Sword reuses the first one's asset and burns nothing. A
   * bounded table of rolls is cheap; a fresh random roll per drop is a new asset
   * every time and gets expensive fast.
   *
   * Reusing that asset only helps if it has room, so the variant is as plentiful
   * as the base item unless told otherwise: a unique sword rolls unique
   * variants, and a sword issued with `supply: 100` rolls variants a hundred
   * players can hold. Supply is fixed at the roll's *first* issuance, because
   * issuance metadata is immutable — passing a bigger `supply` for a roll that
   * already exists cannot raise it, and is refused rather than ignored.
   */
  const variantOf = async (item: AssetId, options: MintItemOptions): Promise<Item> => {
    const base = await readItem(item)
    if (!base) {
      fail('no-such-item', `No item with id ${item} exists. Create it first with items.create().`)
    }
    const stats = { ...base.stats, ...options.stats }
    if (!hasStats(stats)) {
      fail(
        'no-stats',
        `items.mint() was given an empty stats object for ${base.name}, which says nothing. Pass { stats: { attack: 12 } }, or drop the argument to mint the base item as it is.`,
      )
    }
    const name = options.name ?? (options.label ? `${options.label} ${base.name}` : base.name)
    const image = options.image === undefined ? base.image : await uploader.upload(options.image)
    const description = encodeDescription(options.description ?? base.description, stats)
    // `null` is the base being uncapped, which the variant inherits as uncapped.
    const supply = options.supply ?? base.supply

    // Scoped to the base id, so a variant of this sword is never the same asset
    // as an identically statted variant of some other item.
    //
    // Whatever this resolved from the base item rather than from the caller is
    // declared defaulted: a roll that already exists is reused, and inheriting
    // the base's supply or policy is not a contradiction of the stored roll. An
    // explicit `supply` or `transfer` that disagrees with it is, and now gets a
    // sentence instead of a silent no-op.
    const token = await issueToken(
      client,
      {
        name,
        symbol: statSymbolFor(name, stats, base.id),
        decimals: 0,
        ...(supply === null ? {} : { maxSupply: supply }),
        transfer: options.transfer ?? base.transferPolicy,
        swap: 'off',
        kind: 'item',
        ...(description === undefined ? {} : { description }),
        ...(image === undefined ? {} : { image }),
      },
      [
        ...(options.supply === undefined ? (['maxSupply'] as const) : []),
        ...(options.transfer === undefined ? (['transfer'] as const) : []),
        ...(options.description === undefined ? (['description'] as const) : []),
        ...(options.image === undefined ? (['image'] as const) : []),
      ],
    )
    const info = await client.node.assetInfo(token.id)
    if (!info) fail('issue-failed', `${name} was published but cannot be read back.`)
    return itemFrom(info)
  }

  return {
    async create(create) {
      // Stats are part of the identity, so `create` stays idempotent per
      // (issuer, name) for a plain item and per (issuer, name, stats) for a
      // stat-bearing one. Deriving the symbol from the name alone would make
      // re-creating with new stats silently return the old stats, because
      // issuance metadata is immutable.
      const symbol =
        create.symbol ??
        (hasStats(create.stats) ? statSymbolFor(create.name, create.stats) : itemSymbolFor(create.name))
      const image = create.image === undefined ? undefined : await uploader.upload(create.image)
      const description = encodeDescription(create.description, create.stats)
      // `supply` and `transfer` are this API's defaults when omitted, not the
      // game's request, so an item already stored with a larger supply or a
      // tighter policy is reused rather than refused. Everything the caller did
      // pass — and `decimals`, `swap` and `kind`, which are what an item *is*
      // (SPEC §7) — is compared, so landing on some other asset at this symbol
      // is a refusal rather than the wrong sword.
      const token = await issueToken(
        client,
        {
          name: create.name,
          symbol,
          decimals: 0,
          maxSupply: create.supply ?? 1,
          transfer: create.transfer ?? 'open',
          swap: 'off',
          kind: 'item',
          ...(description === undefined ? {} : { description }),
          ...(image === undefined ? {} : { image }),
        },
        [
          ...(create.supply === undefined ? (['maxSupply'] as const) : []),
          ...(create.transfer === undefined ? (['transfer'] as const) : []),
        ],
      )
      // The `kind` hint is metadata, and metadata is written at issuance, so a
      // token that already existed keeps whatever it was created as.
      const info = await client.node.assetInfo(token.id)
      if (!info) fail('issue-failed', `${symbol} was published but cannot be read back.`)
      return itemFrom(info)
    },

    async mint(item, owner, options) {
      // With stats, the player is minted a variant of the item rather than the
      // item, so the id they end up holding is the variant's.
      const target = options === undefined ? item : (await variantOf(item, options)).id
      const info = await client.node.assetInfo(target)
      if (!info) {
        fail('no-such-item', `No item with id ${target} exists. Create it first with items.create().`)
      }
      // An item that runs out reports itself as an ordinary token over its max
      // supply, and that error's advice — burn some first — is the wrong fix
      // here. It is true (SPEC §5.6.6) and it means destroying the copy a player
      // already owns. An item is scarce because it is meant to be, so the fix is
      // always another asset rather than headroom in this one.
      if (info.maxSupply !== null && BigInt(info.circulating) >= BigInt(info.maxSupply)) {
        fail(
          options === undefined ? 'item-exhausted' : 'roll-exhausted',
          options === undefined
            ? `Every ${info.name} that can exist is already held: this item was issued with a supply of ${info.maxSupply}. Do not burn one to make room — that destroys the copy its owner holds. Issuance is permanent and its parameters immutable (SPEC §5.3), so re-creating it with a larger { supply } is a no-op: give the next one a name of its own, or move this one with items.transfer().`
            : `Every ${info.name} that can exist is already held: this roll has a supply of ${info.maxSupply}, inherited from the base item. A roll that exists keeps the supply it was issued with — issuance metadata is immutable, so passing a larger { supply } for this one is refused rather than applied. Give the base item a larger supply before its rolls are issued, or roll different stats, which is a different asset with its own supply.`,
        )
      }
      const token = wrapIssuerToken(client, info)
      const { hash } = await token.mint(assertAddress(owner, 'owner address'), 1)
      const { stats } = decodeDescription(info.description)
      return { id: info.id, hash, owner, ...(stats === undefined ? {} : { stats }) }
    },

    async commit(entries) {
      if (!Array.isArray(entries) || entries.length === 0) {
        fail('empty-commit', 'A loot commit needs at least one entry. Pass [{ to, item }, ...].')
      }
      // One root per asset: a root pays out one asset, and one leaf per account.
      const byAsset = new Map<AssetId, Array<{ to: string; amount: number }>>()
      for (const entry of entries) {
        const asset = String(entry?.item ?? '').toUpperCase()
        if (asset === '') fail('bad-commit', 'Every loot entry needs an item id.')
        const list = byAsset.get(asset) ?? []
        list.push({ to: assertAddress(entry.to, 'recipient address'), amount: 1 })
        byAsset.set(asset, list)
      }

      // Every asset is checked before any root is signed. A commit is a settled
      // block that cannot be taken back, so a batch refused on its second item
      // must not leave the first standing and claimable.
      for (const [asset, list] of byAsset) {
        const info = await client.node.assetInfo(asset)
        if (!info) fail('no-such-item', `No item with id ${asset} exists.`)
        assertOneLeafPerRecipient(info, list)
        assertCommitHeadroom({
          batch: 'This loot commit',
          asset: info.name,
          decimals: 0,
          maxSupplyRaw: info.maxSupply === null ? null : BigInt(info.maxSupply),
          circulatingRaw: BigInt(info.circulating),
          committed: BigInt(list.length),
          fixes:
            'Commit fewer winners, split them across separate items, or give the item a larger supply — supply is fixed at issuance, so raising it means creating a new item rather than editing this one.',
        })
      }

      const published: Array<BuiltCommit & { hash: string }> = []
      for (const [asset, list] of byAsset) {
        const built = buildCommit({ asset, decimals: 0, entries: list })
        const { hash } = await client.submitAsset({
          kind: 'commit',
          root: built.root,
          asset,
          count: built.count,
          total: built.total,
        })
        published.push({ ...built, hash })
      }
      return published
    },

    get: readItem,
    owner: (item) => ownerOf(client, item),
    ownedBy: (address, options) => ownedBy(client, address, options),

    async token(item) {
      const info = await client.node.assetInfo(item)
      if (!info) fail('no-such-item', `No item with id ${item} exists.`)
      return wrapIssuerToken(client, info)
    },
  }
}

export function createPlayerItems(client: KeiClient): PlayerItemsApi {
  return {
    async transfer(item, to) {
      const info = await client.node.assetInfo(item)
      if (!info) fail('no-such-item', `No item with id ${item} exists on ${client.node.network}.`)
      const { hash } = await client.submitAsset({
        kind: 'transfer',
        asset: info.id,
        to: assertAddress(to, 'recipient address'),
        amount: '1',
      })
      return { hash, to }
    },
    owner: (item) => ownerOf(client, item),
    ownedBy: (address, options) => ownedBy(client, address ?? client.address, options),
    async get(item) {
      const info = await client.node.assetInfo(item)
      return info ? itemFrom(info) : null
    },
  }
}

/** One entry in the reverse index, for a supply-1 asset (SPEC §7). */
async function ownerOf(client: KeiClient, item: AssetId): Promise<string | null> {
  const holders = await client.node.holders(item, { limit: 2 })
  if (holders.length === 0) return null
  if (holders.length > 1) {
    fail(
      'not-unique',
      `Item ${item} has more than one holder, so it does not have a single owner. It was created with a supply above 1 — use items.token(id).holders() instead.`,
    )
  }
  return (holders[0] as { account: string }).account
}

/**
 * Every item an account holds, in the order the node listed the holdings.
 *
 * The metadata is read through the client's one asset cache
 * (`assetCacheFor`, `@keicoin/core`), which is the same instance
 * `wallet.summary()` uses: bounded fan-out instead of a request per holding,
 * nothing asked twice, and one bound over both packages rather than one each.
 * There is no batch `asset_info` in the node RPC (`docs/rpc.md`) and this does
 * not invent one — the win is `ceil(n / 8)` waves instead of `n`.
 *
 * A holding whose lookup rejects rejects this call. A short inventory is
 * indistinguishable from a smaller one, so a broken request is the caller's to
 * see rather than something to render.
 */
async function ownedBy(
  client: KeiClient,
  address: string,
  options: OwnedByOptions = {},
): Promise<Item[]> {
  const limit = options.limit === undefined ? undefined : assertLimit(options.limit)
  const holdings = await client.node.holdings(assertAddress(address, 'address'))
  const wanted = limit === undefined ? holdings : holdings.slice(0, limit)
  const records = await assetCacheFor(client).resolve(wanted.map((holding) => holding.asset))
  const items: Item[] = []
  for (const holding of wanted) {
    const record = records.get(holding.asset)
    if (record && looksLikeItem(record)) items.push(itemFrom(record))
  }
  return items
}

function assertLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_ASSETS_PER_ACCOUNT) {
    fail(
      'bad-limit',
      `limit must be a whole number from 1 through ${MAX_ASSETS_PER_ACCOUNT}, not ${String(limit)}. There is deliberately no "unlimited" setting.`,
    )
  }
  return limit
}

export function deriveItemId(issuerPublicKey: string, name: string): AssetId {
  return deriveAssetId(issuerPublicKey, itemSymbolFor(name))
}
