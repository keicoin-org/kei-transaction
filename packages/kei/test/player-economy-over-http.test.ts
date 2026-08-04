/**
 * Two player shops between clients that share nothing but a URL.
 *
 * The mock tests next door share a `MockNode` object, which means they share a
 * process. This one runs the same flow over RPC — the transport a real game
 * uses — so `account_swaps`, `swap_info`, and `holder_balance` are exercised as
 * wire actions rather than as method calls, and the directory is the only thing
 * the two browsers have in common.
 *
 * The world's server is deliberately absent from every step below. It is not a
 * counterparty, it holds no float, and there is no request it could refuse that
 * would stop any of this.
 */

import { describe, expect, test } from 'bun:test'
import { Kei, createDirectory, randomSeed } from 'kei-transaction'
import { httpNodeFactory } from './http-network.js'

describe('player shops over HTTP — no server in the middle (SPEC §9)', () => {
  test('two stalls, a purchase, a gift, and price history, all over the wire', async () => {
    const node = await httpNodeFactory()
    const game = await Kei.server({ seed: randomSeed(), node: node() })
    await game.faucet(20_000)

    const gold = await game.token.issue({ name: 'Gold', symbol: 'GOLD', decimals: 0 })
    const sword = await game.items.create({ name: 'Iron Sword', supply: 100 })
    const potion = await game.items.create({ name: 'Healing Potion', supply: 100 })

    // What a world hands a browser: a currency, a catalogue, and somewhere to
    // find out which chains are worth reading. Nothing here is a credential.
    const directory = createDirectory()
    const shop = {
      currency: gold.id,
      catalogue: [
        { key: 'sword', asset: sword.id, title: 'Iron Sword' },
        { key: 'potion', asset: potion.id, title: 'Healing Potion' },
      ],
      directory,
    }

    const alice = await Kei.start({ seed: randomSeed(), node: node(), shop })
    const bob = await Kei.start({ seed: randomSeed(), node: node(), shop })

    for (const player of [alice, bob]) {
      await game.send(player.address, 50)
      await gold.mint(player.address, 400)
    }
    await (await game.items.token(sword.id)).mint(alice.address, 3)
    await (await game.items.token(potion.id)).mint(bob.address, 6)
    await Promise.all([alice.sync(), bob.sync()])

    // Two stalls. Listing announces the seller, so the directory fills itself.
    await alice.shop.list({ item: 'sword', each: 120 })
    await bob.shop.list({ item: 'potion', qty: 3, each: 15 })
    expect(directory.accounts()).toHaveLength(2)

    const shelves = await bob.shop.browse()
    expect(shelves.shelves).toHaveLength(2)
    expect(shelves.coverage.complete).toBe(true)

    const swordRow = shelves.listings.find((listing) => listing.key === 'sword')
    expect(swordRow?.each).toBe(120)

    // One block, both legs or neither, and the terms are checked against the
    // chain immediately before it is signed.
    const purchase = await bob.shop.buy(swordRow!)
    expect(purchase.received.qty).toBe(1)
    expect(purchase.paid.amount).toBe(120)

    await Promise.all([alice.shop.sync(), bob.shop.sync()])
    expect((await alice.shop.funds()).confirmed).toBe(520)
    expect((await bob.shop.funds()).confirmed).toBe(280)
    expect((await bob.shop.funds('sword')).confirmed).toBe(1)

    // A gift needs no offer, no accept, and no price.
    await bob.shop.gift({ to: alice.address, item: 'potion', amount: 2 })
    await alice.shop.sync()
    expect((await alice.shop.funds('potion')).confirmed).toBe(2)

    // And the sale is readable as price history by anybody with the same list
    // of accounts, without asking the world's server anything.
    const series = await alice.shop.history({ item: 'sword' })
    expect(series.points.map((point) => point.price)).toEqual([120])
    expect(series.summary?.median).toBe(120)

    game.close()
    alice.close()
    bob.close()
  }, 60_000)

  test('a listing is cancelled, and the goods come back to the seller', async () => {
    const node = await httpNodeFactory()
    const game = await Kei.server({ seed: randomSeed(), node: node() })
    await game.faucet(20_000)
    const gold = await game.token.issue({ name: 'Gold', symbol: 'GOLD', decimals: 0 })
    const sword = await game.items.create({ name: 'Iron Sword', supply: 100 })

    const alice = await Kei.start({
      seed: randomSeed(),
      node: node(),
      autoCancelExpired: false,
      shop: { currency: gold.id, catalogue: [{ key: 'sword', asset: sword.id, title: 'Iron Sword' }] },
    })
    await game.send(alice.address, 50)
    await (await game.items.token(sword.id)).mint(alice.address, 2)
    await alice.sync()

    const listing = await alice.shop.list({ item: 'sword', qty: 2, each: 50 })
    expect((await alice.shop.funds('sword')).confirmed).toBe(0)

    await alice.shop.cancel(listing)
    expect((await alice.shop.funds('sword')).confirmed).toBe(2)
    expect(await alice.shop.mine()).toHaveLength(0)

    game.close()
    alice.close()
  }, 60_000)

  test('a wrong directory hides a stall and cannot move an item', async () => {
    const node = await httpNodeFactory()
    const game = await Kei.server({ seed: randomSeed(), node: node() })
    await game.faucet(20_000)
    const gold = await game.token.issue({ name: 'Gold', symbol: 'GOLD', decimals: 0 })
    const sword = await game.items.create({ name: 'Iron Sword', supply: 100 })
    const catalogue = [{ key: 'sword', asset: sword.id, title: 'Iron Sword' }]

    const alice = await Kei.start({
      seed: randomSeed(),
      node: node(),
      shop: { currency: gold.id, catalogue, directory: createDirectory(), announce: false },
    })
    // A directory that names an account with nothing on it, and not the one
    // that is actually selling. The worst it can do is show an empty hall.
    const liar = createDirectory({ accounts: [game.address] })
    const bob = await Kei.start({
      seed: randomSeed(),
      node: node(),
      shop: { currency: gold.id, catalogue, directory: liar },
    })

    await game.send(alice.address, 50)
    await gold.mint(bob.address, 400)
    await (await game.items.token(sword.id)).mint(alice.address, 1)
    await Promise.all([alice.sync(), bob.sync()])

    const hidden = await alice.shop.list({ item: 'sword', each: 10 })
    expect((await bob.shop.browse()).listings).toHaveLength(0)

    // The sword is still alice's, still locked by the ledger, and still bought
    // by hash the moment anybody learns of it from anywhere at all.
    const found = await bob.shop.buy(hidden.hash)
    expect(found.paid.amount).toBe(10)

    game.close()
    alice.close()
    bob.close()
  }, 60_000)
})
