/** M5-only market flow. Neither M2's nor M4's native-node gate runs this file. */

import { describe, expect, test } from 'bun:test'
import { randomSeed } from '@keicoin/core'
import { Kei } from 'kei-transaction'
import { httpNodeFactory } from './http-network.js'

/**
 * A mint reaches its recipient through auto-receive, which is a poll rather than
 * a promise the caller can await. Against the mock that lands almost at once;
 * against a node it is a confirmation away, so the balance is read until it
 * settles instead of once and hopefully.
 */
async function settlesAt(read: () => Promise<number>, expected: number, within = 20_000): Promise<number> {
  const deadline = Date.now() + within
  let last = await read()
  while (last !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    last = await read()
  }
  return last
}

describe('the M5 market over HTTP', () => {
  test('an offer locks the seller\'s own asset and one accept moves both legs', async () => {
    const node = await httpNodeFactory()
    const game = await Kei.server({ seed: randomSeed(), node: node() })
    const seller = await Kei.start({ seed: randomSeed(), node: node() })
    const buyer = await Kei.start({ seed: randomSeed(), node: node() })

    await game.faucet(2_000)
    await buyer.faucet(200)
    const gems = await game.token.issue({ name: 'Gems', symbol: 'GEM', decimals: 0 })
    await gems.mint(seller.address, 10)
    expect(await settlesAt(() => gems.balanceOf(seller.address), 10)).toBe(10)

    const offer = await seller.market.sell({ asset: gems.id, amount: 4, price: 5 })
    expect(offer.hash).toMatch(/^[0-9A-F]{64}$/)
    expect(offer.give.amount).toBe(4)
    expect(offer.from).toBe(seller.address)

    // Read back through the node rather than trusting the object we just built:
    // the offer is a block, and this is the only proof it was accepted as one.
    const stored = await seller.client.node.swapOffer(offer.hash)
    expect(stored?.hash).toBe(offer.hash)

    // The lock is real, so the four on offer are no longer the seller's to spend.
    await expect(seller.market.sell({ asset: gems.id, amount: 7, price: 5 })).rejects.toThrow()

    await buyer.market.accept(offer)
    expect(await settlesAt(() => gems.balanceOf(buyer.address), 4)).toBe(4)
    expect(await gems.balanceOf(seller.address)).toBe(6)

    game.close()
    seller.close()
    buyer.close()
  }, 60_000)
})
