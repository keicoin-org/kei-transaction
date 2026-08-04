/**
 * The recipe layer across a process boundary.
 *
 * The point of this file is the same as `market-over-http.test.ts` and
 * `over-http.test.ts` before it (decisions-m1.md §1): nothing in the recipe
 * layer is a shared object graph. The server and the browser hold the same
 * frozen recipe and nothing else — no session, no order id, no pending state —
 * and the shop still works when the only thing between them is a URL.
 */

import { describe, expect, test } from 'bun:test'
import { randomSeed } from '@keicoin/core'
import { Kei, defineRecipe } from 'kei-transaction'
import { httpNodeFactory } from './http-network.js'

describe('an economy over HTTP (SPEC §9.2, §10.1)', () => {
  test('a shop stocked on one client is bought from another, atomically', async () => {
    const node = await httpNodeFactory()
    const game = await Kei.server({ seed: randomSeed(), node: node() })
    const player = await Kei.start({ seed: randomSeed(), node: node() })

    await game.faucet(2_000)
    await game.send(player.address, 100)
    await player.sync()

    const scrap = await game.token.issue({ name: 'Scrap', symbol: 'SCRAP', decimals: 0 })
    await game.token.issue({ name: 'Gems', symbol: 'GEM', decimals: 0 })
    await scrap.mint(player.address, 100)
    await player.sync()

    // The one thing the two halves share: a declaration, by symbol and issuer,
    // that neither of them can edit.
    const forge = defineRecipe({
      id: 'forge',
      costs: [{ asset: { symbol: 'SCRAP' }, amount: 30 }],
      grants: [{ asset: { symbol: 'GEM' }, amount: 1 }],
      issuer: game.address,
    })

    expect((await player.economy.plan(forge)).ok).toBe(false)
    await game.economy.stock(forge, { count: 2, mint: true })

    const ready = await player.economy.plan(forge)
    expect(ready.ok).toBe(true)
    expect(ready.atomic).toBe(true)

    const result = await player.economy.run(forge)
    expect(result.settlement?.received.symbol).toBe('GEM')
    expect(result.settlement?.paid.amount).toBe(30)

    await Promise.all([player.sync(), game.sync()])
    const gemToken = await player.token('GEM', game.address)
    expect(await gemToken.balance()).toBe(1)
    expect(await scrap.balanceOf(player.address)).toBe(70)
    expect(await scrap.balanceOf(game.address)).toBe(30)
    expect(await player.economy.listings(forge)).toHaveLength(1)

    game.close()
    player.close()
  }, 30_000)

  test('a reward and a sink, each written by the one account that may write it', async () => {
    const node = await httpNodeFactory()
    const game = await Kei.server({ seed: randomSeed(), node: node() })
    const player = await Kei.start({ seed: randomSeed(), node: node() })

    await game.faucet(2_000)
    const gold = await game.token.issue({ name: 'Gold', symbol: 'GOLD', decimals: 0 })

    const questReward = defineRecipe({ id: 'quest', grants: [{ asset: { symbol: 'GOLD' }, amount: 250 }] })
    const repair = defineRecipe({ id: 'repair', costs: [{ asset: { symbol: 'GOLD', issuer: game.address }, amount: 40 }] })

    await game.economy.run(questReward, { player: player.address })
    await player.sync()
    expect(await gold.balanceOf(player.address)).toBe(250)

    // The issuer cannot run the sink for the player, over HTTP or otherwise.
    await expect(game.economy.run(repair, { player: player.address })).rejects.toThrow(
      /signs only for its own account/,
    )

    await player.economy.run(repair)
    expect(await gold.balanceOf(player.address)).toBe(210)
    expect(await gold.supply()).toBe(210)

    game.close()
    player.close()
  }, 30_000)
})
