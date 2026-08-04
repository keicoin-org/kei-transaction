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

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { type AssetId } from '@keicoin/core'
import { createMarket, isMarketError } from '@keicoin/market'

import { CountingNode, FaultNode, GateNode } from './harness/net.js'
import { World, evidence, until, type Actor } from './harness/world.js'

let world: World
let sword: AssetId
let buyerSide: Actor

const MAX_TIMER_DELAY = 2_147_483_647

interface HeldTimer {
  callback: () => void
  delay: number
  cancelled: boolean
  fired: boolean
}

/** A deterministic timer queue: production still calls the real global API. */
function holdTimers(): {
  timers: HeldTimer[]
  next(): HeldTimer
  fire(timer: HeldTimer): void
  restore(): void
} {
  const timers: HeldTimer[] = []
  const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(
    ((callback: () => void, delay?: number) => {
      const timer: HeldTimer = { callback, delay: Number(delay), cancelled: false, fired: false }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout,
  )
  const clearing = spyOn(globalThis, 'clearTimeout').mockImplementation(
    ((timer: ReturnType<typeof setTimeout>) => {
      ;(timer as unknown as HeldTimer).cancelled = true
    }) as typeof clearTimeout,
  )

  return {
    timers,
    next() {
      const timer = timers.find((entry) => !entry.cancelled && !entry.fired)
      if (!timer) throw new Error('No pending fake timer')
      return timer
    },
    fire(timer) {
      timer.fired = true
      timer.callback()
    },
    restore() {
      timeout.mockRestore()
      clearing.mockRestore()
    },
  }
}

beforeEach(async () => {
  world = await World.create()
  sword = await world.issue({ symbol: 'SWORD' })
  buyerSide = await world.actor('buyer')
})

afterEach(() => {
  world.close()
})

describe('sweepInterval is validated at the public boundary', () => {
  const invalid = [
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['fractional', 1.5],
    ['past the timer range', 2_147_483_648],
    ['past the safe-integer range', Number.MAX_SAFE_INTEGER + 1],
  ] as const

  for (const [label, interval] of invalid) {
    test(`rejects ${label} before a sweep, retry, or node read can start`, async () => {
      const counting = new CountingNode(world.node)
      const actor = await world.actor(`invalid-${label}`, { node: counting })
      counting.reset()

      let failure: unknown
      let scheduled = 0
      const timer = spyOn(globalThis, 'setTimeout')
      try {
        createMarket(actor.client, {
          autoCancelExpired: true,
          sweepInterval: interval,
          now: world.clock.now,
        })
      } catch (error) {
        failure = error
      } finally {
        scheduled = timer.mock.calls.length
        timer.mockRestore()
      }

      expect(isMarketError(failure, 'bad-sweep-interval')).toBe(true)
      expect(scheduled).toBe(0)
      expect((failure as Error).message).toBe(
        `sweepInterval must be a whole number of milliseconds from 1 through 2147483647; got ${String(interval)}. Omit it for the 30000 ms default.`,
      )
      expect(counting.report(), evidence('calls', counting.report())).toEqual({
        accountInfo: 0,
        accountHistory: 0,
        receivables: 0,
        process: 0,
        assetInfo: 0,
        holderBalance: 0,
        swapOffer: 0,
        accountSwaps: 0,
      })
    })
  }

  test('the default and both supported integer boundaries remain valid', async () => {
    const counting = new CountingNode(world.node)
    const actor = await world.actor('valid-intervals', { node: counting })
    counting.reset()

    const defaults = createMarket(actor.client, { autoCancelExpired: true, now: world.clock.now })
    const minimum = createMarket(actor.client, {
      autoCancelExpired: true,
      sweepInterval: 1,
      now: world.clock.now,
    })
    const maximum = createMarket(actor.client, {
      autoCancelExpired: true,
      sweepInterval: 2_147_483_647,
      now: world.clock.now,
    })
    defaults.close()
    minimum.close()
    maximum.close()

    expect(counting.report(), evidence('calls', counting.report())).toEqual({
      accountInfo: 0,
      accountHistory: 0,
      receivables: 0,
      process: 0,
      assetInfo: 0,
      holderBalance: 0,
      swapOffer: 0,
      accountSwaps: 0,
    })
  })
})

describe('long-dated expiry uses bounded read-free timer checkpoints', () => {
  test('a 30-day listing never schedules above the timer ceiling or reads at its early checkpoint', async () => {
    const counting = new CountingNode(world.node)
    const seller = await world.actor('long-dated', {
      node: counting,
      market: { autoCancelExpired: true },
    })
    await world.mint(sword, seller, 1)
    counting.reset()

    const held = holdTimers()
    let offer!: Awaited<ReturnType<typeof seller.market.sell>>
    try {
      offer = await seller.market.sell({ asset: sword, price: 5, expiresIn: '30d' })
      const first = held.next()
      expect(first.delay).toBe(MAX_TIMER_DELAY)
      const readsBefore = counting.calls.accountSwaps

      world.clock.tick(first.delay)
      held.fire(first)

      // The first wake is still more than five days before expiry. It only
      // installs the remainder and must not poll the ledger.
      expect(counting.calls.accountSwaps, evidence('calls', counting.report())).toBe(readsBefore)
      const remainder = held.next()
      expect(remainder.delay).toBe(30 * 86_400_000 - MAX_TIMER_DELAY + 1)
      expect(remainder.delay).toBeLessThanOrEqual(MAX_TIMER_DELAY)

      world.clock.tick(remainder.delay)
      held.fire(remainder)
    } finally {
      // The due callback has started the async sweep; restore real timers so
      // `until` can wait for its public result without advancing fake time.
      held.restore()
    }

    await until(async () => (await world.node.swapOffer(offer.hash))?.state === 'cancelled', {
      label: 'the long-dated offer to cancel after its final checkpoint',
    })
    expect(counting.calls.accountSwaps).toBeGreaterThan(0)
  })

  test('the exact ceiling and one millisecond beyond both pass only bounded delays', async () => {
    const seller = await world.actor('timer-boundaries', { market: { autoCancelExpired: true } })
    await world.mint(sword, seller, 1)
    const held = holdTimers()
    try {
      await seller.market.sell({ asset: sword, price: 5, expiresAt: world.clock.at + MAX_TIMER_DELAY })
      expect(held.next().delay).toBe(MAX_TIMER_DELAY)
      seller.market.close()

      const other = await world.actor('timer-over-boundary', { market: { autoCancelExpired: true } })
      await world.mint(sword, other, 1)
      await other.market.sell({ asset: sword, price: 7, expiresAt: world.clock.at + MAX_TIMER_DELAY + 1 })
      expect(held.next().delay).toBe(MAX_TIMER_DELAY)
      other.market.close()

      const years = await world.actor('timer-multi-year', { market: { autoCancelExpired: true } })
      await world.mint(sword, years, 1)
      await years.market.sell({ asset: sword, price: 8, expiresIn: '200w' })
      expect(held.next().delay).toBe(MAX_TIMER_DELAY)
      years.market.close()
    } finally {
      held.restore()
    }
    expect(held.timers.every((timer) => timer.delay >= 1 && timer.delay <= MAX_TIMER_DELAY)).toBe(true)
  })

  test('close makes even an already-queued long checkpoint inert', async () => {
    const counting = new CountingNode(world.node)
    const seller = await world.actor('closed-checkpoint', {
      node: counting,
      market: { autoCancelExpired: true },
    })
    await world.mint(sword, seller, 1)
    const held = holdTimers()
    try {
      await seller.market.sell({ asset: sword, price: 5, expiresIn: '30d' })
      const checkpoint = held.next()
      const readsBefore = counting.calls.accountSwaps
      seller.market.close()
      // Simulate a callback already queued by the host when clearTimeout raced.
      world.clock.tick(checkpoint.delay)
      held.fire(checkpoint)
      expect(counting.calls.accountSwaps, evidence('calls', counting.report())).toBe(readsBefore)
      expect(held.timers.filter((timer) => !timer.cancelled && !timer.fired)).toHaveLength(0)
    } finally {
      held.restore()
    }
  })
})

describe('expiry duration normalization is safe before network or signing', () => {
  test.each([
    ['a fractional numeric millisecond', 0.5],
    ['a fractional string millisecond', '0.1ms'],
    ['an overflowing duration string', `${'9'.repeat(400)}w`],
  ] as const)('rejects %s after normalization', async (_label, expiresIn) => {
    const counting = new CountingNode(world.node)
    const seller = await world.actor(`invalid-duration-${String(expiresIn).slice(0, 8)}`, {
      node: counting,
      market: { autoCancelExpired: true },
    })
    await world.mint(sword, seller, 1)
    counting.reset()
    const timer = spyOn(globalThis, 'setTimeout')

    const failure = await seller.market.sell({ asset: sword, price: 5, expiresIn }).catch((error) => error)

    expect(isMarketError(failure, 'bad-duration')).toBe(true)
    expect(counting.report(), evidence('calls', counting.report())).toEqual({
      accountInfo: 0,
      accountHistory: 0,
      receivables: 0,
      process: 0,
      assetInfo: 0,
      holderBalance: 0,
      swapOffer: 0,
      accountSwaps: 0,
    })
    expect(timer).toHaveBeenCalledTimes(0)
    timer.mockRestore()
  })

  test('rejects an unsafe absolute sum and an invalid injected clock before signing', async () => {
    const cases = [
      {
        name: 'unsafe-sum',
        now: () => Number.MAX_SAFE_INTEGER - 5,
        expiry: { expiresIn: 6 },
      },
      {
        name: 'invalid-clock',
        now: () => Number.NaN,
        expiry: { expiresAt: world.clock.at + 1_000 },
      },
    ] as const

    for (const scenario of cases) {
      const counting = new CountingNode(world.node)
      const seller = await world.actor(scenario.name, {
        node: counting,
        market: { autoCancelExpired: true, now: scenario.now },
      })
      await world.mint(sword, seller, 1)
      counting.reset()

      const failure = await seller.market
        .sell({ asset: sword, price: 5, ...scenario.expiry })
        .catch((error) => error)

      expect(isMarketError(failure, 'bad-expiry')).toBe(true)
      expect(counting.calls.process, evidence('calls', counting.report())).toBe(0)
      expect(counting.calls.assetInfo, evidence('calls', counting.report())).toBe(0)
    }
  })
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

  test('close() during the per-offer read stops before cancellation is submitted', async () => {
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
    // Let the listing read finish, then hold the later per-offer read inside
    // cancelOfferChecked(). This is the await window the earlier test cannot
    // cover: close() must still be observed before submitAsset() starts.
    gate.hold('swapOffer', (hash) => hash === offer.hash)
    world.clock.tick(100)

    const held = await gate.captured()
    seller.market.close()
    const processBefore = counting.calls.process
    held.release()
    gate.open('swapOffer')

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
    const counting = new CountingNode(fault)
    const seller = await world.actor('seller', {
      node: counting,
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
    expect(counting.calls.accountSwaps, evidence('calls', counting.report())).toBeGreaterThanOrEqual(2)
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
