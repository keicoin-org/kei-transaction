/**
 * What the market speaks.
 *
 * Amounts here are plain decimal numbers, like everywhere else in the public API
 * (SPEC §6.1): raw units and asset ids belong to the node, not to the developer
 * pricing a sword.
 */

import type { AssetId, SwapState } from '@keicoin/core'

export type OfferState = SwapState

/** One side of a trade, named the way a developer would name it. */
export interface OfferLeg {
  asset: AssetId
  symbol: string
  name: string
  decimals: number
  amount: number
}

export interface Offer {
  /** The `swap_offer` block's hash. It is the offer's id (SPEC §9.3). */
  hash: string
  /** Whoever wrote the offer, and the only party with anything locked. */
  from: string
  /** What is locked and on sale. */
  give: OfferLeg
  /** What the offerer wants for it. */
  want: OfferLeg
  /** `want.amount` per one unit of `give` — the asking price. */
  price: number
  /** Only this address may accept, or null for an open listing. */
  to: string | null
  /**
   * Advisory wall-clock expiry (SPEC §9.3). The ledger never enforces it and
   * cannot: an expired offer still settles if somebody accepts it.
   */
  expiresAt: number | null
  /** True when `expiresAt` has passed. A hint for the view, never a guarantee. */
  expired: boolean
  state: OfferState
  /** Written by this wallet. */
  mine: boolean
  acceptedBy: string | null
  /** The `swap_accept` or `swap_cancel` block that consumed the lock. */
  settledBy: string | null
  /** Node-local first-seen time in ms. Not consensus — see `docs/rpc.md`. */
  seenAt: number
  /** Node-local, and null while the offer is open. */
  settledAt: number | null
}

/** A settled offer: the only kind of price history a chain can have (SPEC §9.1). */
export interface Trade extends Offer {
  state: 'accepted'
  seller: string
  buyer: string
}

export interface Settlement {
  /** The `swap_accept` block — one block, both legs (SPEC §9.2). */
  hash: string
  offer: string
  /** The offerer, who is now owed the payment. */
  from: string
  /** What this wallet received. */
  received: OfferLeg
  /** What this wallet paid. */
  paid: OfferLeg
  price: number
}

export interface Cancellation {
  /** The `swap_cancel` block. */
  hash: string
  offer: string
  /** What came back to the spendable balance. */
  returned: OfferLeg
}

/** A duration in milliseconds, or a string like `'7d'`, `'90m'`, `'12h'`. */
export type Duration = number | string

export interface ExpiryOptions {
  /** Advisory, and the SDK cancels the offer itself when it passes (SPEC §9.3). */
  expiresIn?: Duration
  expiresAt?: number | Date
}

export interface SellOptions extends ExpiryOptions {
  /** What to sell: an asset id, or anything with an `id` — an item works. */
  asset: AssetId | { id: AssetId }
  /** How many units. Default 1, which is the item case. */
  amount?: number | string
  /** The asking price, in Kei. */
  price: number | string
  /** Reserve the listing for one buyer (SPEC §9.2). */
  to?: string
}

export interface BidOptions extends ExpiryOptions {
  /** What to buy. */
  asset: AssetId | { id: AssetId }
  amount?: number | string
  /** What to pay, in Kei. Locked out of this wallet's balance until settled. */
  price: number | string
  to?: string
}

export interface AssetAmount {
  asset: AssetId | { id: AssetId }
  amount: number | string
}

export interface OfferOptions extends ExpiryOptions {
  /** Locked now, and moved only by an accept (SPEC §9.2). */
  give: AssetAmount
  want: AssetAmount
  to?: string
}

export interface ListOptions {
  /**
   * Whose chains to read. Required, and it is the honest shape: an offer lives
   * on its author's chain, so "every listing on the network" is an indexer, and
   * §9.4 says Kei does not provide one.
   */
  from: string | readonly string[]
  /** Only offers giving this asset. */
  asset?: AssetId | { id: AssetId }
  /** Only offers wanting this asset. */
  want?: AssetId | { id: AssetId }
  /** Default 'open'. Pass null for every state. */
  state?: OfferState | null
  /** Show listings whose advisory expiry has passed. Default false. */
  includeExpired?: boolean
  /** Offers read per account. Default 100. */
  limit?: number
}

export interface MineOptions {
  state?: OfferState | null
  includeExpired?: boolean
  limit?: number
}

export interface TradeOptions {
  /** Whose chains to read. Defaults to this wallet's own trades. */
  from?: string | readonly string[]
  /** Only trades in this asset, on either leg. */
  asset?: AssetId | { id: AssetId }
  /** Only trades against this asset. Default Kei. */
  quote?: AssetId | { id: AssetId }
  /** Node-local time window, e.g. `'7d'` — see the caveat on `Trade.settledAt`. */
  window?: Duration
  /** Keep only the most recent n. */
  last?: number
  limit?: number
}

export interface PriceSummary {
  asset: AssetId
  quote: AssetId
  /** Quote units per one unit of `asset`. */
  median: number
  /** The most recently settled trade, by the node's local clock. */
  last: number
  low: number
  high: number
  /** How many trades the numbers are made of. */
  trades: number
  /** Units of `asset` that changed hands. */
  volume: number
}

export interface MarketOptions {
  /**
   * Cancel this wallet's own expired offers in the background (SPEC §9.3).
   * A cancel is the only thing that actually frees the lock and removes the
   * listing from the ledger, so somebody has to write it. Default true.
   */
  autoCancelExpired?: boolean
  /** How long after an expiry to sweep, in ms. Default 30 seconds. */
  sweepInterval?: number
  /** The wallet's clock, for expiry. Replaceable so a test needs no timers. */
  now?: () => number
}
