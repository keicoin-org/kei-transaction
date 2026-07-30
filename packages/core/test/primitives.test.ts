import { describe, expect, test } from 'bun:test'
import bananojsModule from '@bananocoin/bananojs'

// bananojs's .d.ts describes namespaces its CommonJS runtime does not export.
const bananojs = bananojsModule as unknown as {
  getAccount(publicKey: string, prefix: string): string
  getAccountPublicKey(account: string): string
}

import {
  ADDRESS_PREFIX,
  KEI_DECIMALS,
  KeiError,
  MOCK_THRESHOLDS,
  ZERO_ADDRESS,
  addressFromPublicKey,
  combineHashes,
  deriveAssetId,
  formatRaw,
  generateWork,
  isAddress,
  keyPairFromSeed,
  leafHash,
  meetsThreshold,
  publicKeyFromAddress,
  randomSeed,
  toRaw,
  verifyProof,
  workRoot,
} from '@keicoin/core'

const SEED_A = 'A'.repeat(64)

describe('addresses', () => {
  test('encode with the kei_ prefix', async () => {
    const keys = await keyPairFromSeed(SEED_A)
    expect(keys.address.startsWith(ADDRESS_PREFIX)).toBe(true)
    expect(keys.address.length).toBe(ADDRESS_PREFIX.length + 60)
  })

  test('round-trip through the decoder', async () => {
    for (let index = 0; index < 8; index++) {
      const keys = await keyPairFromSeed(SEED_A, index)
      expect(publicKeyFromAddress(keys.address)).toBe(keys.publicKey)
    }
  })

  // The decoder is ours; the encoder is bananojs's. Pinning them against each
  // other in both prefixes is what stops the two drifting (see address.ts).
  test('decoder agrees with the inherited encoder, including for ban_', async () => {
    const keys = await keyPairFromSeed('7'.repeat(64), 3)
    const kei = bananojs.getAccount(keys.publicKey, 'kei_')
    const ban = bananojs.getAccount(keys.publicKey, 'ban_')
    expect(kei.slice(4)).toBe(ban.slice(4))
    expect(publicKeyFromAddress(kei)).toBe(keys.publicKey)
    expect(bananojs.getAccountPublicKey(ban)).toBe(keys.publicKey)
  })

  test('the zero address is well-formed and matches Nano lineage', () => {
    expect(ZERO_ADDRESS).toBe(`${ADDRESS_PREFIX}1111111111111111111111111111111111111111111111111111hifc8npp`)
    expect(isAddress(ZERO_ADDRESS)).toBe(true)
  })

  test('a typo fails its checksum instead of decoding to another account', async () => {
    const keys = await keyPairFromSeed(SEED_A)
    const mangled = keys.address.slice(0, -1) + (keys.address.endsWith('a') ? 'b' : 'a')
    expect(isAddress(mangled)).toBe(false)
    expect(() => publicKeyFromAddress(mangled)).toThrow(/checksum|valid/)
  })

  test('rejects other prefixes and wrong lengths with a sentence', async () => {
    const keys = await keyPairFromSeed(SEED_A)
    expect(() => publicKeyFromAddress(`ban_${keys.address.slice(4)}`)).toThrow(/starts with "kei_"/)
    expect(() => publicKeyFromAddress(`${ADDRESS_PREFIX}abc`)).toThrow(/characters long/)
  })
})

describe('seeds', () => {
  test('are 64 hex characters and different every time', () => {
    const first = randomSeed()
    expect(first).toMatch(/^[0-9A-F]{64}$/)
    expect(first).not.toBe(randomSeed())
  })

  test('derive deterministically', async () => {
    const one = await keyPairFromSeed(SEED_A, 5)
    const two = await keyPairFromSeed(SEED_A.toLowerCase(), 5)
    expect(two.address).toBe(one.address)
  })

  test('a bad seed says how to get a good one', async () => {
    await expect(keyPairFromSeed('nope')).rejects.toThrow(/64 hexadecimal characters/)
  })
})

describe('amounts', () => {
  test('decimal in, raw out', () => {
    expect(toRaw(1, 18).toString()).toBe('1000000000000000000')
    expect(toRaw(0.001, KEI_DECIMALS).toString()).toBe('1000000000000000')
    expect(toRaw('12.5', 2).toString()).toBe('1250')
    expect(toRaw(0, 0).toString()).toBe('0')
  })

  test('survives exponent notation, which is how small numbers stringify', () => {
    expect(toRaw(1e-7, 18).toString()).toBe('100000000000')
    expect(toRaw(1.5e3, 0).toString()).toBe('1500')
  })

  test('raw out, decimal in', () => {
    expect(formatRaw(1_000_000_000_000_000_000n, 18)).toBe('1')
    expect(formatRaw(1_500n, 2)).toBe('15')
    expect(formatRaw(1_050n, 2)).toBe('10.5')
    expect(formatRaw(0n, 18)).toBe('0')
  })

  test('too much precision is an error naming the asset\'s limit', () => {
    expect(() => toRaw(1.5, 0)).toThrow(/whole number/)
    expect(() => toRaw('0.001', 2)).toThrow(/only 2 are permitted/)
    expect(() => toRaw(-1, 18)).toThrow(/cannot be negative/)
    expect(() => toRaw(Number.NaN, 18)).toThrow(/finite number/)
  })

  test('trailing zeros beyond the limit are not precision', () => {
    expect(toRaw('1.500', 1).toString()).toBe('15')
  })
})

describe('asset ids', () => {
  test('are derived from issuer and symbol, so re-issuing collides by design', async () => {
    const issuer = await keyPairFromSeed(SEED_A)
    const other = await keyPairFromSeed('B'.repeat(64))
    expect(deriveAssetId(issuer.publicKey, 'GEM')).toBe(deriveAssetId(issuer.publicKey, 'gem'))
    expect(deriveAssetId(issuer.publicKey, 'GEM')).not.toBe(deriveAssetId(other.publicKey, 'GEM'))
    expect(deriveAssetId(issuer.publicKey, 'GEM')).toMatch(/^[0-9A-F]{64}$/)
  })

  test('a symbol that cannot work says what would', async () => {
    const issuer = await keyPairFromSeed(SEED_A)
    expect(() => deriveAssetId(issuer.publicKey, '')).toThrow(/1-20 characters/)
    expect(() => deriveAssetId(issuer.publicKey, 'has space')).toThrow(/1-20 characters/)
  })
})

describe('merkle proofs', () => {
  test('a single-leaf root is its own leaf, and verifies', async () => {
    const player = await keyPairFromSeed(SEED_A)
    const leaf = leafHash(player.publicKey, deriveAssetId(player.publicKey, 'GEM'), 500n)
    expect(verifyProof(leaf, [], leaf)).toBe(true)
  })

  test('a two-leaf proof verifies from either side', async () => {
    const a = await keyPairFromSeed(SEED_A)
    const b = await keyPairFromSeed('B'.repeat(64))
    const asset = deriveAssetId(a.publicKey, 'GEM')
    const leafA = leafHash(a.publicKey, asset, 500n)
    const leafB = leafHash(b.publicKey, asset, 120n)
    const root = combineHashes(leafA, leafB)
    expect(verifyProof(leafA, [leafB], root)).toBe(true)
    expect(verifyProof(leafB, [leafA], root)).toBe(true)
  })

  test('a wrong amount does not verify', async () => {
    const a = await keyPairFromSeed(SEED_A)
    const asset = deriveAssetId(a.publicKey, 'GEM')
    const root = leafHash(a.publicKey, asset, 500n)
    expect(verifyProof(leafHash(a.publicKey, asset, 501n), [], root)).toBe(false)
  })
})

describe('work', () => {
  test('generated work meets the tier it was generated for', async () => {
    const keys = await keyPairFromSeed(SEED_A)
    const root = workRoot({ account: keys.address, previous: '0'.repeat(64) })
    expect(root).toBe(keys.publicKey)
    const nonce = generateWork(root, BigInt(MOCK_THRESHOLDS.A))
    expect(meetsThreshold(root, nonce, BigInt(MOCK_THRESHOLDS.A))).toBe(true)
  })

  test('work for one root does not satisfy another', async () => {
    const keys = await keyPairFromSeed(SEED_A)
    const nonce = generateWork(keys.publicKey, BigInt(MOCK_THRESHOLDS.A))
    const otherRoot = 'F'.repeat(64)
    // Overwhelmingly likely to fail; the point is that the root is bound in.
    expect(meetsThreshold(otherRoot, nonce, BigInt(MOCK_THRESHOLDS.A))).toBe(false)
  })
})

describe('errors', () => {
  test('are KeiErrors carrying a code and a sentence', () => {
    try {
      toRaw(1.5, 0)
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(KeiError)
      expect((error as KeiError).code).toBe('too-precise')
      expect((error as KeiError).message).toMatch(/\.$/)
    }
  })
})
