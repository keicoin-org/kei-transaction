/**
 * Money that is here, money that is owed, and money that is halfway.
 *
 * A block-lattice has three balances where a bank account has one, and a shop
 * that shows only the first looks broken at exactly the moments somebody is
 * paying attention — right after they do something.
 *
 *   confirmed  Signed for, on this wallet's chain, spendable this instant. The
 *              ledger checks a spend against this and nothing else.
 *   incoming   Sent to this wallet and not yet received by it. Real, owed, and
 *              not spendable: a receivable becomes a balance only when the
 *              holder's own key signs for it (SPEC §5.6.3).
 *   committed  Signed by this wallet a moment ago and not yet read back. Nothing
 *              on the chain disagrees with it; the read simply has not returned.
 *
 * Showing only `confirmed` makes the shop look stuck. Adding the other two into
 * it makes the shop offer money that cannot be spent, and the ledger then refuses
 * with "balance is 0", which reads as a bug in the shop rather than the shop
 * working. So they are carried separately all the way out of the SDK, and only
 * `spendable` is ever allowed near a decision about whether an action can go
 * ahead.
 *
 * `carpet-markets/lib/balance.ts` is this file, written by hand, and the
 * arithmetic below is the same arithmetic — including the rule that credits in
 * flight are never netted off, because money arriving does not fund a spend
 * until it has arrived.
 *
 * Nothing here touches the network. It is arithmetic, so it is tested as
 * arithmetic.
 */

import type { AssetId } from '@keicoin/core'
import { fromRaw } from '@keicoin/core'

/** What one asset looks like right now, in every sense that matters. */
export interface Funds {
  asset: AssetId
  symbol: string
  /** What this world calls it, from the catalogue. Falls back to the asset's name. */
  title: string
  decimals: number

  /** What the chain says can be spent, in decimal units and in raw. */
  confirmed: number
  confirmedRaw: bigint
  /** Owed to this wallet and not yet signed for. */
  incoming: number
  incomingRaw: bigint
  /** How many separate arrivals are waiting, across every asset. */
  arrivals: number
  /** Signed by this wallet and not yet read back. Always a debt, never a credit. */
  committed: number
  committedRaw: bigint

  /** `confirmed - committed`, floored at zero. The only number a spend is checked against. */
  spendable: number
  spendableRaw: bigint
  /** What the balance becomes if everything owed and everything signed lands. */
  projected: number
  projectedRaw: bigint
  /** True while anything is on its way or halfway out. */
  settling: boolean
  /**
   * Whether the chain half of this was actually read.
   *
   * `'failed'` means the node did not answer, so every chain number above is a
   * placeholder and not a fact about this wallet. A view can render that as
   * "balance unavailable" instead of a confident zero, and nothing may state
   * one of these numbers as a reason for refusing to write.
   */
  read: 'ok' | 'failed'
}

/** The chain half: what a read of the node actually returned. */
export interface ChainFunds {
  confirmedRaw: bigint
  incomingRaw: bigint
  arrivals: number
}

export const NO_CHAIN_FUNDS: ChainFunds = { confirmedRaw: 0n, incomingRaw: 0n, arrivals: 0 }

/**
 * One thing this wallet has signed and not yet read back.
 *
 * `moves` is signed and raw, keyed by asset: negative for what leaves. Two
 * actions started in the same second cannot each be checked against the same
 * units, which is the entire reason this is counted as a debt the moment it is
 * signed rather than when it is confirmed.
 */
export interface Pending {
  id: number
  kind: PendingKind
  /** What is happening, in the words a status line would use. */
  what: string
  state: 'signing' | 'settled' | 'failed'
  moves: ReadonlyMap<AssetId, bigint>
  /** The block this wrote, once it has one. */
  hash: string | null
  startedAt: number
  /** Present when `state` is 'failed'. Already a sentence stating its own fix. */
  error?: string
}

export type PendingKind = 'list' | 'cancel' | 'buy' | 'gift'

/** Raw units of one asset this wallet has committed and not yet had taken. */
export function committedRaw(pending: Iterable<Pending>, asset: AssetId): bigint {
  let total = 0n
  for (const entry of pending) {
    if (entry.state !== 'signing') continue
    const move = entry.moves.get(asset)
    if (move !== undefined && move < 0n) total -= move
  }
  return total
}

/** Every raw unit in flight, credits included, for the projected balance. */
export function movingRaw(pending: Iterable<Pending>, asset: AssetId): bigint {
  let total = 0n
  for (const entry of pending) {
    if (entry.state !== 'signing') continue
    total += entry.moves.get(asset) ?? 0n
  }
  return total
}

export interface FundsInput {
  asset: AssetId
  symbol: string
  title?: string
  decimals: number
  chain: ChainFunds
  pending: Iterable<Pending>
  /** Defaults to `'ok'`: a caller that read the chain has nothing to declare. */
  read?: 'ok' | 'failed'
}

export function toFunds(input: FundsInput): Funds {
  const { asset, symbol, decimals, chain } = input
  const held = [...input.pending]
  const committed = committedRaw(held, asset)
  const moving = movingRaw(held, asset)

  const spendable = chain.confirmedRaw - committed
  const projected = chain.confirmedRaw + chain.incomingRaw + moving
  const settling = chain.arrivals > 0 || held.some((entry) => entry.state === 'signing')

  const spendableFloored = spendable > 0n ? spendable : 0n
  const projectedFloored = projected > 0n ? projected : 0n

  return {
    asset,
    symbol,
    title: input.title ?? symbol,
    decimals,
    confirmed: fromRaw(chain.confirmedRaw, decimals),
    confirmedRaw: chain.confirmedRaw,
    incoming: fromRaw(chain.incomingRaw, decimals),
    incomingRaw: chain.incomingRaw,
    arrivals: chain.arrivals,
    committed: fromRaw(committed, decimals),
    committedRaw: committed,
    spendable: fromRaw(spendableFloored, decimals),
    spendableRaw: spendableFloored,
    projected: fromRaw(projectedFloored, decimals),
    projectedRaw: projectedFloored,
    settling,
    read: input.read ?? 'ok',
  }
}

/**
 * Whether an amount can be spent now, which is not the same as afterwards.
 *
 * False for a purse whose `read` failed, because an unread balance funds
 * nothing — but false here is "not known to be spendable", so a caller must not
 * turn it into a sentence about what the wallet holds.
 */
export function canSpend(funds: Funds, raw: bigint): boolean {
  return raw > 0n && raw <= funds.spendableRaw
}
