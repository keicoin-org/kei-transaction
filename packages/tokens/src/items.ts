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

import type { AssetId, AssetInfo, KeiClient, TransferPolicy } from '@keicoin/core'
import { assertAddress, blake2b, bytesToHex, deriveAssetId, fail, utf8 } from '@keicoin/core'
import { buildCommit } from '@keicoin/claims'
import type { BuiltCommit } from '@keicoin/claims'

import { MockIpfsUploader, type ImageSource, type IpfsUploader } from './ipfs.js'
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
}

export interface ItemCommitEntry {
  to: string
  item: AssetId
}

export interface IssuerItemsApi {
  create(options: CreateItemOptions): Promise<Item>
  mint(item: AssetId, owner: string): Promise<{ id: AssetId; hash: string; owner: string }>
  /** One issuer block covering a batch of drops (SPEC §5.5). */
  commit(entries: readonly ItemCommitEntry[]): Promise<Array<BuiltCommit & { hash: string }>>
  get(item: AssetId): Promise<Item | null>
  owner(item: AssetId): Promise<string | null>
  ownedBy(address: string): Promise<Item[]>
  token(item: AssetId): Promise<IssuerToken>
}

export interface PlayerItemsApi {
  transfer(item: AssetId, to: string): Promise<{ hash: string; to: string }>
  owner(item: AssetId): Promise<string | null>
  ownedBy(address?: string): Promise<Item[]>
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

function itemFrom(info: AssetInfo): Item {
  return {
    id: info.id,
    name: info.name,
    symbol: info.symbol,
    ...(info.description === undefined ? {} : { description: info.description }),
    ...(info.image === undefined ? {} : { image: info.image }),
    supply: info.maxSupply === null ? null : Number(info.maxSupply),
    transferPolicy: info.transfer,
    issuer: info.issuer,
  }
}

/** Items are tokens; this is how the wallet tells a sword from a currency. */
export function looksLikeItem(info: AssetInfo): boolean {
  if (info.kind === 'item') return true
  if (info.kind === 'token') return false
  return info.decimals === 0 && info.image !== undefined
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

  return {
    async create(create) {
      const symbol = create.symbol ?? itemSymbolFor(create.name)
      const image = create.image === undefined ? undefined : await uploader.upload(create.image)
      const token = await issueToken(client, {
        name: create.name,
        symbol,
        decimals: 0,
        maxSupply: create.supply ?? 1,
        transfer: create.transfer ?? 'open',
        swap: 'off',
        kind: 'item',
        ...(create.description === undefined ? {} : { description: create.description }),
        ...(image === undefined ? {} : { image }),
      })
      // The `kind` hint is metadata, and metadata is written at issuance, so a
      // token that already existed keeps whatever it was created as.
      const info = await client.node.assetInfo(token.id)
      if (!info) fail('issue-failed', `${symbol} was published but cannot be read back.`)
      return itemFrom(info)
    },

    async mint(item, owner) {
      const info = await client.node.assetInfo(item)
      if (!info) fail('no-such-item', `No item with id ${item} exists. Create it first with items.create().`)
      const token = wrapIssuerToken(client, info)
      const { hash } = await token.mint(assertAddress(owner, 'owner address'), 1)
      return { id: info.id, hash, owner }
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

      const published: Array<BuiltCommit & { hash: string }> = []
      for (const [asset, list] of byAsset) {
        const info = await client.node.assetInfo(asset)
        if (!info) fail('no-such-item', `No item with id ${asset} exists.`)
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
    ownedBy: (address) => ownedBy(client, address),

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
    ownedBy: (address) => ownedBy(client, address ?? client.address),
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

async function ownedBy(client: KeiClient, address: string): Promise<Item[]> {
  const holdings = await client.node.holdings(assertAddress(address, 'address'))
  const items: Item[] = []
  for (const holding of holdings) {
    const info = await client.node.assetInfo(holding.asset)
    if (info && looksLikeItem(info)) items.push(itemFrom(info))
  }
  return items
}

export function deriveItemId(issuerPublicKey: string, name: string): AssetId {
  return deriveAssetId(issuerPublicKey, itemSymbolFor(name))
}
