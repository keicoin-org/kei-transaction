/**
 * The book, assembled out of the chains you name.
 *
 * Nothing here is anybody's opinion. It reads `swap_offer` blocks off account
 * chains and sorts them, so a reader with the same list of accounts gets the
 * same answer without asking any server anything — which is the property that
 * makes an index safe to run and useless to lie with.
 *
 * Two things this does that hand-written versions kept getting wrong, and both
 * are the reason it moved in here.
 *
 * **One walk, not two.** "Offers giving the sword" and "offers wanting the
 * sword" are the asks and the bids, and every application so far read them with
 * two `market.offers()` calls, which is two `account_swaps` per account per
 * refresh for a set of blocks the node already returned once. The split is a
 * local partition of one read.
 *
 * **A short answer is not the same as a complete one.** An account whose read
 * failed, an account that hit the per-chain limit, and an account the directory
 * evicted are three different reasons the book is missing something, and all
 * three were previously indistinguishable from "nobody is selling". Coverage is
 * returned alongside the rows so a view can say *this is a floor* rather than
 * imply a census — which is what `carpet-markets` had to say in a comment
 * because the data could not say it. That honesty now rides on every walked
 * read in this package rather than on this one; `Coverage` lives in `walk.ts`.
 */

import type { AssetId, SwapOffer } from '@keicoin/core'
import { KEI_ASSET, fail } from '@keicoin/core'

import type { MarketContext } from './history.js'
import type { AccountSource } from './directory.js'
import type { Offer } from './types.js'
import { assetIdOf } from './util.js'
import {
  DEFAULT_ACCOUNT_LIMIT,
  accountLimitOf,
  mapConcurrent,
  walkAccounts,
  type Coverage,
  type ReadOptions,
} from './walk.js'

/** Offers read per account before the walk gives up on that chain. */
export const DEFAULT_BOOK_LIMIT = DEFAULT_ACCOUNT_LIMIT

export type { Coverage }

export interface Book {
  /** What the book is about, or null when it is every asset against `quote`. */
  asset: AssetId | null
  /** What it is priced in. Kei unless told otherwise. */
  quote: AssetId
  /** Open offers giving `asset` for `quote`. Cheapest per unit first. */
  asks: Offer[]
  /** Open offers giving `quote` for `asset`. Best price for the seller first. */
  bids: Offer[]
  bestAsk: Offer | null
  bestBid: Offer | null
  /** `bestAsk.price - bestBid.price`, or null when either side is empty. */
  spread: number | null
  /** Open offers on the walked chains that are neither, e.g. sword-for-shield. */
  other: Offer[]
  coverage: Coverage
}

export interface BookOptions extends ReadOptions {
  /** Whose chains to read: one address, a list, or a directory (SPEC §9.1). */
  from: AccountSource
  /**
   * The asset the book is about.
   *
   * Leave it out for the whole shelf: every open offer against `quote`, whatever
   * it is selling. That is the query a bazaar asks — "what is anybody selling
   * for gold" — and doing it per asset means one walk per asset.
   */
  asset?: AssetId | { id: AssetId }
  /** What it is priced in. Default Kei. */
  quote?: AssetId | { id: AssetId }
  /** Offers read per account. Default 100. */
  limit?: number
  /** Include offers whose advisory expiry has passed (SPEC §9.3). Default false. */
  includeExpired?: boolean
  /** Include this wallet's own listings. Default true — they are on the shelf. */
  includeMine?: boolean
}

export async function readBook(context: MarketContext, options: BookOptions): Promise<Book> {
  const asset = options.asset === undefined ? null : assetIdOf(options.asset)
  const quote = options.quote === undefined ? KEI_ASSET : assetIdOf(options.quote)
  if (asset === quote) {
    fail(
      'same-asset',
      `A book of ${quote} priced in ${quote} has no two sides to it. Name a different asset, or leave \`asset\` out for every offer against ${quote}.`,
    )
  }
  const limit = accountLimitOf(options.limit, 'book limit')
  const includeExpired = options.includeExpired === true
  const includeMine = options.includeMine !== false

  // One unreachable chain is a gap in the book, not the end of the read. A page
  // that blanks whenever a single node call times out reads as "the market
  // closed", which is the one thing it is definitely not — so the walk collects
  // failures rather than throwing them, and reports them below.
  const walk = await walkAccounts(
    options.from,
    async (account) => {
      const raws = await context.client.node.accountSwaps(account, { limit, state: 'open' })
      return { rows: raws, truncated: raws.length >= limit }
    },
    { signal: options.signal, concurrency: options.concurrency, what: 'Reading the book' },
  )

  // Sorting the raw blocks into sides is arithmetic on strings, so it happens
  // before anything is converted: an offer naming neither side of this book
  // belongs to some other one, and a walk that returns it is a walk nobody can
  // use. Converting costs an asset-metadata read, so it only runs on survivors.
  const sorted: { raw: SwapOffer; side: Side }[] = []
  const seen = new Set<string>()
  for (const raw of walk.rows) {
    if (seen.has(raw.hash)) continue
    seen.add(raw.hash)
    const sells = asset === null ? raw.asset === quote : raw.asset === asset && raw.wantAsset === quote
    const buys = asset === null ? raw.wantAsset === quote : raw.wantAsset === asset && raw.asset === quote
    if (!sells && !buys && asset !== null && raw.asset !== asset && raw.wantAsset !== asset) continue
    if (!sells && !buys && asset === null) continue
    sorted.push({ raw, side: sells ? 'ask' : buys ? 'bid' : 'other' })
  }

  const converted = await mapConcurrent(
    sorted,
    async (entry) => ({ side: entry.side, offer: await context.toOffer(entry.raw) }),
    { signal: options.signal, concurrency: options.concurrency, what: 'Reading the book' },
  )

  const asks: Offer[] = []
  const bids: Offer[] = []
  const other: Offer[] = []
  for (const { side, offer } of converted) {
    if (offer.expired && !includeExpired) continue
    if (offer.mine && !includeMine) continue
    if (side === 'ask') asks.push(offer)
    else if (side === 'bid') bids.push(offer)
    else other.push(offer)
  }

  // Cheapest per unit first, which is the order a buyer wants and the one
  // nothing else is going to impose — there is no matching engine here and
  // there is not going to be one (SPEC §9.4).
  //
  // Ascending on both sides, for two different reasons that happen to agree. An
  // ask's `price` is quote per unit, so smallest is cheapest. A bid gives quote
  // and wants the asset, so its `price` is asset units per quote unit, and the
  // bid paying *most* is the one with the smallest number.
  asks.sort((a, b) => a.price - b.price || a.hash.localeCompare(b.hash))
  bids.sort((a, b) => a.price - b.price || a.hash.localeCompare(b.hash))
  other.sort((a, b) => a.hash.localeCompare(b.hash))

  const bestAsk = asks[0] ?? null
  const bestBid = bids[0] ?? null

  return {
    asset,
    quote,
    asks,
    bids,
    bestAsk,
    bestBid,
    // A spread compares two sides of one asset. A whole-shelf book has as many
    // assets as it has stalls, so there is nothing to subtract and saying so is
    // better than subtracting two unrelated numbers.
    spread: asset !== null && bestAsk && bestBid ? bestAsk.price - bidPrice(bestBid) : null,
    other,
    coverage: walk.coverage,
  }
}

type Side = 'ask' | 'bid' | 'other'

/**
 * What a bid is worth per unit of the asset, in quote units.
 *
 * A bid gives quote and wants the asset, so its `price` is the wrong way up for
 * comparing against an ask. Every application that has drawn a book got this
 * right by hand and none of them enjoyed it.
 */
export function bidPrice(offer: Offer): number {
  return offer.want.amount === 0 ? 0 : offer.give.amount / offer.want.amount
}
