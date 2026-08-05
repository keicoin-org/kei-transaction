/**
 * A node that did not answer is not a wallet that owns nothing.
 *
 * `shop.funds()` degrades a failed read to zeros so a purse redrawing on a poll
 * shows a visible blank rather than an unhandled rejection. That is right for a
 * view. It was also the precondition check for every write in the package, so a
 * five-second node hiccup made `shop.list()` say "You have 0 Iron Sword to
 * list, not 1" to a player looking at three of them — a confident, specific,
 * checkable claim that nobody had measured (SPEC §6.1).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  Kei,
  createDirectory,
  randomSeed,
  type IssuerToken,
  type Item,
  type KeiNode,
  type MockNode,
  type MutableDirectory,
} from 'kei-transaction'

let node: MockNode
let game: Kei
let gold: IssuerToken
let sword: Item
let directory: MutableDirectory
const opened: Kei[] = []

/** A node whose balance reads stop answering the moment a test says so. */
function hiccupping(base: KeiNode, state: { down: boolean }): KeiNode {
  // Async, because a real node client rejects rather than throwing on the
  // caller's stack: a synchronous throw here would orphan the sibling read
  // `chainFunds` starts alongside it and surface as an unhandled rejection.
  const refuse = async (): Promise<never> => {
    throw new Error('The node at https://testnet.example/rpc did not answer "holder_balance" (502).')
  }
  return new Proxy(base, {
    get: (target, property, receiver) => {
      if (state.down && (property === 'holderBalance' || property === 'accountInfo' || property === 'receivables')) {
        return refuse
      }
      return Reflect.get(target, property, receiver)
    },
  }) as unknown as KeiNode
}

const world = () => ({
  currency: gold.id,
  catalogue: [{ key: 'sword', asset: sword.id, title: 'Iron Sword' }],
  directory,
})

beforeEach(async () => {
  opened.length = 0
  node = await Kei.mock()
  directory = createDirectory()
  game = await Kei.server({ seed: randomSeed(), node })
  await game.faucet(50_000)
  gold = await game.token.issue({ name: 'Gold', symbol: 'GOLD', decimals: 0, maxSupply: 1_000_000 })
  sword = await game.items.create({ name: 'Iron Sword', supply: 1_000 })
})

afterEach(() => {
  for (const wallet of opened) wallet.close()
})

/** A player holding three swords and some gold, against a node that can break. */
async function playerWithSwords(state: { down: boolean }): Promise<Kei> {
  const swords = await game.items.token(sword.id)
  const alice = await Kei.start({
    node: hiccupping(node, state),
    seed: randomSeed(),
    autoCancelExpired: false,
    autoReceive: false,
    shop: world(),
  })
  opened.push(game, alice)
  await game.send(alice.address, 100)
  await gold.mint(alice.address, 500)
  await swords.mint(alice.address, 3)
  directory.watch(alice.address)
  await alice.sync()
  return alice
}

describe('a shop whose node stopped answering', () => {
  test('funds() still degrades to zeros, and says the read failed', async () => {
    const state = { down: false }
    const alice = await playerWithSwords(state)

    const held = await alice.shop.funds('sword')
    expect(held.spendable).toBe(3)
    expect(held.read).toBe('ok')

    state.down = true
    const blanked = await alice.shop.funds('sword')
    // The degradation stays: a view polling this must not get a rejection.
    expect(blanked.spendable).toBe(0)
    expect(blanked.read).toBe('failed')
  })

  test('list() names the node rather than the balance', async () => {
    const state = { down: false }
    const alice = await playerWithSwords(state)
    state.down = true

    const failure = await alice.shop.list({ item: 'sword', each: 120 }).then(
      () => {
        throw new Error('expected shop.list() to refuse')
      },
      (error: Error & { code?: string }) => error,
    )

    expect(failure.code).toBe('funds-unreadable')
    expect(failure.message).toContain('could not be read')
    expect(failure.message).toContain('did not answer')
    // The lie: a sentence asserting how many swords this wallet holds.
    expect(failure.message).not.toContain('You have 0 Iron Sword')
  })

  test('gift() refuses the same way, for Kei and for an item', async () => {
    const state = { down: false }
    const alice = await playerWithSwords(state)
    const elsewhere = await Kei.start({ node, seed: randomSeed() })
    opened.push(elsewhere)
    state.down = true

    await expect(alice.shop.gift({ to: elsewhere.address, kei: 0.5 })).rejects.toThrow(/could not be read/)
    await expect(alice.shop.gift({ to: elsewhere.address, item: 'sword' })).rejects.toThrow(/could not be read/)
  })

  test('a wallet that really holds none still hears about the wallet', async () => {
    const state = { down: false }
    const alice = await playerWithSwords(state)
    const elsewhere = await Kei.start({ node, seed: randomSeed() })
    opened.push(elsewhere)

    // Nothing is wrong with the node here, so the refusal is about the goods.
    await expect(alice.shop.gift({ to: elsewhere.address, item: 'sword', amount: 99 })).rejects.toThrow(
      /You have 3 Iron Sword to give, not 99/,
    )
  })
})
