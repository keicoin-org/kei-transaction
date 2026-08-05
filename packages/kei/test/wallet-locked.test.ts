/**
 * Issue #43 — the wallet said "No items yet." to a player whose sword was on
 * the chain, locked in that player's own `swap_offer` (SPEC §9.2, §6.5).
 *
 * Every offer here is a real block on a real account chain, so what these tests
 * pin is the whole path: the ledger debits the offered asset into the lock, and
 * `wallet.summary()` still has to be able to say where it went and that it is
 * coming back on a cancel. `packages/wallet/test/locked.test.ts` pins the panel
 * over the same shape.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { Kei, randomSeed, type Item, type MockNode } from 'kei-transaction'

let node: MockNode
let game: Kei
let alice: Kei
let sword: Item

beforeEach(async () => {
  node = await Kei.mock()
  game = await Kei.server({ seed: 'C'.repeat(64), node })
  await game.faucet(20_000)
  alice = await Kei.start({ node, seed: randomSeed() })
  await game.send(alice.address, 2_000)
  await alice.sync()

  sword = await game.items.create({ name: 'Sword of Testing', description: 'It tests things.' })
  await game.items.mint(sword.id, alice.address)
  await alice.sync()
})

test('an item listed for sale is locked, not missing', async () => {
  const before = await alice.wallet.summary()
  expect(before.items.map((item) => item.asset)).toEqual([sword.id])
  expect(before.locked).toEqual([])

  const offer = await alice.market.sell({ asset: sword, price: 5 })
  const after = await alice.wallet.summary()

  // Off the holdings table, exactly as the ledger says — and still reported.
  expect(after.items).toEqual([])
  expect(after.locked).toHaveLength(1)
  expect(after.locked[0]).toMatchObject({
    asset: sword.id,
    name: 'Sword of Testing',
    amount: 1,
    item: true,
    reason: 'offer',
    offer: offer.hash,
  })
  expect(after.locked[0]?.want).toMatchObject({ symbol: 'KEI', amount: 5 })
})

test('cancelling the listing returns the item to the spendable half', async () => {
  const offer = await alice.market.sell({ asset: sword, price: 5 })
  await alice.market.cancel(offer)

  const summary = await alice.wallet.summary()

  expect(summary.items.map((item) => item.asset)).toEqual([sword.id])
  expect(summary.locked).toEqual([])
})

test('Kei locked in a bid is reported apart from spendable Kei', async () => {
  const before = await alice.wallet.summary()
  expect(before.keiLocked).toBe(0)

  await alice.market.bid({ asset: sword, price: 7 })
  const after = await alice.wallet.summary()

  // The balance dropped by exactly what the bid locked, and the difference is
  // now named rather than unaccounted for.
  expect(after.kei).toBe(before.kei - 7)
  expect(after.keiLocked).toBe(7)
  expect(after.kei + after.keiLocked).toBe(before.kei)
})

test('both halves of one offer are reported at once', async () => {
  const coin = await game.token.issue({ name: 'Coins', symbol: 'COIN', decimals: 0 })
  await coin.mint(alice.address, 100)
  await alice.sync()

  await alice.market.sell({ asset: sword, price: 5 })
  await alice.market.offer({ give: { asset: coin.id, amount: 40 }, want: { asset: sword.id, amount: 1 } })
  const summary = await alice.wallet.summary()

  const byAsset = new Map(summary.locked.map((holding) => [holding.asset, holding]))
  expect(summary.locked).toHaveLength(2)
  expect(byAsset.get(coin.id)).toMatchObject({ amount: 40, item: false })
  expect(byAsset.get(sword.id)).toMatchObject({ amount: 1, item: true })
  // The 60 still spendable and the 40 locked are both reported, and separately.
  expect(summary.tokens.map((token) => [token.asset, token.amount])).toEqual([[coin.id, 60]])
})

describe('the empty state', () => {
  test('belongs to an account that owns nothing at all', async () => {
    const bob = await Kei.start({ node, seed: randomSeed() })
    const summary = await bob.wallet.summary()

    expect(summary.items).toEqual([])
    expect(summary.locked).toEqual([])
    expect(summary.keiLocked).toBe(0)
  })

  test('is not what an account with everything listed looks like', async () => {
    await alice.market.sell({ asset: sword, price: 5 })
    const summary = await alice.wallet.summary()

    expect(summary.items.length + summary.locked.length).toBeGreaterThan(0)
  })
})
