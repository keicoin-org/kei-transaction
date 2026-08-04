/**
 * What became of a listing, and whether the one on screen is the one on chain.
 *
 * Two problems, and every application that has drawn a market has hit both.
 *
 * **A listing on a screen is a photograph.** Between the read that drew it and
 * the click that takes it, the offer can be accepted by somebody else, cancelled
 * by its author, or pass its advisory expiry — and the first two mean the block
 * a buyer is about to sign is invalid, while the third means nothing at all
 * (SPEC §9.3: an expired offer still settles if somebody accepts it). Those are
 * different sentences and applications kept collapsing them into "gone".
 *
 * **An index is not an authority.** A hall, a registry, or any other list of
 * where-to-look can attach the hash of one item to the price and title of
 * another, and a wallet that signs the hash it was handed pays for the wrong
 * thing at the right price. `world-of-wonder` wrote a bespoke
 * `offerMatchesDisplay` for exactly this and its comment is the correct one:
 * matching the price and quantity is not sufficient. So the check is here, it
 * covers every field of both legs, and `market.accept(offer, { expect })` runs
 * it against the chain immediately before signing.
 */

import type { AssetId } from '@keicoin/core'
import { KeiError, fail } from '@keicoin/core'

import type { MarketContext } from './history.js'
import type { Offer } from './types.js'
import { assetIdOf } from './util.js'

/**
 * A listing's state in the terms a view needs, rather than the ledger's.
 *
 * `stale` is the one worth reading twice: it is open, settleable, and past an
 * expiry the chain never agreed to. Hiding it is a client's choice and the
 * SDK's background sweep is what actually removes it (SPEC §9.3).
 */
export type OfferLife =
  /** Open, unreserved or reserved for the viewer, and not past its expiry. */
  | 'live'
  /** Open and reserved for somebody else, so this wallet's accept would be refused. */
  | 'reserved'
  /** Open and past its advisory expiry. Still settles if anybody accepts it. */
  | 'stale'
  /** Settled. Somebody else got it. */
  | 'taken'
  /** The author took it back, and their asset with it. */
  | 'cancelled'

export interface LifeOptions {
  /** The wallet looking. Defaults to the market's own client. */
  viewer?: string
  now?: () => number
}

export function classify(offer: Offer, options: LifeOptions = {}): OfferLife {
  if (offer.state === 'accepted') return 'taken'
  if (offer.state === 'cancelled') return 'cancelled'
  const viewer = options.viewer
  if (offer.to !== null && viewer !== undefined && offer.to !== viewer && offer.from !== viewer) {
    return 'reserved'
  }
  const now = options.now
  const expired = now === undefined ? offer.expired : offer.expiresAt !== null && offer.expiresAt <= now()
  return expired ? 'stale' : 'live'
}

/** Whether a life state means an accept block would be refused by the ledger. */
export function settleable(life: OfferLife): boolean {
  return life === 'live' || life === 'stale'
}

/**
 * The terms a buyer was shown.
 *
 * Every field is optional and every field given is checked. Give the ones your
 * view actually rendered: an expectation that names only the price is a check
 * that only catches a repricing.
 */
export interface Expectation {
  hash?: string
  seller?: string
  /** What the buyer expects to receive. */
  give?: { asset?: AssetId | { id: AssetId }; amount?: number }
  /** What the buyer expects to pay. */
  want?: { asset?: AssetId | { id: AssetId }; amount?: number }
  /** The address the listing was reserved for, or null for an open one. */
  to?: string | null
}

export interface Verification {
  ok: boolean
  /** One sentence per field that differs, naming both values. */
  mismatches: readonly string[]
}

export function verify(offer: Offer, expected: Expectation): Verification {
  const mismatches: string[] = []
  const differs = (label: string, shown: unknown, actual: unknown): void => {
    if (shown === undefined) return
    if (shown !== actual) mismatches.push(`${label} was shown as ${String(shown)} and the chain says ${String(actual)}`)
  }

  differs('the offer hash', expected.hash?.toUpperCase(), offer.hash)
  differs('the seller', expected.seller, offer.from)
  differs('the reserved buyer', expected.to, offer.to)
  differs('what you receive', legAsset(expected.give), offer.give.asset)
  differs('how many you receive', expected.give?.amount, offer.give.amount)
  differs('what you pay with', legAsset(expected.want), offer.want.asset)
  differs('how much you pay', expected.want?.amount, offer.want.amount)

  return { ok: mismatches.length === 0, mismatches }
}

/** `verify`, as a refusal with a sentence somebody can act on. */
export function assertMatches(offer: Offer, expected: Expectation): void {
  const result = verify(offer, expected)
  if (result.ok) return
  fail(
    'offer-changed',
    `Offer ${offer.hash} is not the trade that was shown to you: ${result.mismatches.join('; ')}. An index is a list of where to look and never an authority (SPEC §9.4), so this wallet signs the ledger's numbers and refuses anybody else's. Refresh the listing and look again.`,
  )
}

/** One listing's before and after, when a re-read found it had moved on. */
export interface Change {
  hash: string
  was: OfferLife | null
  now: OfferLife
  offer: Offer
}

export interface Reconciliation {
  /** Still open and still takeable by the viewer. */
  live: Offer[]
  /** Open, past its advisory expiry, and still settleable (SPEC §9.3). */
  stale: Offer[]
  /** Settled or cancelled since the snapshot, with a sentence for each. */
  gone: readonly { hash: string; life: OfferLife; reason: string }[]
  /** Anything whose state differs from what was passed in. */
  changed: readonly Change[]
  /** Hashes the node has never heard of. A typo, or a different network. */
  unknown: readonly string[]
}

/**
 * Re-read a snapshot of listings and say what actually happened to them.
 *
 * This is the poll a market view runs on a timer, and doing it by hand is where
 * "somebody bought it three seconds ago" turns into a failed accept block. It
 * reads one offer per hash — cheap, and the only correct way, since an offer's
 * state lives in the lock it created rather than in any one chain's history.
 */
export async function reconcileOffers(
  context: MarketContext,
  snapshot: Iterable<string | Offer>,
  options: LifeOptions = {},
): Promise<Reconciliation> {
  const viewer = options.viewer ?? context.client.address
  const life = (offer: Offer): OfferLife =>
    classify(offer, { viewer, ...(options.now ? { now: options.now } : { now: context.now }) })

  const live: Offer[] = []
  const stale: Offer[] = []
  const gone: { hash: string; life: OfferLife; reason: string }[] = []
  const changed: Change[] = []
  const unknown: string[] = []

  for (const entry of snapshot) {
    const hash = (typeof entry === 'string' ? entry : entry?.hash)?.toUpperCase()
    if (!hash) continue
    const raw = await context.client.node.swapOffer(hash)
    if (!raw) {
      unknown.push(hash)
      continue
    }
    const offer = await context.toOffer(raw)
    const now = life(offer)
    const was = typeof entry === 'string' ? null : life(entry)
    if (was !== now) changed.push({ hash, was, now, offer })

    switch (now) {
      case 'live':
      case 'reserved':
        live.push(offer)
        break
      case 'stale':
        stale.push(offer)
        break
      case 'taken':
        gone.push({
          hash,
          life: now,
          reason: `${offer.give.amount} ${offer.give.symbol} for ${offer.want.amount} ${offer.want.symbol} was accepted by ${String(offer.acceptedBy)}. An offer settles exactly once (SPEC §9.2).`,
        })
        break
      default:
        gone.push({
          hash,
          life: now,
          reason: `${offer.from} cancelled this listing, so the ${offer.give.symbol} is back in their wallet.`,
        })
    }
  }

  return { live, stale, gone, changed, unknown }
}

/** True for the two refusals that mean "somebody else got there first". */
export function isRace(error: unknown): boolean {
  return error instanceof KeiError && (error.code === 'offer-taken' || error.code === 'offer-cancelled')
}

function legAsset(leg: Expectation['give']): AssetId | undefined {
  return leg?.asset === undefined ? undefined : assetIdOf(leg.asset)
}

/** Named so a caller can build an `Expectation` straight off what it rendered. */
export function expectationFrom(offer: Pick<Offer, 'hash' | 'from' | 'give' | 'want' | 'to'>): Expectation {
  return {
    hash: offer.hash,
    seller: offer.from,
    give: { asset: offer.give.asset, amount: offer.give.amount },
    want: { asset: offer.want.asset, amount: offer.want.amount },
    to: offer.to,
  }
}
