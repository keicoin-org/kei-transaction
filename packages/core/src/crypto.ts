/**
 * The only place this SDK touches cryptography, and it does not implement any.
 *
 * SPEC §10.2: build on `bananojs` rather than reimplementing key derivation and
 * block signing — hand-rolled crypto is how wallets lose money. Kei inherits
 * Nano/Banano's ed25519-with-blake2b signatures and its address encoding
 * (SPEC §5.8), so the inherited implementation is the correct one.
 *
 * `bananojs` ships a `.d.ts` whose shape does not match its CommonJS runtime
 * export, so the surface this SDK uses is declared here and asserted once.
 */

import bananojs from '@bananocoin/bananojs'

interface BananoCrypto {
  /** Derive the private key at `index` from a 64-hex seed. */
  getPrivateKey(seed: string, index: number): string | Promise<string>
  /** Derive the public key from a private key. */
  getPublicKey(privateKey: string): string | Promise<string>
  /** Encode a public key as an address with the given prefix, e.g. 'kei_'. */
  getAccount(publicKey: string, accountPrefix: string): string
  /** Sign a 64-hex hash. */
  signHash(privateKey: string, hash: string): string | Promise<string>
  /** Verify a signature over a 64-hex hash. */
  verify(hash: string, signature: string, publicKey: string): boolean | Promise<boolean>
  /** blake2b of `bytes`, truncated to `size` bytes. */
  getBlake2bHash(bytes: Uint8Array, size: number): Uint8Array
}

const banano = bananojs as unknown as BananoCrypto

export function blake2b(bytes: Uint8Array, size: number): Uint8Array {
  return Uint8Array.from(banano.getBlake2bHash(bytes, size))
}

export async function derivePrivateKey(seed: string, index: number): Promise<string> {
  return (await banano.getPrivateKey(seed, index)).toUpperCase()
}

export async function derivePublicKey(privateKey: string): Promise<string> {
  return (await banano.getPublicKey(privateKey)).toUpperCase()
}

export function encodeAddress(publicKey: string, prefix: string): string {
  return banano.getAccount(publicKey, prefix)
}

export async function signHash(privateKey: string, hash: string): Promise<string> {
  return (await banano.signHash(privateKey, hash)).toUpperCase()
}

export async function verifyHash(hash: string, signature: string, publicKey: string): Promise<boolean> {
  try {
    return (await banano.verify(hash, signature, publicKey)) === true
  } catch {
    return false
  }
}
