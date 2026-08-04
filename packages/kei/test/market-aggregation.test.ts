/**
 * `market.book()` and `market.reconcile()` against a real ledger.
 *
 * These are the two pieces `carpet-markets` and `world-of-wonder` each wrote by
 * hand, and the properties tested here are the ones both of them had to state in
 * a comment because the data could not: a book over a roster is a *floor*, not a
 * census, and a listing on a screen is a photograph.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createDirectory, type KeiNode } from 'kei-transaction'
import { Kei, randomSeed, type Item, type MockNode } from 'kei-transaction'

let node: MockNode
let game: Kei
let alice: Kei
let bob: Kei
let carol: Kei
let sword: Item
const opened: Kei[] = []

beforeEach(async () => {
  opened.length = 0
  node = await Kei.mock()
  game = await Kei.server({ seed: randomSeed(), node })
  await game.faucet(50_000)
  ;[alice, bob, carol] = (await Promise.all([
    Kei.start({ node, seed: randomSeed(), autoCancelExpired: false }),
    Kei.start({ node, seed: randomSeed(), autoCancelExpired: false }),
    Kei.start({ node, seed: randomSeed(), autoCancelExpired: false }),
  ])) as [Kei, Kei, Kei]
  opened.push(game, alice, bob, carol)
  await Promise.all([alice, bob, carol].map((player) => game.send(player.address, 500)))
  await Promise.all([alice.sync(), bob.sync(), carol.sync()])

  sword = await game.items.create({ name: 'Iron Sword', supply: 100 })
  // `items.mint` mints one. A stack of ten is the item's own token, minted ten.
  const swords = await game.items.token(sword.id)
  await swords.mint(alice.address, 10)
  await swords.mint(bob.address, 10)
  await Promise.all([alice.sync(), bob.sync()])
})

afterEach(() => {
  for (const wallet of opened) wallet.close()
})

describe('the book — one walk per chain (SPEC §9.1)', () => {
  test('asks and bids come off one read per account, cheapest first', async () => {
    await alice.market.sell({ asset: sword, price: 9 })
    await alice.market.sell({ asset: sword, price: 3 })
    await bob.market.sell({ asset: sword, price: 6 })
    await carol.market.bid({ asset: sword, price: 2 })

    const book = await carol.market.book({
      from: [alice.address, bob.address, carol.address],
      asset: sword,
    })

    expect(book.asks.map((entry) => entry.price)).toEqual([3, 6, 9])
    expect(book.bestAsk?.price).toBe(3)
    expect(book.bids).toHaveLength(1)
    expect(book.bestBid?.from).toBe(carol.address)
    expect(book.spread).toBe(1)
    expect(book.coverage.complete).toBe(true)
    expect(book.coverage.read).toBe(3)
  })

  test('an unreachable chain is a gap in the book, not the end of the read', async () => {
    await alice.market.sell({ asset: sword, price: 4 })
    await bob.market.sell({ asset: sword, price: 5 })

    // A proxy rather than a spread: `MockNode` keeps its methods on its
    // prototype, so a spread copies the fields and none of the behaviour.
    const broken = new Proxy(node, {
      get: (target, property, receiver) =>
        property === 'accountSwaps'
          ? (address: string, options?: { limit?: number }) => {
              if (address === bob.address) throw new Error('node unreachable')
              return target.accountSwaps(address, options)
            }
          : Reflect.get(target, property, receiver),
    }) as unknown as KeiNode
    const reader = await Kei.start({ node: broken, seed: randomSeed() })
    opened.push(reader)

    const book = await reader.market.book({ from: [alice.address, bob.address], asset: sword })
    expect(book.asks).toHaveLength(1)
    expect(book.coverage.read).toBe(1)
    expect(book.coverage.failed[0]?.account).toBe(bob.address)
    expect(book.coverage.failed[0]?.reason).toContain('unreachable')
    expect(book.coverage.complete).toBe(false)
  })

  test('a full page says so, because a short answer is not a complete one', async () => {
    await alice.market.sell({ asset: sword, price: 4 })
    await alice.market.sell({ asset: sword, price: 5 })

    const book = await carol.market.book({ from: [alice.address], asset: sword, limit: 2 })
    expect(book.coverage.truncated).toEqual([alice.address])
    expect(book.coverage.complete).toBe(false)
  })

  test('a bounded directory reports what it dropped rather than reading as empty', async () => {
    await alice.market.sell({ asset: sword, price: 4 })
    const directory = createDirectory({ limit: 1 })
    directory.watch(alice.address)
    directory.watch(bob.address)

    const book = await carol.market.book({ from: directory, asset: sword })
    expect(book.asks).toHaveLength(0)
    expect(book.coverage.dropped).toBe(1)
    expect(book.coverage.complete).toBe(false)
  })

  test('an address that is not an address is skipped and counted, not thrown on', async () => {
    await alice.market.sell({ asset: sword, price: 4 })
    const book = await carol.market.book({ from: [alice.address, 'not-an-address'], asset: sword })
    expect(book.asks).toHaveLength(1)
    expect(book.coverage.skipped).toEqual(['not-an-address'])
    expect(book.coverage.complete).toBe(false)
  })

  test('leaving the asset out reads the whole shelf against one currency', async () => {
    const shield = await game.items.create({ name: 'Round Shield', supply: 100 })
    await (await game.items.token(shield.id)).mint(alice.address, 5)
    await alice.sync()
    await alice.market.sell({ asset: sword, price: 4 })
    await alice.market.sell({ asset: shield, price: 6 })

    const book = await carol.market.book({ from: [alice.address] })
    expect(book.asset).toBeNull()
    // Every shelf row keeps the non-currency asset as its base, so stalls are asks.
    expect(book.asks).toHaveLength(2)
    // There is no spread across two different things, and saying null beats
    // subtracting two unrelated numbers.
    expect(book.spread).toBeNull()
  })

  test('a book of an asset against itself is refused by name', async () => {
    await expect(carol.market.book({ from: [alice.address], asset: sword, quote: sword })).rejects.toThrow(
      /no two sides/i,
    )
  })
})

describe('reconcile — a listing on a screen is a photograph', () => {
  test('taken and cancelled come back as different sentences, not one "gone"', async () => {
    const sold = await alice.market.sell({ asset: sword, price: 4 })
    const withdrawn = await alice.market.sell({ asset: sword, price: 5 })
    const standing = await alice.market.sell({ asset: sword, price: 6 })

    await bob.market.accept(sold)
    await alice.market.cancel(withdrawn)

    const report = await carol.market.reconcile([sold.hash, withdrawn.hash, standing.hash])
    expect(report.live.map((offer) => offer.hash)).toEqual([standing.hash])
    expect(report.gone).toHaveLength(2)

    const taken = report.gone.find((entry) => entry.hash === sold.hash)
    expect(taken?.life).toBe('taken')
    expect(taken?.reason).toContain(bob.address)
    expect(taken?.reason).toContain('settles exactly once')

    const cancelled = report.gone.find((entry) => entry.hash === withdrawn.hash)
    expect(cancelled?.life).toBe('cancelled')
    expect(cancelled?.reason).toContain('back in their wallet')
  })

  test('an offer state that moved since the snapshot is reported as a change', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 4 })
    await bob.market.accept(offer)

    // The snapshot is the *object* read before the sale, so the shift is visible.
    const report = await carol.market.reconcile([offer])
    expect(report.changed[0]?.was).toBe('live')
    expect(report.changed[0]?.now).toBe('taken')
  })

  test('a hash the node has never heard of is unknown rather than an error', async () => {
    const report = await carol.market.reconcile(['A'.repeat(64)])
    expect(report.unknown).toHaveLength(1)
    expect(report.live).toHaveLength(0)
  })

  test('an expired listing is stale — still open, and still settleable (SPEC §9.3)', async () => {
    const clock = { at: Date.now() }
    const seller = await Kei.start({
      node,
      seed: randomSeed(),
      autoCancelExpired: false,
    })
    opened.push(seller)
    await game.send(seller.address, 100)
    await (await game.items.token(sword.id)).mint(seller.address, 2)
    await seller.sync()

    const listing = await seller.market.sell({ asset: sword, price: 4, expiresAt: clock.at - 1 })
    expect(listing.expired).toBe(true)

    const report = await carol.market.reconcile([listing.hash])
    expect(report.stale.map((offer) => offer.hash)).toEqual([listing.hash])
    expect(report.gone).toHaveLength(0)

    // And the ledger still settles it, which is exactly what "advisory" means.
    await bob.market.accept(listing.hash)
    expect(await (await bob.token(sword.id)).balance()).toBeGreaterThan(0)
  })
})

describe('accept({ expect }) — an index is never an authority (SPEC §9.4)', () => {
  test('a listing that has not moved settles', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 4 })
    const settlement = await bob.market.accept(offer, {
      expect: { hash: offer.hash, seller: alice.address, want: { asset: offer.want.asset, amount: 4 } },
    })
    expect(settlement.paid.amount).toBe(4)
  })

  test('the same price on a different item is refused before anything is signed', async () => {
    const shield = await game.items.create({ name: 'Round Shield', supply: 10 })
    await game.items.mint(shield.id, alice.address)
    await alice.sync()
    const offer = await alice.market.sell({ asset: shield, price: 4 })

    const before = await bob.balance()
    await expect(
      bob.market.accept(offer, { expect: { give: { asset: sword.id, amount: 1 }, want: { amount: 4 } } }),
    ).rejects.toThrow(/not the trade that was shown to you/i)
    expect(await bob.balance()).toBe(before)
  })

  test('a repriced listing is refused, and the message names both numbers', async () => {
    const offer = await alice.market.sell({ asset: sword, price: 400 })
    await expect(
      bob.market.accept(offer, { expect: { want: { asset: offer.want.asset, amount: 4 } } }),
    ).rejects.toThrow(/shown as 4.*chain says 400/is)
  })
})

describe('series and candles, read from the chain', () => {
  test('a chart comes back oldest first with a summary over the same trades', async () => {
    for (const price of [5, 7, 9]) {
      const offer = await alice.market.sell({ asset: sword, price })
      await bob.market.accept(offer)
    }
    await alice.sync()

    const series = await alice.market.series({ asset: sword, from: [alice.address] })
    expect(series.points.map((point) => point.price)).toEqual([5, 7, 9])
    expect(series.first).toBe(5)
    expect(series.last).toBe(9)
    expect(series.summary?.median).toBe(7)
    expect(series.ordering.by).toBe('advisory-time')
  })

  test('prices() summarises every traded asset out of one walk', async () => {
    const shield = await game.items.create({ name: 'Round Shield', supply: 10 })
    await (await game.items.token(shield.id)).mint(alice.address, 2)
    await alice.sync()
    await bob.market.accept(await alice.market.sell({ asset: sword, price: 6 }))
    await bob.market.accept(await alice.market.sell({ asset: shield, price: 20 }))
    await alice.sync()

    const prices = await alice.market.prices({ from: [alice.address] })
    expect(prices.get(sword.id)?.last).toBe(6)
    expect(prices.get(shield.id)?.last).toBe(20)
  })

  test('candles bucket the same trades and say how wide the bucket is', async () => {
    await bob.market.accept(await alice.market.sell({ asset: sword, price: 5 }))
    await alice.sync()

    const candles = await alice.market.candles({ asset: sword, from: [alice.address], every: '1d' })
    expect(candles).toHaveLength(1)
    expect(candles[0]).toMatchObject({ open: 5, high: 5, low: 5, close: 5, trades: 1, every: 86_400_000 })
  })
})
