/**
 * What things are worth. Shared by both halves on purpose.
 *
 * The server is authoritative about payouts, because it is the only side that
 * can mint. The client has to predict the same numbers to draw them. Two copies
 * of this arithmetic would disagree within an afternoon, so there is one.
 *
 * Nothing here is a balance. Balances live on the chain; this is a price list.
 */

/** Your currency. Rename it here and it is renamed everywhere. */
export const CURRENCY = {
  name: '__CURRENCY_NAME__',
  symbol: '__CURRENCY_SYMBOL__',
  /** Whole units. Raise it if you want fractions. */
  decimals: 0,
  /** Caps circulating supply, not cumulative mints — burning frees headroom. */
  maxSupply: 1_000_000_000,
} as const

/** What one click pays, before anything multiplies it. */
export const PER_CLICK = 1

/**
 * The one thing for sale. It is a real item: a supply-limited native token that
 * lands in the player's wallet and stays there, visible in any other Kei wallet,
 * whether or not this game is running.
 */
export const LANTERN = {
  name: 'Lantern',
  description: 'It lights the crystal, and doubles what a click is worth.',
  /** In Kei, and small on purpose — a card processor cannot take this payment. */
  price: 0.01,
  /** How many can exist across every player. Omit for a one-of-a-kind item. */
  supply: 100_000,
  multiplier: 2,
} as const

export function perClickFor(lanterns: number): number {
  return lanterns > 0 ? PER_CLICK * LANTERN.multiplier : PER_CLICK
}

/** What the server tells the browser on load. Asset ids are derived on-chain. */
export interface Catalogue {
  issuer: string
  network: string
  currency: { asset: string; symbol: string; decimals: number }
  lantern: { asset: string; name: string; description: string; price: number }
}

/**
 * What the browser posts once its payment is on the chain.
 *
 * A Kei payment carries no memo, so the payment cannot say what it was for. Its
 * hash can: it names that one payment and nothing else, and the payer is the
 * only one holding it the moment it is made. Handing it to the game is what
 * turns "somebody paid" into "this player bought a lantern" — out of band,
 * because the block has nowhere to put it.
 */
export interface LanternOrder {
  address: string
  /** The hash `kei.pay()` returned. */
  hash: string
}

/** A refund is an outcome rather than an error: the money moved either way. */
export type LanternOutcome =
  | { outcome: 'delivered'; item: string }
  | { outcome: 'refunded'; amount: number; reason: string }
