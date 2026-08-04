/**
 * What a player's shop speaks.
 *
 * Amounts are plain decimal numbers, like the rest of the public API (SPEC
 * §6.1). Where a number would lose the ledger's precision — a total computed
 * from a per-unit price, a balance compared against a spend — the raw integer
 * travels alongside it rather than instead of it, because a shop that rounds a
 * total is a shop that lists at the wrong price.
 */

import type { AssetId } from '@keicoin/core'
import type { Coverage, Duration, Offer, OfferLife } from '@keicoin/market'

import type { Ware } from './catalogue.js'

/** The asset a shop prices in. Kei unless the world issues its own money. */
export interface Currency {
  asset: AssetId
  symbol: string
  name: string
  decimals: number
}

/**
 * One thing on a shelf: a `swap_offer` block on its seller's own chain.
 *
 * Everything here was read off the chain. `key` and `title` are the only fields
 * that came from the local catalogue, and they name nothing the ledger checks.
 */
export interface Listing {
  /** The offer block's hash, which is its id (SPEC §9.3). */
  hash: string
  seller: string
  /** Written by this wallet, so it can be cancelled and cannot be accepted. */
  mine: boolean
  /** The catalogue key, or the asset id when this world never declared one. */
  key: string
  title: string
  asset: AssetId
  /** How many units the lot holds. */
  qty: number
  /** What the whole lot costs, in the shop's currency. */
  price: number
  /** What one unit costs. `price / qty`, and the number a buyer compares. */
  each: number
  currency: Currency
  /** live | reserved | stale | taken | cancelled — see `@keicoin/market`. */
  life: OfferLife
  /** Only this address may accept it, or null for an open listing (SPEC §9.2). */
  reservedFor: string | null
  /** Advisory, and never enforced by the ledger (SPEC §9.3). */
  expiresAt: number | null
  /** The offer this was read from, for anything this shape leaves out. */
  offer: Offer
}

/** One player's stall: their open listings, in this world's currency. */
export interface Shelf {
  seller: string
  mine: boolean
  listings: Listing[]
}

export interface Shelves {
  /** One per seller with something on offer, most listings first. */
  shelves: Shelf[]
  /** Every listing flat, cheapest per unit first. What a buy button iterates. */
  listings: Listing[]
  /**
   * What the walk could not see: chains that failed, chains that hit their page
   * limit, and accounts a bounded directory evicted. A shop with a roster is
   * always a floor rather than a census, and this is how a view says so.
   */
  coverage: Coverage
}

export interface ListingRequest {
  /** A catalogue key, an asset id, or the item or token object itself. */
  item: string | { id: AssetId }
  /** How many units to put in the lot. Default 1, which is the item case. */
  qty?: number
  /** Price per unit. The usual one. Exactly one of `each` or `price`. */
  each?: number | string
  /** Price for the whole lot. Exactly one of `each` or `price`. */
  price?: number | string
  /** Reserve it for one buyer (SPEC §9.2). */
  to?: string
  /** Advisory expiry. The SDK cancels this wallet's own expired listings. */
  expiresIn?: Duration
}

export interface BrowseOptions {
  /** Only listings of this ware. */
  item?: string | { id: AssetId }
  /** Include this wallet's own stall. Default true. */
  includeMine?: boolean
  /** Include listings past their advisory expiry. Default false (SPEC §9.3). */
  includeExpired?: boolean
  /** Read these accounts instead of the shop's directory. */
  from?: string | readonly string[]
  /** Listings read per chain. Default 100. */
  limit?: number
}

export interface BuyOptions {
  /**
   * Check the chain against the listing that was on screen before signing.
   * Default true, and turning it off is only correct when the caller has
   * already re-read the offer itself.
   */
  verify?: boolean
}

export interface Purchase {
  /** The `swap_accept` block — one block, both legs (SPEC §9.2). */
  hash: string
  listing: Listing
  /** What arrived. */
  received: { asset: AssetId; key: string; title: string; qty: number }
  /** What it cost. */
  paid: { asset: AssetId; symbol: string; amount: number }
}

export interface GiftRequest {
  to: string
  /** Kei. Use this, or `item`, or `asset` + `amount` — exactly one. */
  kei?: number | string
  /** A catalogue key, an asset id, or the item object. Defaults to one unit. */
  item?: string | { id: AssetId }
  /** Any asset by id, when it is not in the catalogue. */
  asset?: AssetId | { id: AssetId }
  /** How many units of `item` or `asset`. Default 1. */
  amount?: number | string
}

/**
 * A gift carries no note.
 *
 * A memo has no wire representation on any block type yet, so a `memo` option
 * here would be a field that always throws — and on an asset transfer there is
 * nowhere to put one even once Kei sends can carry it. The hash a gift returns
 * is exact, which is what a note would have been used to correlate anyway.
 */

export interface Gift {
  hash: string
  to: string
  asset: AssetId
  symbol: string
  /** Named when the catalogue knows it. */
  ware: Ware | null
  amount: number
}

/** What `sync()` found, so a view can redraw from one call. */
export interface Reconciled {
  /** Receivables this wallet signed for during the sync (SPEC §5.6.3). */
  received: number
  /** This wallet's own open listings, as of now. */
  mine: Listing[]
  /** Tracked listings that have since been taken or cancelled, with a sentence each. */
  gone: readonly { hash: string; life: OfferLife; reason: string }[]
  /** Listings past their advisory expiry that the sweep has not cancelled yet. */
  stale: Listing[]
  /** The shop's currency, after everything above. */
  funds: import('./funds.js').Funds
}
