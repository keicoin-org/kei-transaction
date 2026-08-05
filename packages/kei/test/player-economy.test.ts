/**
 * Player shops: two of them, in one world, with nobody in the middle.
 *
 * The property under test throughout is that the world is an address book and
 * nothing more. It tells the SDK which chains to read (SPEC §9.1, §9.4); it
 * cannot list, cancel, buy, or gift on anybody's behalf, and a directory that
 * lies can hide a stall but cannot move an item.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  KEI_ASSET,
  Kei,
  createDirectory,
  itemSymbolFor,
  randomSeed,
  type IssuerToken,
  type Item,
  type Listing,
  type MockNode,
  type MutableDirectory,
} from 'kei-transaction'

let node: MockNode
let game: Kei
let alice: Kei
let bob: Kei
let carol: Kei
let gold: IssuerToken
let sword: Item
let potion: Item
let directory: MutableDirectory
const opened: Kei[] = []

/** What a world hands its players: one currency, one catalogue, one roster. */
const world = () => ({
  currency: gold.id,
  catalogue: [
    { key: 'sword', asset: sword.id, title: 'Iron Sword' },
    { key: 'potion', asset: potion.id, title: 'Healing Potion' },
  ],
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
  potion = await game.items.create({ name: 'Healing Potion', supply: 1_000 })
  const swords = await game.items.token(sword.id)
  const potions = await game.items.token(potion.id)

  // `autoReceive: false` so an arrival is only collected when a test says so.
  // Incoming-versus-confirmed is the distinction under test in several of these,
  // and a background collector racing the assertion would erase it.
  const players = (await Promise.all([
    Kei.start({ node, seed: randomSeed(), autoCancelExpired: false, autoReceive: false, shop: world() }),
    Kei.start({ node, seed: randomSeed(), autoCancelExpired: false, autoReceive: false, shop: world() }),
    Kei.start({ node, seed: randomSeed(), autoCancelExpired: false, autoReceive: false, shop: world() }),
  ])) as [Kei, Kei, Kei]
  ;[alice, bob, carol] = players
  opened.push(game, ...players)

  for (const player of players) {
    await game.send(player.address, 100)
    await gold.mint(player.address, 500)
    directory.watch(player.address)
  }
  await swords.mint(alice.address, 5)
  await potions.mint(bob.address, 8)
  await swords.mint(bob.address, 2)
  await Promise.all(players.map((player) => player.sync()))
})

afterEach(() => {
  for (const wallet of opened) wallet.close()
})

// --------------------------------------------------------------------- listing

describe('a player lists from their own wallet', () => {
  test('one call, and the goods are locked on the seller\'s own chain (SPEC §9.2)', async () => {
    const listing = await alice.shop.list({ item: 'sword', each: 120 })

    expect(listing.seller).toBe(alice.address)
    expect(listing.mine).toBe(true)
    expect(listing.title).toBe('Iron Sword')
    expect(listing.qty).toBe(1)
    expect(listing.each).toBe(120)
    expect(listing.price).toBe(120)
    expect(listing.currency.symbol).toBe('GOLD')
    expect(listing.life).toBe('live')

    // Gone from the spendable balance, not promised: the ledger did that.
    expect(await alice.shop.funds('sword').then((funds) => funds.confirmed)).toBe(4)
  })

  test('`each` is per unit and `price` is the lot, and the SDK does the multiplying', async () => {
    const byUnit = await alice.shop.list({ item: 'sword', qty: 3, each: 120 })
    expect(byUnit.qty).toBe(3)
    expect(byUnit.price).toBe(360)
    expect(byUnit.each).toBe(120)

    const byLot = await alice.shop.list({ item: 'sword', qty: 2, price: 300 })
    expect(byLot.price).toBe(300)
    expect(byLot.each).toBe(150)
  })

  test('naming both, or neither, is refused with both meanings spelled out', async () => {
    await expect(alice.shop.list({ item: 'sword', each: 5, price: 5 })).rejects.toThrow(
      /per Iron Sword.*whole lot/is,
    )
    await expect(alice.shop.list({ item: 'sword' })).rejects.toThrow(/needs a price/i)
  })

  test('listing more than you hold names what is locked in your own listings', async () => {
    await alice.shop.list({ item: 'sword', qty: 4, each: 100 })
    await expect(alice.shop.list({ item: 'sword', qty: 3, each: 100 })).rejects.toThrow(
      /You have 1 Iron Sword to list, not 3.*locked in your own open listings.*shop\.cancel/is,
    )
  })

  test('a ware this world does not deal in is refused with the list of ones it does', async () => {
    await expect(alice.shop.list({ item: 'trebuchet', each: 5 })).rejects.toThrow(
      /does not deal in "trebuchet".*sword, potion/is,
    )
  })

  test('a listing selling the currency for the currency is refused before it locks', async () => {
    await expect(alice.shop.list({ item: gold.id, each: 1 })).rejects.toThrow(/moves nothing/i)
  })

  test('a fractional lot is refused, because a lot is a whole number of things', async () => {
    await expect(alice.shop.list({ item: 'sword', qty: 1.5, each: 10 })).rejects.toThrow(
      /whole number of Iron Sword/i,
    )
  })
})

// ---------------------------------------------------------------- two shops

describe('two shops, browsed through a directory', () => {
  test('browse groups by seller and orders by unit price', async () => {
    await alice.shop.list({ item: 'sword', each: 120 })
    await alice.shop.list({ item: 'sword', qty: 2, each: 90 })
    await bob.shop.list({ item: 'potion', qty: 4, each: 10 })

    const shelves = await carol.shop.browse()

    expect(shelves.shelves).toHaveLength(2)
    expect(shelves.listings.map((listing) => listing.each)).toEqual([10, 90, 120])
    expect(shelves.shelves[0]?.seller).toBe(alice.address)
    expect(shelves.shelves[0]?.listings).toHaveLength(2)
    expect(shelves.coverage.complete).toBe(true)
    expect(shelves.coverage.read).toBe(3)
  })

  test('one seller\'s stall is one call, and an empty one is not an error', async () => {
    await bob.shop.list({ item: 'potion', each: 10 })

    const bobs = await carol.shop.shelfOf(bob.address)
    expect(bobs.listings).toHaveLength(1)
    expect(bobs.mine).toBe(false)

    const empty = await carol.shop.shelfOf(carol.address)
    expect(empty.listings).toEqual([])
    expect(empty.mine).toBe(true)
  })

  test('browsing one ware narrows to that ware', async () => {
    await alice.shop.list({ item: 'sword', each: 120 })
    await bob.shop.list({ item: 'potion', each: 10 })

    const swords = await carol.shop.browse({ item: 'sword' })
    expect(swords.listings.map((listing) => listing.key)).toEqual(['sword'])
  })

  test('a shop\'s own stall can be left out of the browse', async () => {
    await alice.shop.list({ item: 'sword', each: 120 })
    const others = await alice.shop.browse({ includeMine: false })
    expect(others.listings).toHaveLength(0)
  })
})

// ------------------------------------------------------------------- buying

describe('buying — one block, both legs or neither (SPEC §9.2)', () => {
  test('one call moves the sword one way and the gold the other', async () => {
    const listing = await alice.shop.list({ item: 'sword', qty: 2, each: 120 })
    const shelves = await bob.shop.browse()
    const purchase = await bob.shop.buy(shelves.listings.find((entry) => entry.key === 'sword') ?? listing)

    expect(purchase.received.title).toBe('Iron Sword')
    expect(purchase.received.qty).toBe(2)
    expect(purchase.paid.amount).toBe(240)

    await bob.shop.sync()
    await alice.shop.sync()
    expect(await bob.shop.funds('sword').then((funds) => funds.confirmed)).toBe(4)
    expect(await bob.shop.funds().then((funds) => funds.confirmed)).toBe(500 - 240)
    expect(await alice.shop.funds().then((funds) => funds.confirmed)).toBe(500 + 240)
  })

  test('a listing repriced between the read and the click is refused, not paid', async () => {
    const listing = await alice.shop.list({ item: 'sword', each: 100 })
    // What a dishonest index does: hand back a hash whose real terms differ from
    // the row that was rendered. The wallet signs the ledger's numbers.
    const lie = { ...listing, price: 1, each: 1 }

    const before = await bob.shop.funds()
    await expect(bob.shop.buy(lie)).rejects.toThrow(/not the trade that was shown to you/i)
    expect((await bob.shop.funds()).confirmed).toBe(before.confirmed)
  })

  test('buying your own listing is refused and points at cancel', async () => {
    const listing = await alice.shop.list({ item: 'sword', each: 100 })
    await expect(alice.shop.buy(listing)).rejects.toThrow(/own listing.*shop\.cancel/is)
  })

  test('not enough gold is a sentence with all three balances in it', async () => {
    const listing = await alice.shop.list({ item: 'sword', qty: 5, each: 200 })
    await expect(bob.shop.buy(listing)).rejects.toThrow(/costs 1000 GOLD and this wallet can spend 500/i)
  })

  test('a listing somebody else already took reads as taken, with who took it', async () => {
    const listing = await alice.shop.list({ item: 'sword', each: 100 })
    await bob.shop.buy(listing)
    await expect(carol.shop.buy(listing)).rejects.toThrow(/already accepted by/i)
  })

  test('a listing the seller cancelled reads as cancelled, not as taken', async () => {
    const listing = await alice.shop.list({ item: 'sword', each: 100 })
    await alice.shop.cancel(listing)
    await expect(bob.shop.buy(listing)).rejects.toThrow(/cancelled by its author/i)
  })

  test('a bare hash with { verify: true } is refused rather than silently unchecked', async () => {
    const listing = await alice.shop.list({ item: 'sword', each: 100 })
    await expect(bob.shop.buy(listing.hash, { verify: true })).rejects.toThrow(/nothing to compare/i)
  })

  test('a listing reserved for somebody else cannot be taken', async () => {
    const listing = await alice.shop.list({ item: 'sword', each: 100, to: carol.address })
    expect(listing.reservedFor).toBe(carol.address)
    await expect(bob.shop.buy(listing)).rejects.toThrow(/reserved for/i)
    await expect(carol.shop.buy(listing)).resolves.toBeDefined()
  })
})

// ---------------------------------------------------------------- cancelling

describe('cancelling — only the author, because only their asset is locked', () => {
  test('the goods come back and the stall is empty', async () => {
    const listing = await alice.shop.list({ item: 'sword', qty: 3, each: 100 })
    expect((await alice.shop.funds('sword')).confirmed).toBe(2)

    const cancelled = await alice.shop.cancel(listing)
    expect(cancelled.life).toBe('cancelled')
    expect((await alice.shop.funds('sword')).confirmed).toBe(5)
    expect(await alice.shop.mine()).toHaveLength(0)
  })

  test('somebody else\'s listing cannot be cancelled', async () => {
    const listing = await alice.shop.list({ item: 'sword', each: 100 })
    await expect(bob.shop.cancel(listing)).rejects.toThrow(/only its author can cancel it/i)
  })
})

// ------------------------------------------------------------------- gifting

describe('gifting — no price, no offer, no accept', () => {
  test('an item, in one call', async () => {
    const gift = await alice.shop.gift({ to: bob.address, item: 'sword', amount: 2 })

    expect(gift.to).toBe(bob.address)
    expect(gift.amount).toBe(2)
    expect(gift.ware?.title).toBe('Iron Sword')

    await bob.sync()
    expect((await alice.shop.funds('sword')).confirmed).toBe(3)
    expect((await bob.shop.funds('sword')).confirmed).toBe(4)
  })

  test('the world\'s currency, in one call', async () => {
    await alice.shop.gift({ to: carol.address, item: gold.id, amount: 75 })
    await carol.sync()
    expect((await carol.shop.funds()).confirmed).toBe(575)
  })

  test('Kei, which is the one thing a shop does not need a catalogue for', async () => {
    const gift = await alice.shop.gift({ to: bob.address, kei: 1.5 })
    expect(gift.symbol).toBe('KEI')
    expect(gift.amount).toBe(1.5)

    await bob.sync()
    expect(await bob.balance()).toBe(101.5)
  })

  test('two things in one gift is refused, because one block moves one asset', async () => {
    await expect(alice.shop.gift({ to: bob.address, kei: 1, item: 'sword' })).rejects.toThrow(
      /one thing per call.*two gifts are two calls/is,
    )
    await expect(alice.shop.gift({ to: bob.address })).rejects.toThrow(/needs to know what to give/i)
  })

  test('giving more than you hold names what you have', async () => {
    await expect(alice.shop.gift({ to: bob.address, item: 'sword', amount: 9 })).rejects.toThrow(
      /You have 5 Iron Sword to give, not 9/i,
    )
  })

  test('a gift to yourself is refused before a block is written', async () => {
    await expect(alice.shop.gift({ to: alice.address, kei: 1 })).rejects.toThrow(/own address/i)
  })
})

// --------------------------------------------------- pending and reconciliation

describe('pending and reconciliation', () => {
  test('a signed spend is a debt while it is in flight, and gone once it settles', async () => {
    const seen: number[] = []
    alice.shop.on('change', (payload) => seen.push(payload.pending.length))

    expect(alice.shop.pending()).toHaveLength(0)
    await alice.shop.list({ item: 'sword', qty: 2, each: 100 })

    // Up, then down: the entry existed for the duration of the action.
    expect(seen).toContain(1)
    expect(seen[seen.length - 1]).toBe(0)
    expect(alice.shop.pending()).toHaveLength(0)
  })

  test('a refusal before anything is signed writes no pending entry at all', async () => {
    const settled: string[] = []
    alice.shop.on('settled', (entry) => settled.push(entry.state))

    await expect(alice.shop.list({ item: 'sword', qty: 99, each: 1 })).rejects.toThrow(/to list, not 99/i)
    expect(alice.shop.pending()).toHaveLength(0)
    // Nothing was signed, so nothing was ever in flight to reconcile.
    expect(settled).toEqual([])
  })

  test('an action that fails mid-flight leaves no debt and carries its own sentence', async () => {
    const listing = await alice.shop.list({ item: 'sword', each: 100 })
    const settled: string[] = []
    bob.shop.on('settled', (entry) => settled.push(`${entry.state}:${entry.error ?? ''}`))

    // Cancelled after the row was read and before the click landed, which is
    // the race SPEC §9.2 says is ordinary rather than exceptional.
    await alice.shop.cancel(listing)
    await expect(bob.shop.buy(listing)).rejects.toThrow(/cancelled by its author/i)

    expect(bob.shop.pending()).toHaveLength(0)
    expect(settled[0]).toStartWith('failed:')
    expect(settled[0]).toContain('cancelled by its author')
    // And the gold never moved, because the accept block was never valid.
    expect((await bob.shop.funds()).confirmed).toBe(500)
  })

  test('sync collects arrivals, re-reads the stall, and says what went', async () => {
    const sold = await alice.shop.list({ item: 'sword', each: 100 })
    const standing = await alice.shop.list({ item: 'sword', each: 150 })
    await bob.shop.buy(sold)

    const report = await alice.shop.sync()

    expect(report.received).toBeGreaterThan(0)
    expect(report.mine.map((listing) => listing.hash)).toEqual([standing.hash])
    expect(report.gone).toHaveLength(1)
    expect(report.gone[0]?.life).toBe('taken')
    expect(report.gone[0]?.reason).toContain(bob.address)
    // And the gold arrived, because sync signed for it before it read.
    expect(report.funds.confirmed).toBe(600)
  })

  test('incoming is real, owed, and not spendable until it is signed for', async () => {
    await alice.shop.gift({ to: carol.address, item: gold.id, amount: 200 })

    const before = await carol.shop.funds()
    expect(before.incoming).toBe(200)
    expect(before.spendable).toBe(500)
    expect(before.projected).toBe(700)
    expect(before.settling).toBe(true)

    await carol.shop.sync()
    const after = await carol.shop.funds()
    expect(after.confirmed).toBe(700)
    expect(after.incoming).toBe(0)
  })
})

// ------------------------------------------------------ stale and dead entries

describe('stale and dead entries', () => {
  test('an expired listing is stale, hidden by default, and still settleable', async () => {
    const listing = await alice.shop.list({ item: 'sword', each: 100, expiresIn: 1 })
    await Bun.sleep(5)

    const hidden = await carol.shop.browse()
    expect(hidden.listings.map((entry) => entry.hash)).not.toContain(listing.hash)

    const shown = await carol.shop.browse({ includeExpired: true })
    const stale = shown.listings.find((entry) => entry.hash === listing.hash)
    expect(stale?.life).toBe('stale')

    // Advisory means advisory: the ledger has no clock and settles it anyway.
    await expect(carol.shop.buy(stale ?? listing)).resolves.toBeDefined()
  })

  test('sync reports this wallet\'s own stale listings, because a cancel is the only cure', async () => {
    await alice.shop.list({ item: 'sword', each: 100, expiresIn: 1 })
    await Bun.sleep(5)

    const report = await alice.shop.sync()
    expect(report.stale).toHaveLength(1)
    expect(report.mine).toHaveLength(0)
  })

  test('a dead entry names which kind of dead it is', async () => {
    const taken = await alice.shop.list({ item: 'sword', each: 100 })
    const withdrawn = await alice.shop.list({ item: 'sword', each: 150 })
    await bob.shop.buy(taken)
    await alice.shop.cancel(withdrawn)

    const report = await alice.shop.sync()
    expect(report.gone.map((entry) => entry.life).sort()).toEqual(['cancelled', 'taken'])
  })
})

// ---------------------------------------------------------- partial discovery

describe('partial discovery — a shop over a roster is a floor, not a census', () => {
  test('a seller nobody has announced is invisible, and the coverage does not pretend otherwise', async () => {
    const stranger = await Kei.start({
      node,
      seed: randomSeed(),
      autoCancelExpired: false,
      // Their own shop shares nothing with this world's roster.
      shop: { ...world(), directory: createDirectory(), announce: false },
    })
    opened.push(stranger)
    await game.send(stranger.address, 10)
    await (await game.items.token(sword.id)).mint(stranger.address, 1)
    await stranger.sync()
    await stranger.shop.list({ item: 'sword', each: 1 })

    const shelves = await carol.shop.browse()
    expect(shelves.listings).toHaveLength(0)
    expect(shelves.coverage.asked).toBe(3)

    // Announcing is the whole fix, and it is one call that grants nothing.
    directory.watch(stranger.address)
    const again = await carol.shop.browse()
    expect(again.listings).toHaveLength(1)
    expect(again.coverage.asked).toBe(4)
  })

  test('listing announces this wallet, so the next reader can see the stall', async () => {
    const fresh = createDirectory()
    const seller = await Kei.start({
      node,
      seed: randomSeed(),
      autoCancelExpired: false,
      shop: { ...world(), directory: fresh },
    })
    opened.push(seller)
    await game.send(seller.address, 10)
    await (await game.items.token(potion.id)).mint(seller.address, 3)
    await seller.sync()

    expect(fresh.accounts()).toHaveLength(0)
    await seller.shop.list({ item: 'potion', each: 4 })
    expect(fresh.accounts()).toEqual([seller.address])
  })

  test('a shop with nobody in its directory says so rather than answering empty', async () => {
    const lonely = await Kei.start({
      node,
      seed: randomSeed(),
      shop: { ...world(), directory: createDirectory() },
    })
    opened.push(lonely)
    const shelves = await lonely.shop.browse()
    expect(shelves.listings).toEqual([])
    expect(shelves.coverage.asked).toBe(0)
  })
})

// --------------------------------------------------------------- price history

describe('price history, read from the chain', () => {
  test('what a ware has sold for, ordered and ready to draw', async () => {
    for (const each of [100, 140, 120]) {
      await bob.shop.buy(await alice.shop.list({ item: 'sword', each }))
      await alice.shop.sync()
    }

    const series = await alice.shop.history({ item: 'sword' })
    expect(series.points).toHaveLength(3)
    expect(series.points.map((point) => point.price)).toEqual([100, 140, 120])
    expect(series.summary?.median).toBe(120)
    expect(series.summary?.volume).toBe(3)
    expect(series.ordering.by).toBe('advisory-time')
    expect(series.ordering.note).toContain('not consensus')
  })

  test('a ware that has never sold draws nothing rather than a price of zero', async () => {
    const series = await carol.shop.history({ item: 'potion' })
    expect(series.points).toEqual([])
    expect(series.last).toBeNull()
    expect(series.summary).toBeNull()
  })

  test('candles bucket the same trades, and the bucket width comes back with them', async () => {
    await bob.shop.buy(await alice.shop.list({ item: 'sword', each: 100 }))
    await alice.shop.sync()

    const candles = await alice.shop.candles({ item: 'sword', every: '1d' })
    expect(candles).toHaveLength(1)
    expect(candles[0]).toMatchObject({ open: 100, close: 100, trades: 1, every: 86_400_000 })
  })

  test('history of nothing in particular is refused, because that is not a chart', async () => {
    // @ts-expect-error the point of the refusal is that the type says so too
    await expect(carol.shop.history({})).rejects.toThrow(/one ware/i)
  })
})

// -------------------------------------------------------------- the boundaries

describe('the boundaries this package keeps', () => {
  test('the shop signs for one account, and it is this one', async () => {
    const listing = await alice.shop.list({ item: 'sword', each: 100 })
    // Nothing the game holds can take it back. It has no key for alice, and
    // there is no API that pretends otherwise.
    await expect(game.shop.cancel(listing)).rejects.toThrow(/only its author can cancel it/i)
    expect((await carol.shop.browse()).listings).toHaveLength(1)
  })

  test('the currency is the world\'s coin, and Kei is only the default', async () => {
    const keiPriced = await Kei.start({ node, seed: randomSeed(), shop: { catalogue: world().catalogue } })
    opened.push(keiPriced)
    expect((await keiPriced.shop.currency()).symbol).toBe('KEI')
    expect((await alice.shop.currency()).symbol).toBe('GOLD')
  })

  test('a listing priced in something else is not this shop\'s business to show', async () => {
    // Written straight through the market, in Kei rather than gold.
    await alice.market.offer({ give: { asset: sword.id, amount: 1 }, want: { asset: KEI_ASSET, amount: 3 } })
    const shelves = await carol.shop.browse()
    expect(shelves.listings).toHaveLength(0)
  })
})

// ------------------------------------------------------------- no catalogue

/**
 * The catalogue is optional, so the shop a developer gets from the §6.2 snippet
 * has none. The chain already carries a name for every asset (SPEC §7); reaching
 * past it for the 64-hex id makes a hash the default product name, in the
 * listing and in every sentence that interpolates a title.
 */
describe('a shop with no catalogue', () => {
  let seller: Kei
  let buyer: Kei

  const bare = () => ({ currency: gold.id, directory })

  beforeEach(async () => {
    const pair = (await Promise.all([
      Kei.start({ node, seed: randomSeed(), autoCancelExpired: false, autoReceive: false, shop: bare() }),
      Kei.start({ node, seed: randomSeed(), autoCancelExpired: false, autoReceive: false, shop: bare() }),
    ])) as [Kei, Kei]
    ;[seller, buyer] = pair
    opened.push(...pair)

    const swords = await game.items.token(sword.id)
    for (const player of pair) {
      await game.send(player.address, 100)
      directory.watch(player.address)
    }
    await swords.mint(seller.address, 3)
    await Promise.all(pair.map((player) => player.sync()))
  })

  const shelf = async (): Promise<Listing> => {
    const [listing] = (await buyer.shop.browse({ from: [seller.address] })).listings
    if (!listing) throw new Error('nothing on the shelf')
    return listing
  }

  test('a listing is titled with the item\'s on-chain name and keyed by its symbol', async () => {
    await seller.shop.list({ item: sword.id, qty: 3, price: 9 })
    const listing = await shelf()

    expect(listing.title).toBe('Iron Sword')
    expect(listing.key).toBe(itemSymbolFor('Iron Sword'))
    expect(listing.asset).toMatch(/^[0-9A-F]{64}$/)
  })

  test('the refusal a buyer reads names the item rather than its id', async () => {
    await seller.shop.list({ item: sword.id, qty: 3, price: 9 })
    const listing = await shelf()

    // This wallet holds no gold at all.
    const thrown = await buyer.shop
      .buy(listing)
      .then(() => undefined, (error: unknown) => error as { code?: string; message: string })
    expect(thrown?.code).toBe('insufficient-balance')
    expect(thrown?.message).toContain('Iron Sword')
    expect(thrown?.message).not.toMatch(/[0-9A-F]{64}/)
  })

  test('a purchase taken by hash still names what was bought', async () => {
    await gold.mint(buyer.address, 50)
    await buyer.sync()
    await seller.shop.list({ item: sword.id, qty: 3, price: 9 })
    const listing = await shelf()

    // By hash, so the purchase is described from the settlement rather than
    // copied off the listing the buyer was shown.
    const purchase = await buyer.shop.buy(listing.hash)
    expect(purchase.listing.title).toBe('Iron Sword')
    expect(purchase.received.title).toBe('Iron Sword')
    expect(purchase.received.key).toBe(itemSymbolFor('Iron Sword'))
  })

  test('no sentence this shop throws is a 64-hex asset id', async () => {
    const sentences: string[] = []
    const record = async (job: Promise<unknown>): Promise<void> => {
      await job.then(
        () => {
          throw new Error('should have refused')
        },
        (error: unknown) => {
          sentences.push((error as Error).message)
        },
      )
    }

    await record(seller.shop.list({ item: sword.id, qty: 99, price: 9 }))
    await record(seller.shop.list({ item: sword.id, qty: 1.5, price: 9 }))
    await record(seller.shop.list({ item: sword.id, qty: 2, each: 4, price: 9 }))
    await record(seller.shop.gift({ to: buyer.address, item: sword.id, amount: 99 }))

    expect(sentences).toHaveLength(4)
    for (const sentence of sentences) {
      expect(sentence).toContain('Iron Sword')
      expect(sentence).not.toMatch(/[0-9A-F]{64}/)
    }
  })

  test('a declared title still wins over the chain\'s name', async () => {
    await seller.shop.list({ item: sword.id, qty: 3, price: 9 })
    const dressed = await Kei.start({
      node,
      seed: randomSeed(),
      shop: { currency: gold.id, directory, catalogue: [{ key: 'blade', asset: sword.id, title: 'Alice\'s Blade' }] },
    })
    opened.push(dressed)

    const [listing] = (await dressed.shop.browse({ from: [seller.address] })).listings
    expect(listing?.title).toBe('Alice\'s Blade')
    expect(listing?.key).toBe('blade')
  })
})
