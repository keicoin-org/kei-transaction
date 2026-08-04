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
import { KEI_ASSET, KeiError, keyPairFromSeed, randomSeed } from '@keicoin/core'
import {
  DEFAULT_DIRECTORY_LIMIT,
  DEFAULT_MAX_CANDLES,
  MAX_CANDLES,
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
  type Duration,
  type Trade,
} from '@keicoin/market'

/** Real addresses, because `watch` refuses anything that is not one. */
async function addresses(count: number): Promise<string[]> {
  const pairs = await Promise.all(Array.from({ length: count }, () => keyPairFromSeed(randomSeed(), 0)))
  return pairs.map((pair) => pair.address)
}

function caught(fn: () => unknown): unknown {
  let error: unknown
  try {
    fn()
  } catch (cause) {
    error = cause
  }
  expect(error).toBeInstanceOf(KeiError)
  return error
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

  test('fill preserves the coverage provenance of the sparse input', () => {
    const coverage = {
      ...emptyCoverage(),
      asked: 2,
      read: 1,
      failed: [{ account: 'kei_missing', reason: 'node unreachable' }],
      complete: false,
    }
    const candles = toCandles(
      withCoverage<Trade>([sale('A', 1, 5, 0), sale('B', 1, 7, 2)], coverage),
      { asset: 'SWORD', quote: KEI_ASSET, every: 1, fill: true },
    )

    expect(candles).toHaveLength(3)
    expect(coverageOf(candles)).toEqual(coverage)
  })

  test('empty and single-bucket fills stay small', () => {
    expect(toCandles([], { asset: 'SWORD', every: 1, fill: true })).toEqual([])
    expect(toCandles([sale('A', 1, 5, 123)], { asset: 'SWORD', every: 1, fill: true })).toHaveLength(1)
  })

  test('fill accepts its output boundary and refuses boundary plus one', () => {
    const candlesAt = (count: number) =>
      toCandles([sale('A', 1, 5, 0), sale('B', 1, 7, count - 1)], {
        asset: 'SWORD',
        quote: KEI_ASSET,
        every: 1,
        fill: true,
      })

    expect(candlesAt(DEFAULT_MAX_CANDLES - 1)).toHaveLength(DEFAULT_MAX_CANDLES - 1)
    expect(candlesAt(DEFAULT_MAX_CANDLES)).toHaveLength(DEFAULT_MAX_CANDLES)
    expect(caught(() => candlesAt(DEFAULT_MAX_CANDLES + 1))).toMatchObject({ code: 'too-many-candles' })
  })

  test('an explicit dense budget remains finite and validates before reading input', () => {
    const candlesAt = (count: number, maxCandles: number) =>
      toCandles([sale('A', 1, 5, 0), sale('B', 1, 7, count - 1)], {
        asset: 'SWORD',
        quote: KEI_ASSET,
        every: 1,
        fill: true,
        maxCandles,
      })

    expect(candlesAt(3, 3)).toHaveLength(3)
    expect(caught(() => candlesAt(4, 3))).toMatchObject({ code: 'too-many-candles' })
    expect(
      toCandles([], { asset: 'SWORD', every: 1, fill: true, maxCandles: MAX_CANDLES }),
    ).toEqual([])
    for (const maxCandles of [0, 0.5, Number.POSITIVE_INFINITY, MAX_CANDLES + 1]) {
      expect(caught(() => toCandles([], { asset: 'SWORD', every: 1, maxCandles }))).toMatchObject({
        code: 'bad-max-candles',
      })
    }
  })

  test('the former 60,001-object probe is projected and refused before dense filling', () => {
    const error = caught(() =>
      toCandles([sale('A', 1, 5, 0), sale('B', 1, 7, 60_000)], {
        asset: 'SWORD',
        quote: KEI_ASSET,
        every: 1,
        fill: true,
      }),
    )

    expect(error).toMatchObject({ code: 'too-many-candles' })
    expect(isMarketError(error, 'too-many-candles')).toBe(true)
    expect((error as Error).message).toContain('60001 candles')
    expect((error as Error).message).toContain('fill: false')
  })

  test('extreme safe timestamps cannot overflow the dense projection', () => {
    const error = caught(() =>
      toCandles(
        [sale('A', 1, 5, 0), sale('B', 1, 7, Number.MAX_SAFE_INTEGER)],
        { asset: 'SWORD', quote: KEI_ASSET, every: 1, fill: true },
      ),
    )

    expect(error).toMatchObject({ code: 'too-many-candles' })
    expect((error as Error).message).toContain('9007199254740992 candles')
  })

  test('every non-null advisory time is valid before sparse or filled sorting and bucketing', () => {
    const invalid = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.MIN_SAFE_INTEGER - 1,
    ]

    for (const fill of [false, true]) {
      for (const at of invalid) {
        const error = caught(() =>
          toCandles([sale('A', 1, 5, at)], {
            asset: 'SWORD',
            quote: KEI_ASSET,
            every: 1,
            fill,
          }),
        )
        expect(error).toMatchObject({ code: 'bad-candle-time' })
        expect(isMarketError(error, 'bad-candle-time')).toBe(true)
        expect((error as Error).message).toContain('non-negative safe whole number')
      }
    }
  })

  test('an invalid interior time cannot hide a billion-bucket gap from endpoint projection', () => {
    const error = caught(() =>
      toCandles(
        [sale('A', 1, 5, 0), sale('B', 1, 7, 1_000_000_000), sale('C', 1, 9, Number.NaN), sale('D', 1, 11, 1)],
        { asset: 'SWORD', quote: KEI_ASSET, every: 1, fill: true },
      ),
    )

    expect(error).toMatchObject({ code: 'bad-candle-time' })
  })

  test('a wholly missing advisory time is still dropped rather than drawn at the epoch', () => {
    const timeless = trade({
      hash: 'TIMELESS',
      give: leg('SWORD', 1),
      want: leg(KEI_ASSET, 5),
      settledAt: null,
      seenAt: null as unknown as number,
    })
    const candles = toCandles([timeless, sale('A', 1, 7, 1)], {
      asset: 'SWORD',
      quote: KEI_ASSET,
      every: 1,
      fill: true,
    })

    expect(candles).toHaveLength(1)
    expect(candles[0]?.at).toBe(1)
  })

  test('fill false stays sparse across a multi-year gap', () => {
    const decade = 10 * 365 * 24 * 60 * 60 * 1_000
    const candles = toCandles([sale('A', 1, 5, 0), sale('B', 1, 7, decade)], {
      asset: 'SWORD',
      quote: KEI_ASSET,
      every: 1,
      fill: false,
    })

    expect(candles).toHaveLength(2)
    expect(candles.map((candle) => candle.at)).toEqual([0, decade])
  })

  test('every must normalize to a positive safe integer before any input is bucketed', () => {
    const invalid: Duration[] = [0.5, '0.1ms', Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, `${'9'.repeat(400)}w`]

    for (const every of invalid) {
      const error = caught(() => toCandles([], { asset: 'SWORD', every, fill: true }))
      expect(error).toMatchObject({ code: 'bad-duration' })
      expect((error as Error).message).toContain('every')
    }
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
