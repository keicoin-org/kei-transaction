/**
 * The accept/cancel conflict, scheduled instead of raced (SPEC §9.2, conflict 4).
 *
 * `packages/kei/test/market.test.ts` already proves that when two writers race,
 * exactly one wins — but it lets the scheduler pick the winner, so each run
 * exercises one interleaving and nobody chooses which. This suite pins every
 * interleaving by holding `process` calls at the node (see `harness/net.ts`)
 * and releasing them in the order the scenario is about. Both writers get past
 * their own reads first, so what is under test is the true conflict: two valid
 * blocks on two chains consuming one lock, in an order the ledger — not the
 * SDK — decides.
 *
 * After every interleaving the conservation audit re-derives, from public
 * reads only, that every unit ever minted is held, receivable, or locked, and
 * nothing was lost or invented. A lost race costs a block, never an asset.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { KeiError, type AssetId, type Block } from '@keicoin/core'
import { isRace } from '@keicoin/market'

import { GateNode } from './harness/net.js'
import { World, evidence, type Actor } from './harness/world.js'

let world: World
let gate: GateNode
let alice: Actor
let bob: Actor
let eve: Actor
let sword: AssetId

const isSwapWrite = (_key: string, block?: Block): boolean =>
  block?.type === 'asset' && (block.op.kind === 'swap_accept' || block.op.kind === 'swap_cancel')

beforeEach(async () => {
  world = await World.create()
  gate = new GateNode(world.node)
  alice = await world.actor('alice', { node: gate })
  bob = await world.actor('bob', { node: gate })
  eve = await world.actor('eve', { node: gate })
  sword = await world.issue({ symbol: 'SWORD' })
  await world.mint(sword, alice, 10)
})

afterEach(() => {
  world.close()
})

describe('accept and cancel, in both orders, by schedule', () => {
  test('accept lands first: the sale stands, the cancel loses with offer-taken', async () => {
    const offer = await alice.market.sell({ asset: sword, amount: 1, price: 5 })
    const bobKeiBefore = await world.keiRaw(bob.address)

    gate.hold('process', isSwapWrite)
    const accepting = bob.market.accept(offer)
    const acceptHold = await gate.captured()
    const cancelling = alice.market.cancel(offer)
    const cancelHold = await gate.captured()
    expect(acceptHold.block?.type === 'asset' && acceptHold.block.op.kind).toBe('swap_accept')
    expect(cancelHold.block?.type === 'asset' && cancelHold.block.op.kind).toBe('swap_cancel')

    // Both writers passed their own reads while the offer was open. The ledger
    // now sees the accept first.
    acceptHold.release()
    const settlement = await accepting
    expect(settlement.received.asset).toBe(sword)

    cancelHold.release()
    const lost = await cancelling.catch((error: unknown) => error)
    expect(lost).toBeInstanceOf(KeiError)
    expect((lost as KeiError).code).toBe('offer-taken')
    expect(isRace(lost)).toBe(true)
    expect(String((lost as KeiError).message)).toContain('before this cancel reached the ledger')

    expect(await world.keiRaw(bob.address)).toBe(bobKeiBefore - 5n * 10n ** 18n)
    const audit = await world.audit([sword])
    expect(audit.ok, evidence('conservation', audit.lines)).toBe(true)
  })

  test('cancel lands first: the asset comes home, the accept loses and pays nothing', async () => {
    const offer = await alice.market.sell({ asset: sword, amount: 1, price: 5 })
    const bobKeiBefore = await world.keiRaw(bob.address)
    const bobHeightBefore = (await world.node.accountInfo(bob.address))?.height

    gate.hold('process', isSwapWrite)
    const accepting = bob.market.accept(offer)
    const acceptHold = await gate.captured()
    const cancelling = alice.market.cancel(offer)
    const cancelHold = await gate.captured()

    cancelHold.release()
    const cancellation = await cancelling
    expect(cancellation.returned.asset).toBe(sword)

    acceptHold.release()
    const lost = await accepting.catch((error: unknown) => error)
    expect(lost).toBeInstanceOf(KeiError)
    expect((lost as KeiError).code).toBe('offer-cancelled')
    expect(isRace(lost)).toBe(true)
    expect(String((lost as KeiError).message)).toContain('allowed and expected')

    // The loser's block was refused whole: no Kei moved, no block landed.
    expect(await world.keiRaw(bob.address)).toBe(bobKeiBefore)
    expect((await world.node.accountInfo(bob.address))?.height).toBe(bobHeightBefore as number)
    expect(await world.node.holderBalance(sword, alice.address)).toBe('10')

    const audit = await world.audit([sword])
    expect(audit.ok, evidence('conservation', audit.lines)).toBe(true)
  })

  test('the offer can be relisted after a cancel — the lock genuinely released', async () => {
    const offer = await alice.market.sell({ asset: sword, amount: 10, price: 50 })
    await alice.market.cancel(offer)

    const relisted = await alice.market.sell({ asset: sword, amount: 10, price: 40 })
    const settlement = await bob.market.accept(relisted)
    expect(settlement.received.amount).toBe(10)

    await bob.client.receiveAll()
    expect(await world.node.holderBalance(sword, bob.address)).toBe('10')
    const audit = await world.audit([sword])
    expect(audit.ok, evidence('conservation', audit.lines)).toBe(true)
  })
})

describe('many buyers, one lock', () => {
  test('five buyers race one offer: the first release wins, every loser is refused whole', async () => {
    const buyers: Actor[] = [bob, eve]
    for (let i = 0; i < 3; i++) buyers.push(await world.actor(`buyer${i}`, { node: gate }))
    const offer = await alice.market.sell({ asset: sword, amount: 1, price: 7 })
    const before = new Map<string, bigint>()
    for (const buyer of buyers) before.set(buyer.address, await world.keiRaw(buyer.address))

    gate.hold('process', isSwapWrite)
    const attempts = buyers.map((buyer) => buyer.market.accept(offer))
    const holds = []
    for (let i = 0; i < buyers.length; i++) holds.push(await gate.captured())

    // Release in reverse arrival order, so the winner is a *chosen* buyer and
    // not whoever happened to submit first — determinism is the assertion.
    const chosen = holds[holds.length - 1]
    chosen?.release()
    for (let i = 0; i < holds.length - 1; i++) holds[i]?.release()

    const outcomes = await Promise.allSettled(attempts)
    const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    expect(winners, evidence('outcomes', outcomes.map((o) => o.status))).toHaveLength(1)

    const winnerAddress = chosen?.key as string
    const winnerIndex = buyers.findIndex((buyer) => buyer.address === winnerAddress)
    expect(outcomes[winnerIndex]?.status).toBe('fulfilled')

    for (let i = 0; i < buyers.length; i++) {
      const buyer = buyers[i] as Actor
      const outcome = outcomes[i] as PromiseSettledResult<unknown>
      const held = before.get(buyer.address) as bigint
      if (outcome.status === 'fulfilled') {
        expect(await world.keiRaw(buyer.address)).toBe(held - 7n * 10n ** 18n)
      } else {
        expect(outcome.reason).toBeInstanceOf(KeiError)
        expect((outcome.reason as KeiError).code).toBe('offer-taken')
        expect(isRace(outcome.reason)).toBe(true)
        expect(await world.keiRaw(buyer.address)).toBe(held)
      }
    }

    const audit = await world.audit([sword])
    expect(audit.ok, evidence('conservation', audit.lines)).toBe(true)
  })
})

describe('the expiry sweep losing to a buyer', () => {
  test('a swept cancel that loses to an accept is a sale, not a failure', async () => {
    const offer = await alice.market.sell({
      asset: sword,
      amount: 1,
      price: 5,
      expiresAt: world.clock.at + 1_000,
    })
    world.clock.tick(2_000)

    // The sweep reads the expired offer as open and submits its cancel; the
    // buyer lands an accept while that cancel is held at the node.
    gate.hold('process', (_key, block) => block?.type === 'asset' && block.op.kind === 'swap_cancel')
    const sweeping = alice.market.cancelExpired()
    const cancelHold = await gate.captured()
    await bob.market.accept(offer)
    cancelHold.release()

    // §9.2: losing this race is a sale. The sweep reports nothing to do and
    // does not throw.
    expect(await sweeping).toEqual([])
    expect((await alice.market.get(offer.hash))?.state).toBe('accepted')

    const audit = await world.audit([sword])
    expect(audit.ok, evidence('conservation', audit.lines)).toBe(true)
  })
})

describe('refusal taxonomy at the market surface', () => {
  test('every refusal carries its ledger code, and only the two race codes read as races', async () => {
    const offer = await alice.market.sell({ asset: sword, amount: 1, price: 5, to: bob.address })

    const reserved = await eve.market.accept(offer).catch((error: unknown) => error)
    expect((reserved as KeiError).code).toBe('not-the-counterparty')
    expect(isRace(reserved)).toBe(false)

    const own = await alice.market.accept(offer).catch((error: unknown) => error)
    expect((own as KeiError).code).toBe('self-accept')
    expect(isRace(own)).toBe(false)

    const notYours = await bob.market.cancel(offer).catch((error: unknown) => error)
    expect((notYours as KeiError).code).toBe('not-your-offer')
    expect(isRace(notYours)).toBe(false)

    await bob.market.accept(offer)
    const taken = await eve.market.accept(offer.hash).catch((error: unknown) => error)
    expect((taken as KeiError).code).toBe('offer-taken')
    expect(isRace(taken)).toBe(true)

    const cancelTaken = await alice.market.cancel(offer.hash).catch((error: unknown) => error)
    expect((cancelTaken as KeiError).code).toBe('offer-taken')
    expect(isRace(cancelTaken)).toBe(true)
  })
})
