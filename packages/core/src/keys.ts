import { addressFromPublicKey } from './address.js'
import { derivePrivateKey, derivePublicKey } from './crypto.js'
import { fail, registerSecret } from './errors.js'
import { bytesToHex, isHex } from './hex.js'

export interface KeyPair {
  readonly seed: string
  readonly index: number
  readonly privateKey: string
  readonly publicKey: string
  readonly address: string
}

/** A 64-hex seed from the platform CSPRNG. Never transmitted (SPEC §6.4). */
export function randomSeed(): string {
  const bytes = new Uint8Array(32)
  const source = (globalThis as { crypto?: { getRandomValues?(into: Uint8Array): Uint8Array } }).crypto
  if (!source?.getRandomValues) {
    fail(
      'no-randomness',
      'No secure random source available. Kei needs Web Crypto — use Node 18+, Bun, or a modern browser.',
    )
  }
  source.getRandomValues(bytes)
  return bytesToHex(bytes)
}

export function isSeed(value: unknown): value is string {
  return isHex(value, 32)
}

export function normalizeSeed(seed: string, label = 'seed'): string {
  if (!isSeed(seed)) {
    fail(
      'bad-seed',
      `A Kei ${label} is 64 hexadecimal characters. Generate one by calling Kei.start() with no seed, or check the value you passed.`,
    )
  }
  return seed.toUpperCase()
}

export async function keyPairFromSeed(seed: string, index = 0): Promise<KeyPair> {
  const normalized = normalizeSeed(seed)
  registerSecret(normalized)
  const privateKey = await derivePrivateKey(normalized, index)
  registerSecret(privateKey)
  const publicKey = await derivePublicKey(privateKey)
  return {
    seed: normalized,
    index,
    privateKey,
    publicKey,
    address: addressFromPublicKey(publicKey),
  }
}
