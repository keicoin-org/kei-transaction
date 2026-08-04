/**
 * Precision at the edges of a JS number (SPEC §6.1's plain-number API meets
 * 18-decimal raw integers).
 *
 * The public API speaks decimal numbers, and every display field may round —
 * that is the deal §6.1 struck. What must never round is anything that gets
 * *signed*: the ledger checks every balance delta exactly (`requireDelta`),
 * so a block built from a display value that lost precision is not "slightly
 * off", it is refused — and if the SDK cannot rebuild the exact raw, the
 * asset it was trying to move is stuck. `accept()` learned this and signs the
 * offer's own raw strings; this suite holds every other write path to the
 * same rule, with amounts chosen so that display rounding is guaranteed:
 * string amounts are accepted API surface (`price: number | string`), so
 * every case here is reachable by a caller.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { KEI_ASSET, type AssetId } from '@keicoin/core'

import { World, evidence, type Actor } from './harness/world.js'

let world: World
let alice: Actor
let bob: Actor
let sword: AssetId

beforeEach(async () => {
  world = await World.create()
  alice = await world.actor('alice')
  bob = await world.actor('bob')
  sword = await world.issue({ symbol: 'SWORD' })
  await world.mint(sword, alice, 10)
})

afterEach(() => {
  world.close()
})

/** 1 Kei plus one raw unit: displays as 1, exists as 10^18 + 1. */
const DUST_KEI = '1.000000000000000001'
const DUST_RAW = 10n ** 18n + 1n

describe('a locked Kei amount survives the round trip exactly', () => {
  test('a bid whose Kei does not fit a double can still be cancelled', async () => {
    const before = await world.keiRaw(bob.address)
    const offer = await bob.market.bid({ asset: sword, amount: 1, price: DUST_KEI })

    // The ledger locked the exact raw; the display rounded, as §6.1 allows.
    const raw = await world.node.swapOffer(offer.hash)
    expect(raw?.amount).toBe(DUST_RAW.toString())
    expect(await world.keiRaw(bob.address)).toBe(before - DUST_RAW)

    // The cancel must return the exact raw. A cancel built from the rounded
    // display number states a wrong balance and the ledger refuses it — at
    // which point the Kei is locked with no exit the SDK can offer.
    const cancellation = await bob.market.cancel(offer)
    expect(cancellation.offer).toBe(offer.hash)
    expect(await world.keiRaw(bob.address), evidence('bid-cancel', { offer: raw })).toBe(before)
    expect((await world.node.swapOffer(offer.hash))?.state).toBe('cancelled')
  })

  test('the background sweep can free an expired dust bid, and later offers behind it', async () => {
    const before = await world.keiRaw(bob.address)
    await bob.market.bid({
      asset: sword,
      amount: 1,
      price: DUST_KEI,
      expiresAt: world.clock.at + 100,
    })
    const later = await bob.market.bid({
      asset: sword,
      amount: 2,
      price: 3,
      expiresAt: world.clock.at + 200,
    })
    world.clock.tick(1_000)

    // One sweep frees both. A sweep that dies on the first offer's precision
    // never reaches the second, so a single dust bid would pin every later
    // expiry on the same chain.
    const cancelled = await bob.market.cancelExpired()
    expect(cancelled, evidence('swept', cancelled.map((entry) => entry.offer))).toHaveLength(2)
    expect((await world.node.swapOffer(later.hash))?.state).toBe('cancelled')
    expect(await world.keiRaw(bob.address)).toBe(before)
  })

  test('an accepted dust ask pays the seller the exact raw', async () => {
    const offer = await alice.market.sell({ asset: sword, amount: 1, price: DUST_KEI })
    const sellerBefore = await world.keiRaw(alice.address)
    const buyerBefore = await world.keiRaw(bob.address)

    await bob.market.accept(offer)
    await alice.client.receiveAll()

    expect(await world.keiRaw(bob.address)).toBe(buyerBefore - DUST_RAW)
    expect(await world.keiRaw(alice.address)).toBe(sellerBefore + DUST_RAW)
  })
})

describe('token amounts above Number.MAX_SAFE_INTEGER', () => {
  /** The smallest integer a double cannot represent exactly, plus the giveaway. */
  const HUGE = '9007199254740993'

  test('a huge token lot lists, displays rounded, and cancels back whole', async () => {
    const gold = await world.issue({ symbol: 'GOLD' })
    await world.mint(gold, alice, HUGE)

    const offer = await alice.market.offer({
      give: { asset: gold, amount: HUGE },
      want: { asset: KEI_ASSET, amount: 5 },
    })
    // Display rounds to the nearest double; the lock holds the true raw.
    expect(offer.give.amount).toBe(9_007_199_254_740_992)
    expect((await world.node.swapOffer(offer.hash))?.amount).toBe(HUGE)

    await alice.market.cancel(offer)
    expect(await world.node.holderBalance(gold, alice.address)).toBe(HUGE)

    const audit = await world.audit([gold])
    expect(audit.ok, evidence('conservation', audit.lines)).toBe(true)
  })

  test('a huge want settles at the exact raw, not the rounded display', async () => {
    const gold = await world.issue({ symbol: 'GOLD' })
    await world.mint(gold, bob, HUGE)

    const offer = await alice.market.sell({ asset: sword, amount: 1, price: 2 })
    void offer
    const trade = await alice.market.offer({
      give: { asset: sword, amount: 1 },
      want: { asset: gold, amount: HUGE },
    })
    await bob.market.accept(trade)
    await alice.client.receiveAll()

    expect(await world.node.holderBalance(gold, alice.address)).toBe(HUGE)
    expect(await world.node.holderBalance(gold, bob.address)).toBe('0')
  })
})

describe('display arithmetic stays display-only', () => {
  test('price and series numbers may round; the chain strings never do', async () => {
    const gold = await world.issue({ symbol: 'GOLD' })
    await world.mint(gold, bob, '9007199254740993')

    const trade = await alice.market.offer({
      give: { asset: sword, amount: 3 },
      want: { asset: gold, amount: '9007199254740993' },
    })
    await bob.market.accept(trade)

    const trades = await alice.market.trades({ from: [alice.address], quote: gold })
    expect(trades).toHaveLength(1)
    // Unit price is a display division of two display numbers — documented as
    // advisory. What must hold is that it derives from the rounded pair
    // consistently, so every reader computes the same number.
    expect(trades[0]?.price).toBe(9_007_199_254_740_992 / 3)

    const summary = await alice.market.price(sword, { from: [alice.address], quote: gold })
    expect(summary?.volume).toBe(3)
    expect(summary?.trades).toBe(1)
  })
})
