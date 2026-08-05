import { describe, expect, test } from 'bun:test'
import {
  createAccountChainIngestor as createMarketAccountChainIngestor,
  createAccountChainSource as createMarketAccountChainSource,
  DEFAULT_MARKET_RETENTION as MARKET_DEFAULT_RETENTION,
  DEFAULT_SUBSCRIPTION_READ_TIMEOUT as MARKET_DEFAULT_SUBSCRIPTION_READ_TIMEOUT,
  MARKET_STORAGE_SCHEMA_VERSION as MARKET_SCHEMA_VERSION,
  MAX_ACCOUNTS_PER_WALK as MARKET_MAX_ACCOUNTS_PER_WALK,
  MAX_DIRECTORY_LIMIT as MARKET_MAX_DIRECTORY_LIMIT,
  toUnixCandles as marketToUnixCandles,
  toUnixLine as marketToUnixLine,
} from '@keicoin/market'

import {
  createAccountChainIngestor,
  createAccountChainSource,
  DEFAULT_MARKET_RETENTION,
  DEFAULT_SUBSCRIPTION_READ_TIMEOUT,
  MARKET_STORAGE_SCHEMA_VERSION,
  MAX_ACCOUNTS_PER_WALK,
  MAX_DIRECTORY_LIMIT,
  MAX_MARKET_RETENTION,
  toUnixCandles,
  toUnixLine,
  type InstrumentApi,
  type InstrumentSnapshot,
  type AccountChainIngestor,
  type MarketDataSource,
  type MarketStorageAdapter,
  type StoredMarketCoverage,
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
    expect(createAccountChainIngestor).toBe(createMarketAccountChainIngestor)
    expect(createAccountChainIngestor).not.toBe(createAccountChainSource)
    expect(createAccountChainSource).toBe(createMarketAccountChainSource)
    expect(toUnixCandles).toBe(marketToUnixCandles)
    expect(toUnixLine).toBe(marketToUnixLine)
    const typesCompile = <T>(_value?: T): true => true
    expect(typesCompile<InstrumentApi>()).toBe(true)
    expect(typesCompile<InstrumentSnapshot>()).toBe(true)
    expect(typesCompile<AccountChainIngestor>()).toBe(true)
    expect(typesCompile<MarketDataSource>()).toBe(true)
  })

  test('exposes the store schema version and its retention bounds', () => {
    expect(MARKET_STORAGE_SCHEMA_VERSION).toBe(MARKET_SCHEMA_VERSION)
    expect(DEFAULT_MARKET_RETENTION).toBe(MARKET_DEFAULT_RETENTION)
    // Every bound has a compaction path, and none of them may exceed what the
    // envelope validator will open on the next read.
    for (const key of Object.keys(DEFAULT_MARKET_RETENTION) as (keyof typeof DEFAULT_MARKET_RETENTION)[]) {
      expect(DEFAULT_MARKET_RETENTION[key]).toBeLessThanOrEqual(MAX_MARKET_RETENTION[key])
    }
    const typesCompile = <T>(_value?: T): true => true
    expect(typesCompile<MarketStorageAdapter>()).toBe(true)
    expect(typesCompile<StoredMarketCoverage>()).toBe(true)
  })
})
