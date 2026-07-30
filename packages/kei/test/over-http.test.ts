/**
 * The whole SDK, over the wire.
 *
 * Every other test shares one `MockNode` object between clients, which no real
 * deployment can do: SPEC §6.3 puts the player in a browser and the issuer on a
 * server, so they are always two processes. This runs the same economy with
 * nothing shared but a URL — the arrangement "Button" actually uses, and the
 * rehearsal for M3, where only the thing behind the URL changes.
 */

import { describe, expect, test } from 'bun:test'
import { HttpNode, MockNode, mockRpcHandler, randomSeed } from '@kei/core'
import { Kei } from 'kei-transaction'

/** One node, reachable only by URL. Every client here is a separate process's worth of state. */
async function network(): Promise<() => HttpNode> {
  const handler = mockRpcHandler({ node: await MockNode.create() })
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) =>
    handler(new Request(String(url), init))) as unknown as typeof globalThis.fetch

  return () => new HttpNode({ url: 'http://node.test/rpc', network: 'mock', pollInterval: 5, fetch: fetchImpl })
}

describe('an issuer and a player who share only a URL', () => {
  test('the full loop: issue, top up, mint, transfer, and an item', async () => {
    const node = await network()

    const game = await Kei.server({ seed: randomSeed(), node: node() })
    const player = await Kei.start({ seed: randomSeed(), node: node() })

    await game.faucet(2_000)
    const coins = await game.token.issue({
      name: 'Coins',
      symbol: 'COIN',
      decimals: 0,
      maxSupply: 1_000_000,
      transfer: 'open',
      swap: 'one-way',
      rate: 1_000,
    })
    expect(coins.symbol).toBe('COIN')

    // The purchase: two signed halves, coordinated by nothing but the chain.
    const paid = new Promise<void>((resolve) => {
      const stop = game.onPayment(async ({ from, amount }) => {
        await coins.mint(from, amount * 1_000)
        stop()
        resolve()
      })
    })
    await player.faucet(1)
    await player.pay({ to: game.address, amount: 0.05, memo: 'starter pack' })
    await paid

    // Minted coins arrive receivable, like everything else (SPEC §5.6.3). The
    // background collector gets there on its own; sync() just removes the race.
    await player.sync()
    expect(await coins.balanceOf(player.address)).toBe(50)

    // The player reads the same token by symbol, from the issuer's address.
    const held = await player.token('COIN', game.address)
    expect(await held.balance()).toBe(50)

    // And spends it back — player-signed, no `from` argument.
    await held.transfer(game.address, 20)
    await game.sync()
    expect(await coins.balanceOf(game.address)).toBe(20)
    expect(await coins.balanceOf(player.address)).toBe(30)

    // An item, delivered the same way.
    const badge = await game.items.create({ name: 'First Press', description: 'You pressed it.' })
    await game.items.mint(badge.id, player.address)
    await player.sync()
    expect(await player.items.owner(badge.id)).toBe(player.address)
    expect((await player.items.ownedBy()).map((item) => item.name)).toContain('First Press')

    game.close()
    player.close()
  }, 30_000)

  test('a batch of drops is one issuer block and many player claims', async () => {
    const node = await network()

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

    // Each player claims from their own chain, in parallel, off one root.
    await Promise.all(players.map((player) => player.claims.add(drop.proofFor(player.address))))

    expect(await coins.balanceOf(players[0]!.address)).toBe(10)
    expect(await coins.balanceOf(players[1]!.address)).toBe(20)
    expect(await coins.balanceOf(players[2]!.address)).toBe(30)

    // A second claim against the same root is the ledger's rejection, not the SDK's.
    await expect(players[0]!.claims.claim(drop.proofFor(players[0]!.address))).rejects.toThrow()

    game.close()
    for (const player of players) player.close()
  }, 30_000)

  test('a node that is not there says which URL it tried', async () => {
    const dead = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch

    await expect(
      Kei.start({ seed: randomSeed(), node: new HttpNode({ url: 'http://127.0.0.1:9/rpc', fetch: dead }) }),
    ).rejects.toThrow(/Could not reach the Kei node at http:\/\/127\.0\.0\.1:9\/rpc/)
  })
})
