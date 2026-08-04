/**
 * `@keicoin/player-economy` — shops that belong to the players, not the game.
 *
 *   import { createPlayerEconomy } from '@keicoin/player-economy'
 *
 *   const shop = createPlayerEconomy(kei.client, {
 *     currency: gold,
 *     catalogue: [{ key: 'sword', asset: sword.id, title: 'Iron Sword' }],
 *   })
 *
 *   await shop.list({ item: 'sword', each: 120 })    // your stall is open
 *   const shelves = await shop.browse()               // everybody else's
 *   await shop.buy(shelves.listings[0])               // one block, both legs
 *   await shop.gift({ to: friend, item: 'sword' })    // no price, no offer
 *
 * `@keicoin/economy` is the issuer's half — recipes the game declares and
 * stocks from its own account. This is the player's half, and the difference is
 * the whole point: nothing here is stocked, approved, or moveable by the world
 * it is embedded in. Every block is signed by the key in the player's browser
 * (SPEC §6.3), and the world's only job is telling the SDK which chains to read,
 * because Kei ships no indexer and is not going to (SPEC §9.4).
 *
 * It is bundled into `kei-transaction`, so `kei.shop` is already there; this
 * package exists for people who care about bundle size (SPEC §10.1).
 */

export { createPlayerEconomy } from './shop.js'
export type {
  HistoryOptions,
  PlayerEconomyApi,
  PlayerEconomyOptions,
  ShopEvents,
} from './shop.js'

export { createCatalogue } from './catalogue.js'
export type { Catalogue, Ware, WareSpec } from './catalogue.js'

export { NO_CHAIN_FUNDS, canSpend, committedRaw, movingRaw, toFunds } from './funds.js'
export type { ChainFunds, Funds, FundsInput, Pending, PendingKind } from './funds.js'

export type {
  BrowseOptions,
  BuyOptions,
  Currency,
  Gift,
  GiftRequest,
  Listing,
  ListingRequest,
  Purchase,
  Reconciled,
  Shelf,
  Shelves,
} from './types.js'
