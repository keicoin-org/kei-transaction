/**
 * Turning what a recipe *says* into what the chain *has*.
 *
 * A recipe is written before the assets exist — that is the whole reason it can
 * be a shared file — so every id, symbol and amount in it is unresolved text
 * until a plan is built. This is where that text meets `assetInfo`, and where a
 * symbol nobody issued becomes a sentence rather than a null.
 */

import type { AssetId, KeiClient, TransferPolicy } from '@keicoin/core'
import {
  KEI_ASSET,
  KEI_DECIMALS,
  KEI_NAME,
  KEI_SYMBOL,
  KeiError,
  assertAddress,
  formatRaw,
  fromRaw,
  isHex,
  toRaw,
} from '@keicoin/core'

import type { AssetRef, Stack } from './recipe.js'

/** One asset, resolved, with the recipe's amount in both the units it speaks. */
export interface ResolvedStack {
  asset: AssetId
  symbol: string
  name: string
  decimals: number
  /** Null for Kei, which nobody issues. */
  issuer: string | null
  /** Kei is 'open'; everything else carries the policy its issuer chose. */
  transferPolicy: TransferPolicy
  /** Uncapped is null. Circulating and cap are raw, because headroom is exact. */
  maxSupplyRaw: bigint | null
  circulatingRaw: bigint
  /** The recipe's amount, as a developer writes it. */
  amount: number
  /** The same amount, exact. Every comparison in this package uses this one. */
  raw: bigint
}

/** Why a stack could not be resolved. Carries the sentence, not a null. */
export class ResolveFailure {
  constructor(
    readonly code: string,
    readonly message: string,
  ) {}
}

export type Resolution = ResolvedStack | ResolveFailure

export function isResolved(resolution: Resolution): resolution is ResolvedStack {
  return !(resolution instanceof ResolveFailure)
}

const KEI_FACTS = {
  asset: KEI_ASSET,
  symbol: KEI_SYMBOL,
  name: KEI_NAME,
  decimals: KEI_DECIMALS,
  issuer: null,
  transferPolicy: 'open',
  maxSupplyRaw: null,
  circulatingRaw: 0n,
} as const

/**
 * Resolve one stack against the chain.
 *
 * `fallbackIssuer` is who a bare symbol belongs to. A recipe that says
 * `{ symbol: 'GEM' }` means "the GEM this recipe's issuer issues", which is the
 * shape a shared recipe file wants and the shape that cannot be spoofed by
 * somebody else issuing a token called GEM.
 */
export async function resolveStack(
  client: KeiClient,
  stack: Stack,
  fallbackIssuer: string | null,
  where: string,
): Promise<Resolution> {
  const target = describeRef(stack.asset, fallbackIssuer, where)
  if (target instanceof ResolveFailure) return target

  if (target.kind === 'kei') return withAmount(KEI_FACTS, stack.amount, where)

  const info =
    target.kind === 'id'
      ? await client.node.assetInfo(target.id)
      : await client.node.assetBySymbol(target.issuer, target.symbol)

  if (!info) {
    return new ResolveFailure(
      'no-such-asset',
      target.kind === 'id'
        ? `${where} names asset ${target.id}, which does not exist on ${client.node.network}. Check the id, or issue it first.`
        : `${where} names "${target.symbol}" issued by ${target.issuer}, and that account has not issued it on ${client.node.network}. Issue it with token.issue({ symbol: '${target.symbol}', ... }) from that account, or point the recipe at the account that did.`,
    )
  }

  return withAmount(
    {
      asset: info.id,
      symbol: info.symbol,
      name: info.name,
      decimals: info.decimals,
      issuer: info.issuer,
      transferPolicy: info.transfer,
      maxSupplyRaw: info.maxSupply === null ? null : BigInt(info.maxSupply),
      circulatingRaw: BigInt(info.circulating),
    },
    stack.amount,
    where,
  )
}

type RefTarget =
  | { kind: 'kei' }
  | { kind: 'id'; id: AssetId }
  | { kind: 'symbol'; symbol: string; issuer: string }

function describeRef(
  ref: AssetRef,
  fallbackIssuer: string | null,
  where: string,
): RefTarget | ResolveFailure {
  if (typeof ref === 'string') {
    const text = ref.trim()
    if (text.toUpperCase() === KEI_SYMBOL || text.toUpperCase() === KEI_ASSET) return { kind: 'kei' }
    if (isHex(text, 32)) return { kind: 'id', id: text.toUpperCase() }
    return symbolTarget(text, fallbackIssuer, where)
  }
  if ('id' in ref && typeof ref.id === 'string' && ref.id !== '') {
    const id = ref.id.trim()
    if (id.toUpperCase() === KEI_ASSET) return { kind: 'kei' }
    if (!isHex(id, 32)) {
      return new ResolveFailure(
        'bad-asset',
        `${where} has an id of "${id}", and an asset id is 64 hex characters. Pass the token object itself, or { symbol, issuer }.`,
      )
    }
    return { kind: 'id', id: id.toUpperCase() }
  }
  const symbol = (ref as { symbol: string }).symbol
  const issuer = (ref as { issuer?: string }).issuer
  return symbolTarget(symbol, issuer ?? fallbackIssuer, where)
}

function symbolTarget(
  symbol: string,
  issuer: string | null,
  where: string,
): RefTarget | ResolveFailure {
  if (issuer === null) {
    return new ResolveFailure(
      'no-issuer',
      `${where} names the symbol "${symbol}", and a symbol only identifies an asset together with the account that issued it — two games may both call a token GEM. Give the recipe an issuer (defineRecipe({ issuer: gameAddress, ... })), name the asset by id, or plan it from the issuer's own Kei.server() instance.`,
    )
  }
  try {
    return { kind: 'symbol', symbol, issuer: assertAddress(issuer, 'issuer address') }
  } catch (error) {
    return new ResolveFailure(
      'bad-issuer',
      `${where} names issuer "${String(issuer)}", which is not a Kei address: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function withAmount(
  facts: Omit<ResolvedStack, 'amount' | 'raw'>,
  amount: number | string | undefined,
  where: string,
): Resolution {
  const value = amount ?? 1
  let raw: bigint
  try {
    raw = toRaw(value, facts.decimals, `The amount in ${where}`)
  } catch (error) {
    // `toRaw` already knows whether this was unreadable or merely too precise
    // for the asset's decimals, and the fix differs. Keep its code.
    return new ResolveFailure(
      error instanceof KeiError ? error.code : 'bad-amount',
      error instanceof Error ? error.message : String(error),
    )
  }
  if (raw <= 0n) {
    return new ResolveFailure(
      'bad-amount',
      `The amount in ${where} must be greater than zero — got ${String(value)}.`,
    )
  }
  return { ...facts, amount: fromRaw(raw, facts.decimals), raw }
}

/** What this wallet could actually put behind a block right now, in raw units. */
export async function spendableRaw(client: KeiClient, stack: ResolvedStack, holder: string): Promise<bigint> {
  if (stack.asset === KEI_ASSET) {
    const info = await client.node.accountInfo(holder)
    return info ? BigInt(info.balance) : 0n
  }
  return BigInt(await client.node.holderBalance(stack.asset, holder))
}

/**
 * How much of an asset this wallet has locked in its own open offers.
 *
 * Only ever read to explain a shortfall: "where did my sword go" has one common
 * answer, and it is an offer this wallet wrote (SPEC §9.2).
 */
export async function lockedRaw(client: KeiClient, asset: AssetId, holder: string): Promise<bigint> {
  let total = 0n
  for (const offer of await client.node.accountSwaps(holder, { state: 'open' })) {
    if (offer.asset === asset) total += BigInt(offer.amount)
  }
  return total
}

/**
 * Raw units as an exact decimal string.
 *
 * `formatRaw`, never `String(fromRaw(...))`: this string is what `stock()` puts
 * on an offer block and what a Kei `send` is signed for, and a JS number carries
 * about 15 significant digits where Kei carries 18 decimal places. Rounding here
 * would list a shop at terms its own recipe no longer matches — the offer would
 * be real, open, and invisible to every player running this code.
 */
export function format(raw: bigint, stack: Pick<ResolvedStack, 'decimals'>): string {
  return formatRaw(raw, stack.decimals)
}
