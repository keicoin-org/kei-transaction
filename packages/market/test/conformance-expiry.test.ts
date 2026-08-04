/**
 * The background expiry sweep (SPEC §9.3): the one part of this package that
 * owns a timer, which makes it the one part that can act after the caller
 * stopped caring. Advisory expiry is read off the injected clock, so every
 * "is it expired" answer here is deterministic; the only real time in this
 * file is the market's own timer, and every assertion is on the state it
 * eventually produces, never on when.
 *
 * Two properties are load-bearing and were previously untested:
 *
 * - **`close()` means closed.** A sweep caught mid-flight by `close()` must
 *   not go on to write cancel blocks. A "background convenience" that signs
 *   blocks after the wallet shut down is not a convenience.
 * - **A failed sweep retries.** The node being unreachable for one round must
 *   not orphan expired listings until the next `sell()` happens to re-arm
 *   the timer — `sweepInterval` is the retry cadence.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { type AssetId } from '@keicoin/core'

import { CountingNode, FaultNode, GateNode } from './harness/net.js'
import { World, evidence, until, type Actor } from './harness/world.js'

let world: World
let sword: AssetId
let buyerSide: Actor

beforeEach(async () => {
  world = await World.create()
  sword = await world.issue({ symbol: 'SWORD' })
  buyerSide = await world.actor('buyer')
})

afterEach(() => {
  world.close()
})

describe('the sweep cancels what expired, and only that', () => {
  test('a mixed shelf: own expired offers go, open and foreign ones stay', async () => {
    const seller = await world.actor('seller', { market: { autoCancelExpired: true } })
    const other = await world.actor('other')
    await world.mint(sword, seller, 5)
    await world.mint(sword, other, 5)

    const dying = await seller.market.sell({
      asset: sword,
      amount: 1,
      price: 5,
      expiresAt: world.clock.at + 50,
    })
    const standing = await seller.market.sell({ asset: sword, amount: 1, price: 6 })
    const foreign = await other.market.sell({
      asset: sword,
      amount: 1,
      price: 7,
      expiresAt: world.clock.at + 50,
    })
    world.clock.tick(1_000)

    await until(async () => (await world.node.swapOffer(dying.hash))?.state === 'cancelled', {
      label: 'the expired offer to be swept',
    })
    expect((await world.node.swapOffer(standing.hash))?.state).toBe('open')
    // The other wallet opted out of sweeping; nobody else may cancel for it.
    expect((await world.node.swapOffer(foreign.hash))?.state).toBe('open')

    const audit = await world.audit([sword])
    expect(audit.ok, evidence('conservation', audit.lines)).toBe(true)
  })

  test('the timer re-arms for the earliest expiry, so a later one does not shadow it', async () => {
    const seller = await world.actor('seller', { market: { autoCancelExpired: true } })
    await world.mint(sword, seller, 5)

    const later = await seller.market.sell({
      asset: sword,
      amount: 1,
      price: 5,
      expiresAt: world.clock.at + 600_000,
    })
    const sooner = await seller.market.sell({
      asset: sword,
      amount: 1,
      price: 6,
      expiresAt: world.clock.at + 50,
    })
    world.clock.tick(100)

    await until(async () => (await world.node.swapOffer(sooner.hash))?.state === 'cancelled', {
      label: 'the sooner expiry to be swept first',
    })
    expect((await world.node.swapOffer(later.hash))?.state).toBe('open')
  })

  test('an offer published already past its advisory expiry is swept promptly', async () => {
    const seller = await world.actor('seller', { market: { autoCancelExpired: true } })
    await world.mint(sword, seller, 1)
    const offer = await seller.market.sell({
      asset: sword,
      amount: 1,
      price: 5,
      expiresAt: world.clock.at - 1,
    })
    await until(async () => (await world.node.swapOffer(offer.hash))?.state === 'cancelled', {
      label: 'the pre-expired offer to be swept',
    })
    expect(await world.node.holderBalance(sword, seller.address)).toBe('1')
  })
})

describe('close() means closed', () => {
  test('a sweep caught mid-flight by close() writes nothing afterwards', async () => {
    const counting = new CountingNode(world.node)
    const gate = new GateNode(counting)
    const seller = await world.actor('seller', {
      node: gate,
      market: { autoCancelExpired: true },
    })
    await world.mint(sword, seller, 1)
    const offer = await seller.market.sell({
      asset: sword,
      amount: 1,
      price: 5,
      expiresAt: world.clock.at + 5,
    })
    // Publishing also reads this wallet's open swaps to explain insufficient
    // balances. Arm the gate only after publish, so it catches the sweep rather
    // than deadlocking the write that creates the offer under test.
    gate.hold('accountSwaps')
    world.clock.tick(100)

    // The timer fired and the sweep is now inside its read.
    const held = await gate.captured()
    seller.market.close()
    const processBefore = counting.calls.process
    held.release()
    gate.open('accountSwaps')

    // Give an un-aborted sweep every chance to misbehave, then look: the
    // offer must still be open and not one block written since close().
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect((await world.node.swapOffer(offer.hash))?.state).toBe('open')
    expect(counting.calls.process, evidence('calls', counting.report())).toBe(processBefore)
  })

  test('an explicit cancelExpired() call still works after close()', async () => {
    const seller = await world.actor('seller', { market: { autoCancelExpired: true } })
    await world.mint(sword, seller, 1)
    const offer = await seller.market.sell({
      asset: sword,
      amount: 1,
      price: 5,
      expiresAt: world.clock.at + 60_000,
    })
    seller.market.close()
    world.clock.tick(120_000)

    // close() stops the background writer; it does not revoke the API.
    const swept = await seller.market.cancelExpired()
    expect(swept.map((entry) => entry.offer)).toEqual([offer.hash])
  })
})

describe('a failed sweep retries on sweepInterval', () => {
  test('one unreachable round does not orphan an expired listing', async () => {
    const fault = new FaultNode(world.node)
    const seller = await world.actor('seller', {
      node: fault,
      market: { autoCancelExpired: true, sweepInterval: 40 },
    })
    await world.mint(sword, seller, 1)

    // The first sweep's read throws, as an unreachable node throws. Nothing
    // else re-arms the timer — no further sell() is coming — so only the
    // retry can save this listing.
    fault.breakCall({
      method: 'accountSwaps',
      key: seller.address,
      times: 1,
      message: 'node unreachable',
    })
    const offer = await seller.market.sell({
      asset: sword,
      amount: 1,
      price: 5,
      expiresAt: world.clock.at + 5,
    })
    world.clock.tick(100)

    await until(async () => (await world.node.swapOffer(offer.hash))?.state === 'cancelled', {
      timeout: 3_000,
      label: 'the sweep to retry after the faulted round',
    })
    expect(await world.node.holderBalance(sword, seller.address)).toBe('1')
  })

  test('a retrying sweep stops for good at close()', async () => {
    const fault = new FaultNode(world.node)
    const counting = new CountingNode(fault)
    const seller = await world.actor('seller', {
      node: counting,
      market: { autoCancelExpired: true, sweepInterval: 30 },
    })
    await world.mint(sword, seller, 1)

    fault.breakCall({ method: 'accountSwaps', key: seller.address, message: 'still down' })
    await seller.market.sell({
      asset: sword,
      amount: 1,
      price: 5,
      expiresAt: world.clock.at + 5,
    })
    world.clock.tick(100)

    // Let at least one faulted round happen, then close and count silence.
    await new Promise((resolve) => setTimeout(resolve, 100))
    seller.market.close()
    await new Promise((resolve) => setTimeout(resolve, 60))
    const after = counting.calls.accountSwaps
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(counting.calls.accountSwaps, evidence('calls', counting.report())).toBe(after)
  })
})
