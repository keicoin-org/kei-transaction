/**
 * The M5 rehearsal: the whole market — list, settle, read price history — runs
 * between clients that share nothing but a URL, the same proof M1 ran for the
 * base economy (decisions-m1.md §1). docs/rpc.md's `swap_info` and
 * `account_swaps` are exercised here as wire actions, not just as MockNode calls.
 */

import { describe, expect, test } from 'bun:test'
import { randomSeed } from '@keicoin/core'
import { Kei } from 'kei-transaction'
import { httpNodeFactory } from './http-network.js'

describe('the market over HTTP — no server, no database (SPEC §9)', () => {
  test('a sale, settled atomically, with the price it sold for readable straight from the chain', async () => {
    const node = await httpNodeFactory()
    const game = await Kei.server({ seed: randomSeed(), node: node() })
    const seller = await Kei.start({ seed: randomSeed(), node: node() })
    const buyer = await Kei.start({ seed: randomSeed(), node: node() })

    await game.faucet(2_000)
    await game.send(seller.address, 100)
    await game.send(buyer.address, 100)
    await Promise.all([seller.sync(), buyer.sync()])

    const trinket = await game.items.create({ name: 'HTTP Trinket' })
    await game.items.mint(trinket.id, seller.address)
    await seller.sync()

    const offer = await seller.market.sell({ asset: trinket, price: 7 })
    await buyer.market.accept(offer)
    await seller.sync()

    expect(await buyer.items.owner(trinket.id)).toBe(buyer.address)
    expect(await seller.balance()).toBe(100 + 7)

    const price = await seller.market.medianPrice(trinket)
    expect(price).toBe(7)

    game.close()
    seller.close()
    buyer.close()
  }, 30_000)

  test('the lock is the ledger\'s, so the same units cannot be offered twice', async () => {
    const node = await httpNodeFactory()
    const game = await Kei.server({ seed: randomSeed(), node: node() })
    const seller = await Kei.start({ seed: randomSeed(), node: node(), autoCancelExpired: false })
    await game.faucet(2_000)
    await game.send(seller.address, 100)
    await seller.sync()

    const gems = await game.token.issue({ name: 'Gems', symbol: 'GEM', decimals: 0 })
    await gems.mint(seller.address, 10)
    await seller.sync()

    const offer = await seller.market.sell({ asset: gems.id, amount: 4, price: 5 })
    // Read it back as a block. Everything else here would still pass if `sell()`
    // had only built one and the node had refused it.
    expect((await seller.client.node.swapOffer(offer.hash))?.hash).toBe(offer.hash)

    // Six are left, so seven is one more than exists to offer. If the lock lived
    // in the SDK rather than the ledger, this is where that would show.
    await expect(seller.market.sell({ asset: gems.id, amount: 7, price: 5 })).rejects.toThrow()

    game.close()
    seller.close()
  }, 30_000)

  test('an unaccepted offer cancels back to its owner over the wire', async () => {
    const node = await httpNodeFactory()
    const game = await Kei.server({ seed: randomSeed(), node: node() })
    const seller = await Kei.start({ seed: randomSeed(), node: node(), autoCancelExpired: false })
    await game.faucet(2_000)
    await game.send(seller.address, 100)
    await seller.sync()

    const trinket = await game.items.create({ name: 'HTTP Trinket Two' })
    await game.items.mint(trinket.id, seller.address)
    await seller.sync()

    const offer = await seller.market.sell({ asset: trinket, price: 3 })
    await seller.market.cancel(offer)
    expect(await seller.items.owner(trinket.id)).toBe(seller.address)

    game.close()
    seller.close()
  }, 30_000)
})
