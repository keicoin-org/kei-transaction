import { describe, expect, test } from 'bun:test'
import {
  formatRaw as coreFormatRaw,
  fromRaw as coreFromRaw,
  toRaw as coreToRaw,
  ZERO_HASH as coreZeroHash,
  containsSecret as coreContainsSecret,
  registerSecret as coreRegisterSecret,
  scrub as coreScrub,
} from '@keicoin/core'

import {
  formatRaw,
  fromRaw,
  toRaw,
  ZERO_HASH,
  containsSecret,
  registerSecret,
  scrub,
  KEI_DECIMALS,
  Kei,
  randomSeed,
} from '../src/index.js'

// #172: KEI_DECIMALS was reachable from the umbrella and the functions that use
// it correctly were not, so three consumers hand-rolled raw-to-decimal
// conversion (one of them in floating point). These assert the umbrella
// re-exports the same functions @keicoin/core does, not a copy.
describe('amount conversion umbrella exports (#172)', () => {
  test('formatRaw, fromRaw, toRaw and ZERO_HASH are the exact @keicoin/core exports', () => {
    expect(formatRaw).toBe(coreFormatRaw)
    expect(fromRaw).toBe(coreFromRaw)
    expect(toRaw).toBe(coreToRaw)
    expect(ZERO_HASH).toBe(coreZeroHash)
  })

  test('round-trips a raw amount at KEI_DECIMALS the way a consumer would', () => {
    const raw = 123_456_789_012_345_678n
    expect(fromRaw(raw, KEI_DECIMALS)).toBeCloseTo(0.123456789012345678, 15)
    expect(toRaw(formatRaw(raw, KEI_DECIMALS), KEI_DECIMALS)).toBe(raw)
  })

  test('ZERO_HASH is the 64-character all-zero hash', () => {
    expect(ZERO_HASH).toBe('0'.repeat(64))
  })
})

// #138: containsSecret/scrub/registerSecret were exported from @keicoin/core but
// not from the umbrella every consumer installs, so kei-wallet built a weaker
// copy of its own — missing case variants and the derived private key.
describe('secret-scrubbing umbrella exports (#138)', () => {
  test('containsSecret, registerSecret and scrub are the exact @keicoin/core exports', () => {
    expect(containsSecret).toBe(coreContainsSecret)
    expect(registerSecret).toBe(coreRegisterSecret)
    expect(scrub).toBe(coreScrub)
  })

  test('a client registers its seed and derived private key, reachable through the umbrella alone', async () => {
    const seed = randomSeed()
    const node = await Kei.mock()
    const kei = await Kei.start({ node, seed })
    try {
      expect(containsSecret(seed.toLowerCase())).toBe(true)
      expect(containsSecret(seed.toUpperCase())).toBe(true)
      expect(scrub(`leaked: ${seed}`)).toBe('leaked: [redacted]')
    } finally {
      kei.close()
    }
  })

  test('ordinary text is not flagged as a secret', () => {
    expect(containsSecret('kei_3abc… sent 0.5 Kei')).toBe(false)
  })
})
