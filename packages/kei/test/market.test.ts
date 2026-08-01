/**
 * SPEC §9 — the market. An offer is a `swap_offer` block, settlement is one
 * atomic `swap_accept`, and price history is read straight off account chains.
 * No listing table, no matching engine, no server.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { Kei, KeiError, randomSeed, type Item, type MockNode } from 'kei-transaction'

let node: MockNode
let game: Kei
let sword: Item
let alice: Kei
let bob: Kei
let eve: Kei

beforeEach(async () => {
  node = await Kei.mock()
  game = await Kei.server({ seed: 'C'.repeat(64), node })
  await game.faucet(20_000)
  alice = await Kei.start({ node, seed: randomSeed() })
  bob = await Kei.start({ node, seed: randomSeed() })
  eve = await Kei.start({ node, seed: randomSeed() })
  await Promise.all([alice, bob, eve].map((player) => game.send(player.address, 2_000)))
  await Promise.all([alice.sync(), bob.sync(), eve.sync()])

  sword = await game.items.create({ name: 'Sword of Testing', description: 'It tests things.' })
  await game.items.mint(sword.id, alice.address)
  await alice.sync()
})

describe('listing (SPEC §9.3 — an offer is a swap_offer block)', () => {
  test('sell() locks the item and reads back a priced offer', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 5 })

    expect(offer.give.asset).toBe(sword.id)
    expect(offer.give.amount).toBe(1)
    expect(offer.want.symbol).toBe('KEI')
    expect(offer.want.amount).toBe(5)
    expect(offer.price).toBe(5)
    expect(offer.from).toBe(alice.address)
    expect(offer.mine).toBe(true)
    expect(offer.state).toBe('open')
    expect(offer.to).toBeNull()

    // The item is genuinely gone from the spendable balance, not just promised.
    expect(await alice.items.owner(sword.id)).toBeNull()
  })

  test('bid() locks Kei to buy, the mirror of sell()', async () => {
    const offer = await bob.market.bid({ asset: sword, price: 5 })
    expect(offer.give.symbol).toBe('KEI')
    expect(offer.give.amount).toBe(5)
    expect(offer.want.asset).toBe(sword.id)
    expect(await bob.balance()).toBe(2_000 - 5)
  })

  test('offer() takes any asset for any asset — sell/bid are it with Kei on one side', async () => {
    const coin = await game.token.issue({ name: 'Coins', symbol: 'COIN', decimals: 0 })
    await coin.mint(bob.address, 100)
    await bob.sync()

    const listed = await alice.market.offer({
      give: { asset: sword, amount: 1 },
      want: { asset: coin, amount: 40 },
    })
    expect(listed.give.asset).toBe(sword.id)
    expect(listed.want.asset).toBe(coin.id)
    expect(listed.want.amount).toBe(40)
  })

  test('an offer reserved for one buyer names them in `to`', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 5, to: bob.address })
    expect(offer.to).toBe(bob.address)
  })

  test('an offer for yourself is refused before anything locks', async () => {
    await expect(alice.market.sell({ asset: sword, price: 5, to: alice.address })).rejects.toThrow(
      /own address|move nothing/i,
    )
    expect(await alice.items.owner(sword.id)).toBe(alice.address)
  })

  test('the same item cannot be listed twice — it is not in the spendable balance the second time', async () => {
    await alice.market.sell({ asset: sword, price: 5 })
    await expect(alice.market.sell({ asset: sword, price: 3 })).rejects.toThrow(/not enough|insufficient-balance/i)
  })

  test('a wallet without the asset is told what it holds and what this needs', async () => {
    await expect(bob.market.sell({ asset: sword, price: 5 })).rejects.toThrow(/not enough.*you hold 0/is)
  })
})

describe('settlement (SPEC §9.2 — one block, both legs or neither)', () => {
  test('accept() delivers the item and the payment in the same round trip', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 5 })
    const before = await alice.balance()

    const settlement = await bob.market.accept(offer)
    expect(settlement.received.asset).toBe(sword.id)
    expect(settlement.paid.amount).toBe(5)
    expect(settlement.price).toBe(5)
    expect(await bob.items.owner(sword.id)).toBe(bob.address)
    expect(await bob.balance()).toBe(2_000 - 5)

    await alice.sync()
    expect(await alice.balance()).toBe(before + 5)
  })

  test('accept() takes a bare hash too, not just the Offer object', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 5 })
    const settlement = await bob.market.accept(offer.hash)
    expect(settlement.hash).toHaveLength(64)
  })

  test('an offer settles exactly once', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 5 })
    await bob.market.accept(offer)
    await expect(eve.market.accept(offer)).rejects.toThrow(/already accepted/i)
  })

  test('the offerer cannot accept their own listing', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 5 })
    await expect(alice.market.accept(offer)).rejects.toThrow(/own offer|market\.cancel/i)
  })

  test('a reserved offer refuses everyone but the named buyer', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 5, to: bob.address })
    await expect(eve.market.accept(offer)).rejects.toThrow(/reserved for/i)
    await expect(bob.market.accept(offer)).resolves.toBeTruthy()
  })

  test('accepting without enough Kei names what you hold and what it costs', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 50_000 })
    await expect(bob.market.accept(offer)).rejects.toThrow(/not enough KEI/i)
  })

  test('a made-up hash is told plainly that no such offer exists', async () => {
    await expect(bob.market.accept('F'.repeat(64))).rejects.toThrow(/no offer with hash/i)
  })

  test('accept() signs the raw wantAmount exactly, even above Number.MAX_SAFE_INTEGER', async () => {
    // 9007199254740993 is MAX_SAFE_INTEGER + 2 — the smallest odd integer a JS
    // number cannot represent, so it rounds to 9007199254740992 the moment it
    // passes through a number. Offer display does that on purpose (fromRaw());
    // accept() must not sign the rounded number back — it has to restate the
    // offer's own raw terms, or the node's ledger rejects it as a mismatch.
    const wantAmount = '9007199254740993'
    const coin = await game.token.issue({ name: 'Huge Coin', symbol: 'HUGE', decimals: 0 })
    await coin.mint(bob.address, wantAmount)
    await bob.sync()

    const offer = await alice.market.offer({
      give: { asset: sword, amount: 1 },
      want: { asset: coin, amount: wantAmount },
    })
    // Display rounds, as expected — this is the number that would wrongly get
    // signed if accept() round-tripped through it instead of the raw offer.
    expect(offer.want.amount).toBe(9_007_199_254_740_992)

    const settlement = await bob.market.accept(offer)
    expect(settlement.paid.asset).toBe(coin.id)
    expect(await bob.items.owner(sword.id)).toBe(bob.address)

    // toBe(0) survives number rounding regardless, but the raw balances below
    // are the exact proof: bob paid every last unit and alice received every
    // last unit of the true 9007199254740993, not the rounded 9007199254740992
    // — a mismatch there is exactly what swap-terms-mismatch would have caught.
    expect(await coin.balanceOf(bob.address)).toBe(0)
    expect(await node.holderBalance(coin.id, bob.address)).toBe('0')
    expect(await node.holderBalance(coin.id, alice.address)).toBe(wantAmount)

    const raw = await node.swapOffer(offer.hash)
    expect(raw?.state).toBe('accepted')
  })
})

describe('cancellation (SPEC §9.2 — the lock is its own garbage collector)', () => {
  test('cancel() returns exactly what was locked', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 5 })
    const cancellation = await alice.market.cancel(offer)
    expect(cancellation.returned.asset).toBe(sword.id)
    expect(await alice.items.owner(sword.id)).toBe(alice.address)
  })

  test('only the offer\'s own author can cancel it', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 5 })
    await expect(bob.market.cancel(offer)).rejects.toThrow(/only its author|not-your-offer/i)
  })

  test('cancelling an accepted offer says the payment is already on its way', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 5 })
    await bob.market.accept(offer)
    await expect(alice.market.cancel(offer)).rejects.toThrow(/nothing left to cancel|on its way/i)
  })
})

describe('the accept-vs-cancel race (SPEC §9.2, conflict 4 — either can win, and losing is normal)', () => {
  test('two wallets racing accept and cancel: exactly one succeeds, and the loser gets a plain retryable error', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 5 })

    const results = await Promise.allSettled([bob.market.accept(offer), alice.market.cancel(offer)])
    const outcomes = results.map((result) => result.status)
    // Exactly one of the two racing writers wins; the loser's block changes nothing.
    expect(outcomes.filter((status) => status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((status) => status === 'rejected')).toHaveLength(1)

    const loser = results.find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined
    expect(loser?.reason).toBeInstanceOf(KeiError)

    const settled = await alice.market.get(offer.hash)
    expect(['accepted', 'cancelled']).toContain(settled?.state ?? '')

    // Whichever won, the item is not stuck: it is with its new owner or back home.
    if (settled?.state === 'accepted') {
      await bob.sync()
      expect(await bob.items.owner(sword.id)).toBe(bob.address)
    } else {
      expect(await alice.items.owner(sword.id)).toBe(alice.address)
    }
  })

  test('two buyers racing the same open offer: exactly one gets the item', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 5 })
    const results = await Promise.allSettled([bob.market.accept(offer), eve.market.accept(offer)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)

    await Promise.all([bob.sync(), eve.sync()])
    // owner() answers "who holds this item" globally, so both wallets agree on
    // one winner rather than each reporting themselves.
    const owner = await bob.items.owner(sword.id)
    expect(owner).toBe(await eve.items.owner(sword.id))
    expect([bob.address, eve.address]).toContain(owner ?? '')
  })
})

describe('reading the market (SPEC §9.1 — a bounded walk of the chains you name)', () => {
  test('offers() requires the accounts to read — there is no network-wide index (SPEC §9.4)', async () => {
    await expect((alice.market.offers as (options?: unknown) => Promise<unknown>)(undefined)).rejects.toThrow(
      /needs the accounts to read/i,
    )
  })

  test('offers({ from }) reads one seller\'s open listings', async () => {
    await alice.market.sell({ asset: sword, price: 5 })
    const listings = await bob.market.offers({ from: alice.address })
    expect(listings).toHaveLength(1)
    expect(listings[0]?.from).toBe(alice.address)
  })

  test('mine() is this wallet\'s own offers regardless of state', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 5 })
    await alice.market.cancel(offer)
    const mine = await alice.market.mine({ state: null })
    expect(mine).toHaveLength(1)
    expect(mine[0]?.state).toBe('cancelled')
  })

  test('get() reads one offer by hash, and null for one that never existed', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 5 })
    expect((await alice.market.get(offer.hash))?.hash).toBe(offer.hash)
    expect(await alice.market.get('9'.repeat(64))).toBeNull()
  })
})

describe('price history (SPEC §9.1 — a settled offer is a trade)', () => {
  test('trades() and price() summarise settled offers, not open listings', async () => {
    const other = await game.items.create({ name: 'Second Sword' })
    await game.items.mint(other.id, alice.address)
    await alice.sync()

    const first = await alice.market.sell({ asset: sword, price: 4 })
    await bob.market.accept(first)
    const second = await alice.market.sell({ asset: other, price: 6 })
    await eve.market.accept(second)

    const trades = await alice.market.trades()
    expect(trades).toHaveLength(2)
    expect(trades.every((trade) => trade.state === 'accepted')).toBe(true)

    const summary = await alice.market.price(sword)
    expect(summary?.trades).toBe(1)
    expect(summary?.median).toBe(4)
    expect(summary?.last).toBe(4)

    expect(await alice.market.medianPrice(other)).toBe(6)
    expect(await alice.market.medianPrice(sword.id)).toBe(4)
  })

  test('medianPrice is null for something that has never sold', async () => {
    const untraded = await game.items.create({ name: 'Untraded Sword' })
    expect(await alice.market.medianPrice(untraded)).toBeNull()
  })

  test('a still-open listing is not counted as a trade', async () => {
    await alice.market.sell({ asset: sword, price: 5 })
    expect(await alice.market.medianPrice(sword)).toBeNull()
    expect(await alice.market.trades()).toEqual([])
  })
})

describe('expiry is advisory, and the SDK cancels its own (SPEC §9.3)', () => {
  // These isolate the protocol property from the SDK's own background sweep:
  // `alice`'s wallet auto-cancels its own expired offers by default (below), so
  // a `quiet` wallet with that switched off is what lets "still settles /
  // nothing to sweep yet" be observed deterministically rather than raced.
  let quiet: Kei
  let trinket: Item

  beforeEach(async () => {
    quiet = await Kei.start({ node, seed: randomSeed(), autoCancelExpired: false })
    await game.send(quiet.address, 2_000)
    await quiet.sync()
    trinket = await game.items.create({ name: 'Quiet Trinket' })
    await game.items.mint(trinket.id, quiet.address)
    await quiet.sync()
  })

  test('an offer past its expiry still settles if somebody accepts it — the chain has no clock', async () => {
    const offer = await quiet.market.sell({ asset: trinket, price: 5, expiresAt: Date.now() + 1 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await quiet.market.get(offer.hash))?.expired).toBe(true)
    await expect(bob.market.accept(offer)).resolves.toBeTruthy()
  })

  test('cancelExpired() sweeps this wallet\'s own expired offers, and only its own', async () => {
    await quiet.market.sell({ asset: trinket, price: 5, expiresAt: Date.now() + 1 })
    await new Promise((resolve) => setTimeout(resolve, 10))

    const cancelled = await quiet.market.cancelExpired()
    expect(cancelled).toHaveLength(1)
    expect(await quiet.items.owner(trinket.id)).toBe(quiet.address)
    // Nothing to sweep the second time.
    expect(await quiet.market.cancelExpired()).toEqual([])
  })

  test('expiresIn accepts a duration string', async () => {
    const offer = await quiet.market.sell({ asset: trinket, price: 5, expiresIn: '1ms' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await quiet.market.get(offer.hash))?.expired).toBe(true)
  })

  test('with the background sweep on (the default), an expired listing is gone on its own', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 5, expiresIn: '1ms' })
    // No manual cancelExpired() call — this is Kei.start()'s default behaviour.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await alice.market.get(offer.hash))?.state).toBe('cancelled')
    expect(await alice.items.owner(sword.id)).toBe(alice.address)
  })
})
