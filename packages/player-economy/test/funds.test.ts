/**
 * Three balances, and the arithmetic that keeps them apart.
 *
 * No network here on purpose: this is the part of a shop that decides whether a
 * button works, and getting it wrong shows up as "the ledger says balance is 0"
 * in front of a player. It is arithmetic, so it is tested as arithmetic.
 */

import { describe, expect, test } from 'bun:test'
import { KEI_ASSET, KEI_DECIMALS } from '@keicoin/core'
import { canSpend, committedRaw, movingRaw, toFunds, type Pending } from '@keicoin/player-economy'

const KEI = 10n ** BigInt(KEI_DECIMALS)

function pending(
  overrides: Omit<Partial<Pending>, 'moves'> & { moves: Iterable<readonly [string, bigint]> },
): Pending {
  return {
    id: 1,
    kind: 'buy',
    what: 'something',
    state: 'signing',
    hash: null,
    startedAt: 0,
    ...overrides,
    moves: new Map(overrides.moves),
  }
}

const funds = (
  chain: { confirmedRaw?: bigint; incomingRaw?: bigint; arrivals?: number },
  held: Pending[] = [],
) =>
  toFunds({
    asset: KEI_ASSET,
    symbol: 'KEI',
    decimals: KEI_DECIMALS,
    chain: { confirmedRaw: 0n, incomingRaw: 0n, arrivals: 0, ...chain },
    pending: held,
  })

describe('the three balances (SPEC §5.6.3)', () => {
  test('confirmed is the only one a spend is checked against', () => {
    const purse = funds({ confirmedRaw: 4n * KEI, incomingRaw: 100n * KEI, arrivals: 2 })
    expect(purse.confirmed).toBe(4)
    expect(purse.incoming).toBe(100)
    expect(purse.spendable).toBe(4)
    // The hundred that is owed does not fund a spend. That is the whole point.
    expect(canSpend(purse, 5n * KEI)).toBe(false)
    expect(canSpend(purse, 4n * KEI)).toBe(true)
  })

  test('a signed spend is a debt from the moment it is signed', () => {
    const purse = funds({ confirmedRaw: 10n * KEI }, [pending({ moves: [[KEI_ASSET, -6n * KEI]] })])
    expect(purse.committed).toBe(6)
    expect(purse.spendable).toBe(4)
    // Two actions in the same second cannot each be checked against the same
    // coins, which is the failure this exists to prevent.
    expect(canSpend(purse, 6n * KEI)).toBe(false)
  })

  test('credits in flight are never netted off a spend, only into the projection', () => {
    const purse = funds({ confirmedRaw: 1n * KEI }, [pending({ moves: [[KEI_ASSET, 50n * KEI]] })])
    expect(purse.spendable).toBe(1)
    expect(purse.projected).toBe(51)
  })

  test('projected is what the balance becomes if everything lands', () => {
    const purse = funds({ confirmedRaw: 10n * KEI, incomingRaw: 5n * KEI, arrivals: 1 }, [
      pending({ moves: [[KEI_ASSET, -3n * KEI]] }),
    ])
    expect(purse.projected).toBe(12)
    expect(purse.settling).toBe(true)
  })

  test('spendable floors at zero rather than going negative', () => {
    const purse = funds({ confirmedRaw: 1n * KEI }, [pending({ moves: [[KEI_ASSET, -9n * KEI]] })])
    expect(purse.spendableRaw).toBe(0n)
    expect(purse.spendable).toBe(0)
  })

  test('a finished entry stops being a debt', () => {
    const settled = pending({ state: 'settled', moves: [[KEI_ASSET, -6n * KEI]] })
    const failed = pending({ id: 2, state: 'failed', moves: [[KEI_ASSET, -2n * KEI]] })
    const purse = funds({ confirmedRaw: 10n * KEI }, [settled, failed])
    expect(purse.committedRaw).toBe(0n)
    expect(purse.spendable).toBe(10)
    expect(purse.settling).toBe(false)
  })

  test('committed and moving count different things', () => {
    const held = [
      pending({ moves: [[KEI_ASSET, -3n * KEI]] }),
      pending({ id: 2, moves: [[KEI_ASSET, 8n * KEI]] }),
    ]
    expect(committedRaw(held, KEI_ASSET)).toBe(3n * KEI)
    expect(movingRaw(held, KEI_ASSET)).toBe(5n * KEI)
  })

  test('raw travels beside the number, because a double cannot hold 18 places', () => {
    const dust = 1n
    const purse = funds({ confirmedRaw: 12n * KEI + dust })
    expect(purse.confirmedRaw).toBe(12n * KEI + dust)
    // The number rounds. The raw does not, and the raw is what a spend uses.
    expect(canSpend(purse, 12n * KEI + dust)).toBe(true)
    expect(canSpend(purse, 12n * KEI + dust + 1n)).toBe(false)
  })

  test('one asset does not see another asset\'s pending', () => {
    const purse = toFunds({
      asset: 'GOLD',
      symbol: 'GOLD',
      decimals: 0,
      chain: { confirmedRaw: 100n, incomingRaw: 0n, arrivals: 0 },
      pending: [pending({ moves: [[KEI_ASSET, -5n * KEI]] })],
    })
    expect(purse.committedRaw).toBe(0n)
    expect(purse.spendable).toBe(100)
  })
})
