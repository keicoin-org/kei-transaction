/**
 * What a world deals in.
 *
 * A chain names things with an asset id, and a game names them `'sword'`. Both
 * applications built on `@keicoin/market` wrote the same two maps — key to
 * asset, asset to key — and both had to remember that an offer naming an asset
 * the world does not recognise is not the world's business to display.
 *
 * The catalogue is deliberately not authoritative about anything else. It gives
 * a listing a name and an icon key; it decides nothing about ownership, price,
 * or whether a trade is valid. An asset missing from it still trades perfectly
 * well — it simply comes back as an unnamed listing rather than a sword.
 */

import type { AssetId } from '@keicoin/core'
import { fail } from '@keicoin/core'

export interface Ware {
  /** What the game calls it: `'sword'`. Defaults to the asset id. */
  key: string
  asset: AssetId
  /** What a player reads: `'Sword of Testing'`. Defaults to the key. */
  title: string
}

export type WareSpec = { key?: string; asset: AssetId | { id: AssetId }; title?: string }

export interface Catalogue {
  /** Every ware, in the order it was declared. */
  all(): readonly Ware[]
  byKey(key: string): Ware | undefined
  byAsset(asset: AssetId): Ware | undefined
  /**
   * The asset behind a key, an id, or anything with an `id`.
   *
   * Refuses an unknown key by name and lists what this world does deal in,
   * because "This world does not deal in 'sword'" with no list is a message
   * that sends somebody looking through source for the right spelling.
   */
  assetOf(item: string | { id: AssetId }): AssetId
  /**
   * A ware for an asset, invented from the id when the world never declared one.
   *
   * A catalogue never reads a chain, so the id is the best it can invent — and a
   * 64-hex id is not a title a player can read. Anything holding the asset's
   * facts should fall back to the on-chain `name` first and reach the id only
   * when the chain carries neither name nor symbol; that is what the shop does.
   */
  describe(asset: AssetId): Ware
  add(ware: WareSpec): Ware
}

export function createCatalogue(wares: Iterable<WareSpec> = []): Catalogue {
  const byKey = new Map<string, Ware>()
  const byAsset = new Map<AssetId, Ware>()
  const order: Ware[] = []

  const add = (spec: WareSpec): Ware => {
    const asset = idOf(spec?.asset)
    const key = spec.key ?? asset
    const ware: Ware = { key, asset, title: spec.title ?? key }
    const replacing = byKey.get(key)
    if (replacing) order.splice(order.indexOf(replacing), 1)
    byKey.set(key, ware)
    byAsset.set(asset, ware)
    order.push(ware)
    return ware
  }

  for (const spec of wares) add(spec)

  return {
    all: () => order,
    byKey: (key) => byKey.get(key),
    byAsset: (asset) => byAsset.get(asset),
    add,
    describe: (asset) => byAsset.get(asset) ?? { key: asset, asset, title: asset },
    assetOf(item) {
      if (item !== null && typeof item === 'object') return idOf(item)
      const key = String(item ?? '')
      const known = byKey.get(key)
      if (known) return known.asset
      // An asset id is a hex string and a key is whatever the game chose, so a
      // value that is not in the catalogue and looks like an id is one.
      if (/^[0-9A-F]{16,}$/i.test(key)) return key.toUpperCase()
      const names = order.map((ware) => ware.key)
      fail(
        'no-such-ware',
        names.length === 0
          ? `This shop has no catalogue, so "${key}" names nothing it could list. Pass the asset id instead, or declare the world's wares: Kei.start({ shop: { catalogue: [{ key: '${key}', asset: swordId }] } }).`
          : `This shop does not deal in "${key}". It knows: ${names.join(', ')}. Pass an asset id to trade something it has never heard of.`,
      )
    },
  }
}

function idOf(asset: AssetId | { id: AssetId } | undefined): AssetId {
  const id = typeof asset === 'string' ? asset : asset?.id
  if (typeof id !== 'string' || id === '') {
    fail('bad-asset', 'A ware names an asset: { key: \'sword\', asset: sword.id }. Pass the item or token object itself and its id is read for you.')
  }
  return id.toUpperCase()
}
