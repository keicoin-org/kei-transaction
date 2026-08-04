/**
 * The refusals this package makes, as a type.
 *
 * Every one of them is already a sentence that states its own fix (SPEC §6.1),
 * and that sentence is what a human or an agent reads. The code is for the other
 * caller: a trade screen that has to tell "somebody else bought it" (retry with
 * another listing) apart from "you cannot afford it" (say so before the click)
 * apart from "the chain says something different from your screen" (refresh and
 * do not sign). Those are three different buttons, and matching on `error.code`
 * is how a view picks one without reading English.
 *
 * `isRace` in `lifecycle.ts` is the shorthand for the pair that means "somebody
 * got there first", and it remains the one most applications need.
 */

import { KeiError } from '@keicoin/core'

/**
 * Every `code` originated by the `@keicoin/market` layer.
 *
 * Listed rather than derived, because a caller switching on it wants the set to
 * be a promise rather than a description of today's implementation. Codes are
 * added over time; none is removed or repurposed. A market call can also surface
 * downstream core, node, or transport errors; `isMarketError` intentionally
 * returns false for those codes.
 */
export type MarketErrorCode =
  /** The `asset` given is not an id and is not an object with one. */
  | 'bad-asset'
  /** Nothing on this network has that asset id. */
  | 'no-such-asset'
  /** An amount or a price that is not a positive number. */
  | 'bad-amount'
  /** `expiresIn` and `expiresAt` together, or an `expiresAt` that is not a time. */
  | 'bad-expiry'
  /** A window or interval that is not `'7d'`-shaped and not a count of ms. */
  | 'bad-duration'
  /** `concurrency` outside the supported integer range. */
  | 'bad-concurrency'
  /** A background expiry retry interval that a JavaScript timer cannot represent safely. */
  | 'bad-sweep-interval'
  /** A per-account read limit that is not a positive safe integer. */
  | 'bad-limit'
  /** `offer()` without both legs, or an offer argument with no hash in it. */
  | 'bad-offer'
  /** This wallet cannot put the units behind the block. The message names the gap. */
  | 'insufficient-balance'
  /** A read that walks chains was given no `from`, or a `from` with nothing in it. */
  | 'no-accounts'
  /** A book of an asset priced in itself, which has no two sides. */
  | 'same-asset'
  /** No offer with that hash on this network. */
  | 'no-such-offer'
  /** Accepted already. Somebody else got it — pick another listing (SPEC §9.2). */
  | 'offer-taken'
  /** Cancelled by its author, who has their asset back (SPEC §9.2). */
  | 'offer-cancelled'
  /** Reserved for a different address (SPEC §9.2). */
  | 'not-the-counterparty'
  /** Only an offer's author can cancel it — nobody else's asset is locked. */
  | 'not-your-offer'
  /** An offer reserved for this wallet's own address, which nothing could settle. */
  | 'self-swap'
  /** This wallet's own offer. `cancel()` is the thing being reached for. */
  | 'self-accept'
  /** The chain is not the trade the screen rendered. Nothing was signed (SPEC §9.4). */
  | 'offer-changed'
  /** The offer block landed and cannot be read back. A node bug, not a caller one. */
  | 'offer-failed'
  /** The read was stopped through its `signal`. Nothing was signed. */
  | 'read-aborted'

const CODES = new Set<string>([
  'bad-asset',
  'no-such-asset',
  'bad-amount',
  'bad-expiry',
  'bad-duration',
  'bad-concurrency',
  'bad-sweep-interval',
  'bad-limit',
  'bad-offer',
  'insufficient-balance',
  'no-accounts',
  'same-asset',
  'no-such-offer',
  'offer-taken',
  'offer-cancelled',
  'not-the-counterparty',
  'not-your-offer',
  'self-swap',
  'self-accept',
  'offer-changed',
  'offer-failed',
  'read-aborted',
])

/**
 * Narrow an unknown catch to a market refusal, optionally to specific ones.
 *
 * ```js
 * if (isMarketError(error, 'offer-taken', 'offer-cancelled')) showNextListing()
 * ```
 */
export function isMarketError(
  error: unknown,
  ...codes: readonly MarketErrorCode[]
): error is KeiError & { code: MarketErrorCode } {
  if (!(error instanceof KeiError) || !CODES.has(error.code)) return false
  return codes.length === 0 || (codes as readonly string[]).includes(error.code)
}
