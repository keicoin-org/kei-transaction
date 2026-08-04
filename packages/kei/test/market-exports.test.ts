import { describe, expect, test } from 'bun:test'
import {
  createAccountChainSource as createMarketAccountChainSource,
  DEFAULT_SUBSCRIPTION_READ_TIMEOUT as MARKET_DEFAULT_SUBSCRIPTION_READ_TIMEOUT,
  MAX_ACCOUNTS_PER_WALK as MARKET_MAX_ACCOUNTS_PER_WALK,
  MAX_DIRECTORY_LIMIT as MARKET_MAX_DIRECTORY_LIMIT,
  toUnixCandles as marketToUnixCandles,
  toUnixLine as marketToUnixLine,
} from '@keicoin/market'

import {
  createAccountChainSource,
  DEFAULT_SUBSCRIPTION_READ_TIMEOUT,
  MAX_ACCOUNTS_PER_WALK,
  MAX_DIRECTORY_LIMIT,
  toUnixCandles,
  toUnixLine,
  type InstrumentApi,
  type InstrumentSnapshot,
  type MarketDataSource,
} from '../src/index.js'

describe('market bounds umbrella exports', () => {
  test('exposes the authoritative directory and account-walk ceilings', () => {
    expect(MAX_DIRECTORY_LIMIT).toBe(256)
    expect(MAX_ACCOUNTS_PER_WALK).toBe(256)
    expect(MAX_DIRECTORY_LIMIT).toBe(MARKET_MAX_DIRECTORY_LIMIT)
    expect(MAX_ACCOUNTS_PER_WALK).toBe(MARKET_MAX_ACCOUNTS_PER_WALK)
    expect(DEFAULT_SUBSCRIPTION_READ_TIMEOUT).toBe(30_000)
    expect(DEFAULT_SUBSCRIPTION_READ_TIMEOUT).toBe(MARKET_DEFAULT_SUBSCRIPTION_READ_TIMEOUT)
  })

  test('exposes the instrument data and chart surface with its public types', () => {
    expect(createAccountChainSource).toBe(createMarketAccountChainSource)
    expect(toUnixCandles).toBe(marketToUnixCandles)
    expect(toUnixLine).toBe(marketToUnixLine)
    const typesCompile = <T>(_value?: T): true => true
    expect(typesCompile<InstrumentApi>()).toBe(true)
    expect(typesCompile<InstrumentSnapshot>()).toBe(true)
    expect(typesCompile<MarketDataSource>()).toBe(true)
  })
})
