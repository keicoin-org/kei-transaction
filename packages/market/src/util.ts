import type { AssetId } from '@keicoin/core'
import { fail } from '@keicoin/core'

import type { Duration } from './types.js'

/** The ledger accepts asset divisibility only in this range. */
export const MAX_ASSET_DECIMALS = 18
/** Swap amounts are encoded as unsigned 128-bit integers on the wire. */
export const MAX_RAW_AMOUNT = (1n << 128n) - 1n
export const MAX_RAW_DIGITS = MAX_RAW_AMOUNT.toString().length

export function assetIdOf(asset: AssetId | { id: AssetId }): AssetId {
  const id = typeof asset === 'string' ? asset : asset?.id
  if (typeof id !== 'string' || id === '') {
    fail('bad-asset', 'Name an asset by its id, or pass the item or token object itself.')
  }
  return id.toUpperCase()
}

/** Validate untrusted asset metadata before it can size powers or decimal padding. */
export function assetDecimalsOf(value: unknown, label = 'Asset decimals'): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_ASSET_DECIMALS) {
    fail(
      'bad-asset-metadata',
      `${label} must be a safe whole number from 0 through ${MAX_ASSET_DECIMALS}; got ${String(value)}. This node response was not used or cached.`,
    )
  }
  return value as number
}

/** Parse one positive ledger quantity without allowing an unbounded BigInt input. */
export function rawAmountOf(value: unknown, label = 'Offer quantity'): bigint {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RAW_DIGITS || !/^(0|[1-9]\d*)$/.test(value)) {
    fail(
      'bad-offer',
      `${label} must be a canonical positive unsigned 128-bit decimal string (at most ${MAX_RAW_DIGITS} digits); got an invalid node value.`,
    )
  }
  const raw = BigInt(value)
  if (raw <= 0n || raw > MAX_RAW_AMOUNT) {
    fail('bad-offer', `${label} must be between 1 and ${MAX_RAW_AMOUNT.toString()} raw units; got ${value}.`)
  }
  return raw
}

/** Keep hostile arithmetic out of public JSON, where non-finite numbers become null. */
export function finiteMarketNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    fail('bad-offer', `${label} must be a finite market number; the node data produced ${String(value)} and was refused.`)
  }
  return value
}

const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

/** `'7d'`, `'90m'`, or a plain number of milliseconds. */
export function durationMs(value: Duration, label = 'A duration'): number {
  let milliseconds: number
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      fail(
        'bad-duration',
        `${label} is a positive number of milliseconds, or a string like '7d' — got ${String(value)}.`,
      )
    }
    milliseconds = Math.floor(value)
  } else {
    const match = DURATION.exec(String(value).trim())
    if (!match) {
      fail(
        'bad-duration',
        `${label} looks like '7d', '12h', '90m', '30s', or a number of milliseconds — got "${String(value)}".`,
      )
    }
    milliseconds = Math.floor(Number(match[1]) * (UNIT_MS[String(match[2]).toLowerCase()] as number))
  }

  // Validate the value the caller will actually get, not only the positive
  // decimal that produced it. Sub-millisecond inputs floor to zero, and a long
  // digit string can overflow while it is multiplied by the unit.
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    fail(
      'bad-duration',
      `${label} must resolve to a positive safe whole number of milliseconds — got ${String(value)}. Use at least 1ms and keep the result at or below ${Number.MAX_SAFE_INTEGER}.`,
    )
  }
  return milliseconds
}
