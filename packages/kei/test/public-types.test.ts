import { describe, expect, test } from 'bun:test'
import type { HttpNodeOptions, WalletOptions } from 'kei-transaction'

describe('umbrella option types', () => {
  test('names the configurable core and wallet surfaces', () => {
    const node: HttpNodeOptions = {
      url: 'https://testnet.keicoin.org/rpc',
      requestTimeout: 15_000,
    }
    const wallet: WalletOptions = {
      assetConcurrency: 8,
      assetCacheLimit: 2_048,
    }

    expect(node.requestTimeout).toBe(15_000)
    expect(wallet.assetCacheLimit).toBe(2_048)
  })
})
