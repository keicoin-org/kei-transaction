/** M4-only commit/claim flow. M2's native-node gate does not run this file. */

import { describe, expect, test } from 'bun:test'
import { randomSeed } from '@keicoin/core'
import { Kei } from 'kei-transaction'
import { httpNodeFactory } from './http-network.js'

describe('the deferred M4 commit/claim flow over HTTP', () => {
  test('a batch of drops is one issuer block and many player claims', async () => {
    const node = await httpNodeFactory()
    const game = await Kei.server({ seed: randomSeed(), node: node() })
    const players = await Promise.all([
      Kei.start({ seed: randomSeed(), node: node() }),
      Kei.start({ seed: randomSeed(), node: node() }),
      Kei.start({ seed: randomSeed(), node: node() }),
    ])
    await game.faucet(2_000)
    const coins = await game.token.issue({ name: 'Coins', symbol: 'COIN', decimals: 0 })
    const drop = await coins.commit(players.map((player, index) => ({ to: player.address, amount: 10 * (index + 1) })))
    expect((await game.client.node.commitInfo(drop.root))?.count).toBe(3)
    await Promise.all(players.map((player) => player.claims.add(drop.proofFor(player.address))))
    expect(await coins.balanceOf(players[0]!.address)).toBe(10)
    expect(await coins.balanceOf(players[1]!.address)).toBe(20)
    expect(await coins.balanceOf(players[2]!.address)).toBe(30)
    await expect(players[0]!.claims.claim(drop.proofFor(players[0]!.address))).rejects.toThrow()
    game.close()
    for (const player of players) player.close()
  }, 30_000)
})
