/**
 * A drop batch across a process boundary.
 *
 * The same point as `economy-over-http.test.ts` before it: nothing here is a
 * shared object graph. The server and the browser hold the same frozen table
 * from the same file, the award travels as JSON — which is how it would reach a
 * browser, and how it will sit in local storage until the player logs back in —
 * and the check still means something at the other end.
 *
 * That is the property the digest buys. Everything the browser needs in order to
 * refuse a batch published for different odds arrives in that JSON, and none of
 * it has to be trusted, because the root it folds up to is the one the ledger
 * already accepted.
 */

import { describe, expect, test } from 'bun:test'
import { randomSeed } from '@keicoin/core'
import { Kei, defineDropTable, type DropAward } from 'kei-transaction'
import { httpNodeFactory } from './http-network.js'

describe('a drop table over HTTP (SPEC §5.5, §10.1)', () => {
  test('a batch rolled on the server is verified and claimed from a browser', async () => {
    const node = await httpNodeFactory()
    const game = await Kei.server({ seed: randomSeed(), node: node() })
    await game.faucet(2_000)

    const gold = await game.token.issue({ name: 'Gold', symbol: 'GOLD', decimals: 0 })
    const relic = await game.items.create({ name: 'Relic of Testing', supply: 10 })

    // The one thing the two halves share: a declaration neither can edit.
    const hoard = defineDropTable({
      id: 'dragon-hoard',
      name: 'The dragon hoard',
      drops: [
        { asset: { symbol: 'GOLD' }, amount: 50, weight: 70 },
        { asset: { id: relic.id }, weight: 5 },
      ],
      nothing: 25,
      issuer: game.address,
    })

    const alice = await Kei.start({ seed: randomSeed(), node: node(), tables: [hoard] })
    const bob = await Kei.start({ seed: randomSeed(), node: node(), tables: [hoard] })

    const party = [alice.address, bob.address]
    const values = [0.1, 0.72] // gold for alice, the relic for bob
    let index = 0
    const drop = await game.economy.drop(hoard, party, { random: () => values[index++] as number })

    // Two assets rolled, so two issuer blocks — and that is the whole issuer
    // write, whether the party is two players or two thousand (SPEC §5.5).
    expect(drop.roots).toHaveLength(2)
    expect(drop.awarded).toBe(2)

    for (const [who, expected] of [
      [alice, { symbol: 'GOLD', quantity: 50 }],
      [bob, { symbol: relic.symbol, quantity: 1 }],
    ] as const) {
      // Through JSON, because that is how it reaches a browser.
      const award = JSON.parse(JSON.stringify(drop.awardFor(who.address))) as DropAward

      const verified = await who.economy.verifyDrop(award)
      expect(verified.symbol).toBe(expected.symbol)
      expect(verified.quantity).toBe(expected.quantity)
      expect(verified.table.digest).toBe(hoard.digest)

      await who.claims.add(award)
    }

    expect(await gold.balanceOf(alice.address)).toBe(50)
    expect((await bob.items.ownedBy()).map((item) => item.name)).toEqual(['Relic of Testing'])

    // And once everybody has claimed, the roots can be closed so the batch stops
    // being permanent state on every node (SPEC §5.5).
    const closed = await drop.close()
    expect(closed.closed).toHaveLength(2)
    expect(closed.unclaimed).toEqual([])

    alice.close()
    bob.close()
    game.close()
  })
})
