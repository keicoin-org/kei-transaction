/**
 * Price history, read from the chain (SPEC §9.1).
 *
 * There is no time-series database here and there is not going to be one: a
 * settled offer *is* a trade, the offer block is on its author's chain, and the
 * accept block is on the accepter's. So "what did swords go for?" is a bounded
 * walk of the chains you name, and the caveat §9.1 states plainly holds — the
 * useful history has to be concentrated in a few chains, because nothing here
 * sweeps the ledger.
 *
 * The honest limit is time. **The block-lattice has no clock** (SPEC §5.5), so a
 * block carries no timestamp a swap could be ordered by. `settledAt` is the
 * node's own first-seen time, which is what Nano's `local_timestamp` is: good
 * enough to hide last month's listings, never good enough to settle a dispute.
 * Everything derived from chain data alone — the median, the range, the volume,
 * the count — is identical on every node. The window that selects the trades is
 * not, and a restarted node forgets it.
 */

import type { AssetId, KeiClient, SwapOffer } from '@keicoin/core'
import { fromRaw } from '@keicoin/core'

import type { PriceSummary, Trade, TradeOptions } from './types.js'
import { assetIdOf, durationMs } from './util.js'

export interface LegMeta {
  asset: AssetId
  symbol: string
  name: string
  decimals: number
}

export interface MarketContext {
  client: KeiClient
  meta(asset: AssetId): Promise<LegMeta>
  now(): number
}

/** Offers read per account, and blocks scanned for accepts, unless told otherwise. */
const DEFAULT_LIMIT = 100

export async function readTrades(context: MarketContext, options: TradeOptions = {}): Promise<Trade[]> {
  const { client } = context
  const limit = options.limit ?? DEFAULT_LIMIT
  const asset = options.asset === undefined ? undefined : assetIdOf(options.asset)
  const quote = options.quote === undefined ? undefined : assetIdOf(options.quote)

  const found = new Map<string, SwapOffer>()
  const accounts =
    options.from === undefined
      ? [client.address]
      : typeof options.from === 'string'
        ? [options.from]
        : [...options.from]

  for (const account of accounts) {
    for (const raw of await client.node.accountSwaps(account, { limit, state: 'accepted' })) {
      found.set(raw.hash, raw)
    }
  }

  // A trade this wallet was the *buyer* in is an accept block on its own chain
  // and an offer on somebody else's, so it is invisible to the walk above. It is
  // still this wallet's history, and asking for "my trades" should return it.
  if (options.from === undefined) {
    for (const block of await client.node.accountHistory(client.address, { limit })) {
      if (block.type !== 'asset' || block.op.kind !== 'swap_accept') continue
      const raw = await client.node.swapOffer(block.op.offer)
      if (raw && raw.state === 'accepted') found.set(raw.hash, raw)
    }
  }

  const since =
    options.window === undefined ? undefined : context.now() - durationMs(options.window, 'window')

  const matched: SwapOffer[] = []
  for (const raw of found.values()) {
    if (raw.state !== 'accepted') continue
    if (asset !== undefined && raw.asset !== asset && raw.wantAsset !== asset) continue
    if (quote !== undefined && raw.asset !== quote && raw.wantAsset !== quote) continue
    if (since !== undefined && (raw.settledAt === null || raw.settledAt < since)) continue
    matched.push(raw)
  }

  // Newest first, by the node's local clock — the only ordering available across
  // two chains. The hash breaks ties so the answer is at least stable.
  matched.sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0) || a.hash.localeCompare(b.hash))
  const trimmed = options.last === undefined ? matched : matched.slice(0, Math.max(0, options.last))

  const trades: Trade[] = []
  for (const raw of trimmed) {
    const [give, want] = await Promise.all([context.meta(raw.asset), context.meta(raw.wantAsset)])
    const giveAmount = fromRaw(BigInt(raw.amount), give.decimals)
    const wantAmount = fromRaw(BigInt(raw.wantAmount), want.decimals)
    trades.push({
      hash: raw.hash,
      from: raw.from,
      seller: raw.from,
      buyer: String(raw.acceptedBy),
      give: { ...give, amount: giveAmount },
      want: { ...want, amount: wantAmount },
      price: giveAmount === 0 ? 0 : wantAmount / giveAmount,
      to: raw.counterparty,
      expiresAt: raw.expiresAt,
      expired: raw.expiresAt !== null && raw.expiresAt <= context.now(),
      state: 'accepted',
      mine: raw.from === client.address || raw.acceptedBy === client.address,
      acceptedBy: raw.acceptedBy,
      settledBy: raw.settledBy,
      seenAt: raw.seenAt,
      settledAt: raw.settledAt,
    })
  }
  return trades
}

/**
 * The §9.1 query. `null` when the asset has never traded against this quote,
 * because "no price" and "a price of zero" are different answers.
 */
export function summarise(trades: readonly Trade[], asset: AssetId, quote: AssetId): PriceSummary | null {
  const prices: number[] = []
  let volume = 0
  let last: number | undefined

  for (const trade of trades) {
    const sells = trade.give.asset === asset && trade.want.asset === quote
    const buys = trade.want.asset === asset && trade.give.asset === quote
    if (!sells && !buys) continue
    const units = sells ? trade.give.amount : trade.want.amount
    const paid = sells ? trade.want.amount : trade.give.amount
    if (units <= 0) continue
    prices.push(paid / units)
    volume += units
    // `trades` arrives newest first, so the first match is the latest price.
    last ??= paid / units
  }

  if (prices.length === 0 || last === undefined) return null
  const sorted = [...prices].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2

  return {
    asset,
    quote,
    median,
    last,
    low: sorted[0] as number,
    high: sorted[sorted.length - 1] as number,
    trades: prices.length,
    volume,
  }
}
