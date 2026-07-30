import { fail } from './errors.js'

const HEX = /^[0-9A-Fa-f]+$/

export function isHex(value: unknown, bytes?: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || !HEX.test(value)) return false
  if (value.length % 2 !== 0) return false
  return bytes === undefined || value.length === bytes * 2
}

export function hexToBytes(hex: string): Uint8Array {
  if (!isHex(hex)) fail('bad-hex', `Expected hex, got "${hex}".`)
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out.toUpperCase()
}

/** Big-endian unsigned encoding of `value` in exactly `bytes` bytes. */
export function bigintToBytes(value: bigint, bytes: number): Uint8Array {
  if (value < 0n) fail('bad-amount', `Cannot encode a negative amount (${value}).`)
  const out = new Uint8Array(bytes)
  let rest = value
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  if (rest !== 0n) fail('overflow', `Amount ${value} does not fit in ${bytes} bytes.`)
  return out
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
