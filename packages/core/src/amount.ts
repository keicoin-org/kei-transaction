/**
 * Amounts. The public API speaks plain decimal numbers; raw integers never
 * leave this file's callers (SPEC §6.1).
 *
 * KEI_DECIMALS is an M0 choice, not a spec value — see docs/decisions-m0.md.
 * It is fixed here so every other module agrees, and it is the genesis block's
 * to confirm at M2.
 */

import { fail } from './errors.js'

export const KEI_DECIMALS = 18
export const KEI_SYMBOL = 'KEI'
export const KEI_NAME = 'Kei'

/** 1,000,000,000,000 Kei, fixed at genesis (SPEC §5.7). */
export const KEI_TOTAL_SUPPLY = 1_000_000_000_000n * 10n ** BigInt(KEI_DECIMALS)

/** Issuing an asset burns 1,000 Kei (SPEC §5.6.5). */
export const ISSUANCE_BURN = 1_000n * 10n ** BigInt(KEI_DECIMALS)

/** Expand a JS number into a plain decimal string, exponent notation included. */
function decimalString(value: number): string {
  if (!Number.isFinite(value)) {
    fail('bad-amount', `Amount must be a finite number — got ${String(value)}.`)
  }
  const text = String(value)
  if (!text.includes('e') && !text.includes('E')) return text

  const [mantissa = '0', exponentText = '0'] = text.toLowerCase().split('e')
  const exponent = Number(exponentText)
  const negative = mantissa.startsWith('-')
  const digits = mantissa.replace(/^[-+]/, '')
  const [whole = '0', fraction = ''] = digits.split('.')
  const flat = whole + fraction
  const pointAt = whole.length + exponent

  let out: string
  if (pointAt <= 0) out = '0.' + '0'.repeat(-pointAt) + flat
  else if (pointAt >= flat.length) out = flat + '0'.repeat(pointAt - flat.length)
  else out = flat.slice(0, pointAt) + '.' + flat.slice(pointAt)

  return (negative ? '-' : '') + out
}

/**
 * Convert a developer-facing amount into raw units.
 *
 * `label` names the thing being converted so the error can state its own fix.
 */
export function toRaw(amount: number | string, decimals: number, label = 'Amount'): bigint {
  const text = typeof amount === 'number' ? decimalString(amount) : String(amount).trim()

  if (text.startsWith('-')) {
    fail('bad-amount', `${label} cannot be negative — got ${text}. Amounts are always positive.`)
  }
  const match = /^\+?(\d*)(?:\.(\d*))?$/.exec(text)
  if (!match || (match[1] === '' && (match[2] ?? '') === '')) {
    fail('bad-amount', `${label} must be a decimal number like 1.5 — got "${text}".`)
  }
  const whole = match[1] === '' ? '0' : (match[1] as string)
  const fraction = match[2] ?? ''

  if (fraction.replace(/0+$/, '').length > decimals) {
    fail(
      'too-precise',
      decimals === 0
        ? `${label} must be a whole number — got ${text}, and this asset has 0 decimal places.`
        : `${label} has more decimal places than this asset allows — got ${text}, and only ${decimals} are permitted.`,
    )
  }
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals)
  return BigInt(whole + padded)
}

/** Render raw units as a plain decimal string, trailing zeros trimmed. */
export function formatRaw(raw: bigint, decimals: number): string {
  const negative = raw < 0n
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = decimals === 0 ? '' : digits.slice(digits.length - decimals).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? '.' + fraction : ''}`
}

/** Raw units as a number, for the public API surface. */
export function fromRaw(raw: bigint, decimals: number): number {
  return Number(formatRaw(raw, decimals))
}
