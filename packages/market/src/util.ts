import type { AssetId } from '@keicoin/core'
import { fail } from '@keicoin/core'

import type { Duration } from './types.js'

export function assetIdOf(asset: AssetId | { id: AssetId }): AssetId {
  const id = typeof asset === 'string' ? asset : asset?.id
  if (typeof id !== 'string' || id === '') {
    fail('bad-asset', 'Name an asset by its id, or pass the item or token object itself.')
  }
  return id.toUpperCase()
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
