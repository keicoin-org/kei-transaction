import { describe, expect, test } from 'bun:test'
import {
  MAX_ACCOUNTS_PER_WALK as MARKET_MAX_ACCOUNTS_PER_WALK,
  MAX_DIRECTORY_LIMIT as MARKET_MAX_DIRECTORY_LIMIT,
} from '@keicoin/market'

import { MAX_ACCOUNTS_PER_WALK, MAX_DIRECTORY_LIMIT } from '../src/index.js'

describe('market bounds umbrella exports', () => {
  test('exposes the authoritative directory and account-walk ceilings', () => {
    expect(MAX_DIRECTORY_LIMIT).toBe(256)
    expect(MAX_ACCOUNTS_PER_WALK).toBe(256)
    expect(MAX_DIRECTORY_LIMIT).toBe(MARKET_MAX_DIRECTORY_LIMIT)
    expect(MAX_ACCOUNTS_PER_WALK).toBe(MARKET_MAX_ACCOUNTS_PER_WALK)
  })
})
