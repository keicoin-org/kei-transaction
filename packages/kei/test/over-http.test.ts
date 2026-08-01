/**
 * The exact M2 SDK economy over HTTP. With no environment variable it uses
 * MockNode; with KEI_NODE_URL the same source and assertions use the native
 * node. Commit/claim is intentionally isolated in m4-over-http.test.ts.
 */

import { describe, expect, test } from 'bun:test'
import { HttpNode, randomSeed } from '@keicoin/core'
import { Kei } from 'kei-transaction'
import { httpNodeFactory } from './http-network.js'

describe('an M2 issuer and player who share only a URL', () => {
  test('the full loop: issue, top up, mint, transfer, and an item', async () => {
    const node = await httpNodeFactory()
    const game = await Kei.server({ seed: randomSeed(), node: node() })
    const player = await Kei.start({ seed: randomSeed(), node: node() })

    await game.faucet(2_000)
    const coins = await game.token.issue({
      name: 'Coins', symbol: 'COIN', decimals: 0, maxSupply: 1_000_000,
      transfer: 'open', swap: 'one-way', rate: 1_000,
    })
    expect(coins.symbol).toBe('COIN')

    const paid = new Promise<void>((resolve) => {
      const stop = game.onPayment(async ({ from, amount }) => {
        await coins.mint(from, amount * 1_000)
        stop()
        resolve()
      })
    })
    await player.faucet(1)
    await player.pay({ to: game.address, amount: 0.05 })
    await paid

    await player.sync()
    expect(await coins.balanceOf(player.address)).toBe(50)
    const held = await player.token('COIN', game.address)
    expect(await held.balance()).toBe(50)

    await held.transfer(game.address, 20)
    await game.sync()
    expect(await coins.balanceOf(game.address)).toBe(20)
    expect(await coins.balanceOf(player.address)).toBe(30)

    const badge = await game.items.create({ name: 'First Press', description: 'You pressed it.' })
    await game.items.mint(badge.id, player.address)
    await player.sync()
    expect(await player.items.owner(badge.id)).toBe(player.address)
    expect((await player.items.ownedBy()).map((item) => item.name)).toContain('First Press')

    game.close()
    player.close()
  }, 120_000)

  test('a node that is not there says which URL it tried', async () => {
    const dead = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch
    await expect(
      Kei.start({ seed: randomSeed(), node: new HttpNode({ url: 'http://127.0.0.1:9/rpc', fetch: dead }) }),
    ).rejects.toThrow(/Could not reach the Kei node at http:\/\/127\.0\.0\.1:9\/rpc/)
  })
})
