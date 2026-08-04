/**
 * The headless pieces every application built on this package had to invent:
 * a bounded roster, a series a chart can draw, and the check that stops an
 * index becoming an authority.
 *
 * Everything here is pure, so everything here is tested pure and this package's
 * tests import no chain. `readBook` needs one and is exercised against the mock
 * ledger in `packages/kei/test/market-aggregation.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { KEI_ASSET, keyPairFromSeed, randomSeed } from '@keicoin/core'
import {
  DEFAULT_DIRECTORY_LIMIT,
  MAX_DIRECTORY_LIMIT,
  bidPrice,
  classify,
  createDirectory,
  coverageOf,
  emptyCoverage,
  expectationFrom,
  isMarketError,
  priceIndex,
  resolveAccounts,
  settleable,
  toCandles,
  toSeries,
  verify,
  withCoverage,
  type Offer,
  type Trade,
} from '@keicoin/market'

/** Real addresses, because `watch` refuses anything that is not one. */
async function addresses(count: number): Promise<string[]> {
  const pairs = await Promise.all(Array.from({ length: count }, () => keyPairFromSeed(randomSeed(), 0)))
  return pairs.map((pair) => pair.address)
}

// ------------------------------------------------------------------ directory

describe('the account directory (SPEC §9.1, §9.4)', () => {
  test('holds addresses and ignores anything that is not one', () => {
    const directory = createDirectory()
    expect(directory.watch('kei_' + '1'.repeat(60))).toBe(false)
    expect(directory.watch('not an address')).toBe(false)
    expect(directory.watch('')).toBe(false)
    expect(directory.accounts()).toEqual([])
  })

  test('is bounded, and evicts the account heard from longest ago', async () => {
    const players = await addresses(4)
    const directory = createDirectory({ limit: 3 })
    for (const address of players) directory.watch(address)

    expect(directory.size).toBe(3)
    expect(directory.dropped).toBe(1)
    expect(directory.accounts()).not.toContain(players[0] as string)
    expect(directory.accounts()).toContain(players[3] as string)
  })

  test('re-announcing moves an address back to the newest end', async () => {
    const players = await addresses(3)
    const directory = createDirectory({ limit: 2, accounts: players.slice(0, 2) })
    directory.watch(players[0] as string)
    directory.watch(players[2] as string)

    // The one re-announced survived; the one that went quiet did not.
    expect(directory.accounts()).toContain(players[0] as string)
    expect(directory.accounts()).not.toContain(players[1] as string)
  })

  test('the default bound is stated rather than implied', () => {
    expect(createDirectory().limit).toBe(DEFAULT_DIRECTORY_LIMIT)
  })

  test('the bound is a finite positive safe integer with an absolute ceiling', () => {
    expect(createDirectory({ limit: 1 }).limit).toBe(1)
    expect(createDirectory({ limit: MAX_DIRECTORY_LIMIT }).limit).toBe(MAX_DIRECTORY_LIMIT)

    for (const limit of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      MAX_DIRECTORY_LIMIT + 1,
    ]) {
      let failure: unknown
      try {
        createDirectory({ limit })
      } catch (error) {
        failure = error
      }
      expect(isMarketError(failure, 'bad-directory-limit')).toBe(true)
      expect(failure).toMatchObject({
        message: expect.stringContaining(`1 through ${MAX_DIRECTORY_LIMIT}`),
      })
    }
  })

  test('an invalid bound is refused before a hostile initial iterable is touched', () => {
    let touched = 0
    const accounts: Iterable<string> = {
      [Symbol.iterator]() {
        touched += 1
        throw new Error('initial roster must not be opened')
      },
    }

    const failure = (() => {
      try {
        createDirectory({ limit: Number.NaN, accounts })
      } catch (error) {
        return error
      }
    })()
    expect(isMarketError(failure, 'bad-directory-limit')).toBe(true)
    expect(touched).toBe(0)
  })

  test('a from can be an address, a list, or any directory', async () => {
    expect(await resolveAccounts('kei_a')).toEqual(['kei_a'])
    expect(await resolveAccounts(['kei_a', 'kei_b'])).toEqual(['kei_a', 'kei_b'])
    // Four lines is the whole interface, which is the point of it being one method.
    expect(await resolveAccounts({ accounts: async () => ['kei_remote'] })).toEqual(['kei_remote'])
  })
})

// ----------------------------------------------------------------- the series

const trade = (over: Partial<Trade> & { give: Trade['give']; want: Trade['want'] }): Trade =>
  ({
    hash: 'H',
    from: 'kei_seller',
    seller: 'kei_seller',
    buyer: 'kei_buyer',
    price: over.want.amount / over.give.amount,
    to: null,
    expiresAt: null,
    expired: false,
    state: 'accepted',
    mine: false,
    acceptedBy: 'kei_buyer',
    settledBy: 'B',
    seenAt: 0,
    settledAt: 0,
    ...over,
  }) as Trade

const leg = (asset: string, amount: number) => ({ asset, symbol: asset, name: asset, decimals: 0, amount })

const sale = (hash: string, units: number, paid: number, at: number | null): Trade =>
  trade({
    hash,
    give: leg('SWORD', units),
    want: leg(KEI_ASSET, paid),
    seenAt: at ?? 0,
    settledAt: at,
  })

describe('price series — consensus numbers, advisory order', () => {
  test('points come back oldest first, which is left to right on a chart', () => {
    const series = toSeries([sale('C', 1, 9, 300), sale('A', 1, 5, 100), sale('B', 1, 7, 200)], {
      asset: 'SWORD',
      quote: KEI_ASSET,
    })
    expect(series.points.map((point) => point.hash)).toEqual(['A', 'B', 'C'])
    expect(series.points.map((point) => point.index)).toEqual([0, 1, 2])
    expect(series.first).toBe(5)
    expect(series.last).toBe(9)
    expect(series.change).toBe(4)
    expect(series.changeRatio).toBeCloseTo(0.8)
  })

  test('the price is per unit, so a lot of ten is not ten times the price', () => {
    const series = toSeries([sale('A', 10, 50, 100)], { asset: 'SWORD', quote: KEI_ASSET })
    expect(series.points[0]?.price).toBe(5)
    expect(series.points[0]?.units).toBe(10)
    expect(series.points[0]?.paid).toBe(50)
  })

  test('the ordering says what it is worth, and counts what it had to guess', () => {
    const series = toSeries([sale('A', 1, 5, 100), sale('B', 1, 7, null)], {
      asset: 'SWORD',
      quote: KEI_ASSET,
    })
    expect(series.ordering.by).toBe('advisory-time')
    expect(series.ordering.exact).toBe(false)
    expect(series.ordering.estimated).toBe(1)
    expect(series.ordering.note).toContain('not consensus')
  })

  test('the statistics over it are the ones every node agrees on', () => {
    const series = toSeries([sale('A', 1, 5, 100), sale('B', 1, 7, 200), sale('C', 1, 9, 300)], {
      asset: 'SWORD',
      quote: KEI_ASSET,
    })
    expect(series.summary?.median).toBe(7)
    expect(series.summary?.low).toBe(5)
    expect(series.summary?.high).toBe(9)
    expect(series.summary?.trades).toBe(3)
    expect(series.summary?.volume).toBe(3)
  })

  test('an asset that never traded is an empty series rather than a price of zero', () => {
    const series = toSeries([sale('A', 1, 5, 100)], { asset: 'SHIELD', quote: KEI_ASSET })
    expect(series.points).toEqual([])
    expect(series.last).toBeNull()
    expect(series.summary).toBeNull()
  })

  test('candles bucket exactly, and say how wide they are', () => {
    const hour = 3_600_000
    const candles = toCandles(
      [
        sale('A', 1, 5, hour + 10),
        sale('B', 2, 20, hour + 20),
        sale('C', 1, 3, hour * 3 + 5),
      ],
      { asset: 'SWORD', quote: KEI_ASSET, every: '1h' },
    )
    expect(candles).toHaveLength(2)
    expect(candles[0]).toMatchObject({ at: hour, every: hour, open: 5, high: 10, low: 5, close: 10, volume: 3, trades: 2 })
    expect(candles[1]).toMatchObject({ at: hour * 3, open: 3, close: 3, volume: 1, trades: 1 })
  })

  test('an empty candle transform keeps the coverage of the walk that found nothing', () => {
    const coverage = {
      ...emptyCoverage(),
      asked: 2,
      read: 1,
      failed: [{ account: 'kei_missing', reason: 'node unreachable' }],
      complete: false,
    }
    const candles = toCandles(withCoverage<Trade>([], coverage), {
      asset: 'SWORD',
      quote: KEI_ASSET,
      every: '1h',
    })
    expect(candles).toEqual([])
    expect(coverageOf(candles)).toEqual(coverage)
  })

  test('fill evens the axis with the previous close and no volume', () => {
    const hour = 3_600_000
    const candles = toCandles([sale('A', 1, 5, hour), sale('C', 1, 3, hour * 3)], {
      asset: 'SWORD',
      quote: KEI_ASSET,
      every: '1h',
      fill: true,
    })
    expect(candles).toHaveLength(3)
    expect(candles[1]).toMatchObject({ at: hour * 2, open: 5, close: 5, volume: 0, trades: 0 })
  })

  test('priceIndex summarises every asset out of one set of trades', () => {
    const index = priceIndex(
      [
        sale('A', 1, 5, 100),
        sale('B', 1, 9, 200),
        trade({ hash: 'C', give: leg('SHIELD', 2), want: leg(KEI_ASSET, 40), settledAt: 300, seenAt: 300 }),
      ],
      { quote: KEI_ASSET },
    )
    expect(index.get('SWORD')?.median).toBe(7)
    expect(index.get('SHIELD')?.last).toBe(20)
    // Kei itself is the quote, so it is not a row in its own index.
    expect(index.has(KEI_ASSET)).toBe(false)
  })
})

// -------------------------------------------------------------- the lifecycle

const offer = (over: Partial<Offer> = {}): Offer =>
  ({
    hash: 'OFFER',
    from: 'kei_seller',
    give: leg('SWORD', 1),
    want: leg(KEI_ASSET, 5),
    price: 5,
    to: null,
    expiresAt: null,
    expired: false,
    state: 'open',
    mine: false,
    acceptedBy: null,
    settledBy: null,
    seenAt: 0,
    settledAt: null,
    ...over,
  }) as Offer

describe('lifecycle — what became of a listing', () => {
  test('stale is open, past its expiry, and still settleable (SPEC §9.3)', () => {
    const listing = offer({ expiresAt: 100 })
    expect(classify(listing, { now: () => 200 })).toBe('stale')
    expect(settleable('stale')).toBe(true)
    // Which is the difference that matters: the ledger never agreed to a clock.
    expect(settleable('taken')).toBe(false)
    expect(settleable('cancelled')).toBe(false)
  })

  test('reserved is open and not for this viewer', () => {
    const listing = offer({ to: 'kei_alice' })
    expect(classify(listing, { viewer: 'kei_bob' })).toBe('reserved')
    expect(classify(listing, { viewer: 'kei_alice' })).toBe('live')
  })

  test('taken and cancelled are different sentences, not one "gone"', () => {
    expect(classify(offer({ state: 'accepted', acceptedBy: 'kei_bob' }))).toBe('taken')
    expect(classify(offer({ state: 'cancelled' }))).toBe('cancelled')
  })
})

describe('verify — an index is a list of where to look, never an authority', () => {
  test('every field given is checked, and the mismatch names both values', () => {
    const chain = offer({ want: leg(KEI_ASSET, 500) })
    const result = verify(chain, { hash: 'OFFER', want: { asset: KEI_ASSET, amount: 5 } })
    expect(result.ok).toBe(false)
    expect(result.mismatches[0]).toContain('shown as 5')
    expect(result.mismatches[0]).toContain('chain says 500')
  })

  test('the same price on a different asset is caught, which price alone would not', () => {
    // The attack `world-of-wonder` wrote its own check for: right numbers,
    // wrong item.
    const chain = offer({ give: leg('RUSTY_NAIL', 1) })
    expect(verify(chain, { give: { asset: 'SWORD', amount: 1 } }).ok).toBe(false)
  })

  test('a listing that has not moved verifies against itself', () => {
    const chain = offer()
    expect(verify(chain, expectationFrom(chain)).ok).toBe(true)
  })

  test('fields left out are not checked', () => {
    expect(verify(offer({ from: 'kei_somebody_else' }), { hash: 'OFFER' }).ok).toBe(true)
  })
})

describe('bidPrice', () => {
  test('inverts a bid so it can be compared against an ask', () => {
    // Gives 20 Kei, wants 4 swords: 5 Kei each, and the raw `price` is 0.2.
    const bid = offer({ give: leg(KEI_ASSET, 20), want: leg('SWORD', 4), price: 0.2 })
    expect(bidPrice(bid)).toBe(5)
  })
})
