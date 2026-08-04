import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_ASSET_CACHE_LIMIT,
  DEFAULT_ASSET_CONCURRENCY,
  MAX_ASSET_CACHE_LIMIT,
  MAX_ASSET_CONCURRENCY,
  type WalletOptions,
} from '../src/index.js'

describe('wallet configuration umbrella exports', () => {
  test('exposes the supported bounds and WalletOptions type', () => {
    const options: WalletOptions = {
      assetConcurrency: DEFAULT_ASSET_CONCURRENCY,
      assetCacheLimit: DEFAULT_ASSET_CACHE_LIMIT,
    }

    expect(options).toEqual({ assetConcurrency: 8, assetCacheLimit: 2_048 })
    expect(MAX_ASSET_CONCURRENCY).toBe(32)
    expect(MAX_ASSET_CACHE_LIMIT).toBe(8_192)
  })
})
