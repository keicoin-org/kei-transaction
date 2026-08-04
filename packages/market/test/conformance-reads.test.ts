/**
 * Reads under adversity: capped pages, duplicated sources, lying read models,
 * and directories that misbehave.
 *
 * The stance under test is SPEC §9.4's: anything that tells a wallet where to
 * look — a directory, a node's read model, an index — is a list of leads and
 * never an authority. A wrong lead may *hide* a listing or *pad* a view; it
 * must never move funds, because the only thing a wallet signs is a
 * restatement of the ledger's own terms, and the ledger checks the
 * restatement exactly (SPEC §9.2, `swap-terms-mismatch`).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { KeiError, type AssetId } from '@keicoin/core'
import { MAX_ACCOUNTS_PER_WALK, createDirectory, isMarketError } from '@keicoin/market'

import { PagingNode, TwoFacedNode } from './harness/net.js'
import { World, evidence, syntheticAddress, type Actor } from './harness/world.js'

let world: World
let alice: Actor
let bob: Actor
let sword: AssetId

beforeEach(async () => {
  world = await World.create()
  alice = await world.actor('alice')
  bob = await world.actor('bob')
  sword = await world.issue({ symbol: 'SWORD' })
  await world.mint(sword, alice, 50)
})

afterEach(() => {
  world.close()
})

describe('pages capped by the server, not the caller (docs/rpc.md `count`)', () => {
  test('a page as long as the asked limit is truncated; a silent server cap is invisible', async () => {
    for (let i = 0; i < 6; i++) {
      await alice.market.sell({ asset: sword, amount: 1, price: 10 - i })
    }
    const capped = await world.actor('capped', { node: new PagingNode(world.node, 4) })

    // Asked limit at the server's cap: the full page is detected and said.
    const honest = await capped.market.book({ from: [alice.address], asset: sword, limit: 4 })
    expect(honest.asks.length).toBe(4)
    expect(honest.coverage.truncated).toEqual([alice.address])
    expect(honest.coverage.complete).toBe(false)
    // The rows that did come back are the newest four, cheapest first.
    expect(honest.asks.map((offer) => offer.price)).toEqual([5, 6, 7, 8])

    // Asked limit above the cap: the wire returns rows and nothing else, so a
    // short page cannot be told from a complete chain. This is the documented
    // limit of `coverage` (see `Coverage.truncated`), pinned here so a change
    // to it is a deliberate act: against a silently-capping server, keep the
    // asked limit at or below the server's — or `complete` overstates.
    const blind = await capped.market.book({ from: [alice.address], asset: sword, limit: 100 })
    expect(blind.asks.length).toBe(4)
    expect(blind.coverage.truncated).toEqual([])
    expect(blind.coverage.complete).toBe(true)
  })

  test('a multi-round sweep drains more expired offers than one page holds', async () => {
    const seller = await world.actor('seller', { node: new PagingNode(world.node, 3) })
    await world.mint(sword, seller, 8)
    for (let i = 0; i < 8; i++) {
      await seller.market.sell({
        asset: sword,
        amount: 1,
        price: 5,
        expiresAt: world.clock.at + 10,
      })
    }
    world.clock.tick(1_000)

    // Each call sees one server-capped page. Repeated calls must make
    // progress rather than re-reading the same stuck page.
    let total = 0
    for (let round = 0; round < 8 && total < 8; round++) {
      total += (await seller.market.cancelExpired()).length
    }
    expect(total).toBe(8)
    expect(await world.node.holderBalance(sword, seller.address)).toBe('8')
  })

  test('trades() under a page cap is a floor, and dedupes what two walks both saw', async () => {
    for (let i = 0; i < 5; i++) {
      const offer = await alice.market.sell({ asset: sword, amount: 1, price: 4 + i })
      await bob.market.accept(offer)
      world.clock.tick(10)
    }
    const capped = await world.actor('capped', { node: new PagingNode(world.node, 3) })

    const trades = await capped.market.trades({ from: [alice.address, alice.address] })
    // Naming the same chain twice must not double its trades.
    const hashes = trades.map((trade) => trade.hash)
    expect(new Set(hashes).size, evidence('trade-hashes', hashes)).toBe(hashes.length)
    expect(trades.length).toBe(3)
  })
})

describe('duplicate sources are one source (an offer hash is the offer id)', () => {
  test('offers() over the same account named twice returns each listing once', async () => {
    await alice.market.sell({ asset: sword, amount: 1, price: 5 })
    const listings = await bob.market.offers({ from: [alice.address, alice.address] })
    expect(listings, evidence('offers', listings.map((offer) => offer.hash))).toHaveLength(1)
  })

  test('a directory that yields duplicates costs one walk, not two', async () => {
    await alice.market.sell({ asset: sword, amount: 1, price: 5 })
    const listings = await bob.market.offers({
      from: { accounts: () => [alice.address, alice.address, alice.address] },
    })
    expect(listings).toHaveLength(1)
  })

  test('a node that pads a page with duplicate rows cannot double a book', async () => {
    await alice.market.sell({ asset: sword, amount: 1, price: 5 })
    const liar = new TwoFacedNode(world.node)
    liar.lieAboutSwaps((_address, offers) => [...offers, ...offers])
    const reader = await world.actor('reader', { node: liar })

    const book = await reader.market.book({ from: [alice.address], asset: sword })
    expect(book.asks, evidence('asks', book.asks.map((offer) => offer.hash))).toHaveLength(1)
  })

  test('reconcile() over a snapshot with repeated hashes reports each listing once', async () => {
    const offer = await alice.market.sell({ asset: sword, amount: 1, price: 5 })
    const report = await bob.market.reconcile([offer.hash, offer, offer.hash.toLowerCase()])
    expect(report.live, evidence('live', report.live.map((entry) => entry.hash))).toHaveLength(1)
    expect(report.gone).toHaveLength(0)
    expect(report.unknown).toHaveLength(0)
  })
})

describe('advisory trade windows preserve time-quality evidence', () => {
  test('seenAt is the fallback clock and a fully untimed accepted row is not erased', async () => {
    const offer = await alice.market.sell({ asset: sword, amount: 1, price: 5 })
    await bob.market.accept(offer)
    const liar = new TwoFacedNode(world.node)
    let seenAt: number | null = world.clock.at - 1_000
    liar.lieAboutSwaps((_address, offers) => offers.map((row) => row.hash === offer.hash
      ? { ...row, settledAt: null, seenAt: seenAt as number }
      : row))
    const reader = await world.actor('window-reader', { node: liar })
    const read = () => reader.market.trades({ from: [alice.address], asset: sword, window: 1_000 })

    expect((await read()).map(({ hash }) => hash)).toEqual([offer.hash])
    seenAt = world.clock.at
    expect((await read()).map(({ hash }) => hash)).toEqual([offer.hash])
    seenAt = world.clock.at - 1_001
    expect(await read()).toHaveLength(0)
    seenAt = world.clock.at + 1
    expect(await read()).toHaveLength(0)
    seenAt = null
    const untimed = await read()
    expect(untimed.map(({ hash }) => hash)).toEqual([offer.hash])
    expect(untimed[0]?.settledAt).toBeNull()
    expect(untimed[0]?.seenAt).toBeNull()
    expect(untimed.coverage.complete).toBe(true)
  }, 30_000)

  test('range.from/range.to provide explicit trade-time bounds', async () => {
    const listing = await alice.market.sell({ asset: sword, amount: 1, price: 3 })
    await bob.market.accept(listing)
    const trade = (await bob.market.trades({ from: [alice.address], asset: sword }))[0]
    if (!trade) throw new Error('expected one trade')
    const upper = trade.settledAt ?? trade.seenAt
    if (!Number.isSafeInteger(upper)) {
      throw new Error('mock data produced no safe trade time for this test')
    }

    const within = await bob.market.trades({
      from: [alice.address],
      asset: sword,
      range: { from: upper - 1, to: upper },
    })
    expect(within.map(({ hash }) => hash)).toEqual([trade.hash])

    const before = await bob.market.trades({
      from: [alice.address],
      asset: sword,
      range: { from: upper + 1, to: upper + 2 },
    })
    expect(before).toHaveLength(0)
  })

  test('range.from and range.to accept Date inputs', async () => {
    const listing = await alice.market.sell({ asset: sword, amount: 1, price: 3 })
    await bob.market.accept(listing)
    const trade = (await bob.market.trades({ from: [alice.address], asset: sword }))[0]
    if (!trade) throw new Error('expected one trade')
    const upper = trade.settledAt ?? trade.seenAt
    if (!Number.isSafeInteger(upper)) {
      throw new Error('mock data produced no safe trade time for this test')
    }

    const within = await bob.market.trades({
      from: [alice.address],
      asset: sword,
      range: {
        from: new Date(upper - 1),
        to: new Date(upper),
      },
    })
    expect(within.map(({ hash }) => hash)).toEqual([trade.hash])
  })

  test('asOf accepts Date inputs and uses inclusive upper-bound semantics', async () => {
    const listing = await alice.market.sell({ asset: sword, amount: 1, price: 3 })
    await bob.market.accept(listing)
    const [trade] = await bob.market.trades({ from: [alice.address], asset: sword })
    if (!trade) throw new Error('expected one trade')
    const upper = trade.settledAt ?? trade.seenAt
    if (!Number.isSafeInteger(upper)) {
      throw new Error('mock data produced no safe trade time for this test')
    }

    const before = await bob.market.trades({
      from: [alice.address],
      asset: sword,
      asOf: new Date(upper - 1),
    })
    expect(before).toHaveLength(0)

    const equal = await bob.market.trades({
      from: [alice.address],
      asset: sword,
      asOf: new Date(upper),
    })
    expect(equal).toHaveLength(1)
    expect(equal[0]?.hash).toBe(trade.hash)
  })

  test('range.from and window cannot be mixed', async () => {
    const offer = await alice.market.sell({ asset: sword, amount: 1, price: 3 })
    await bob.market.accept(offer)
    const failure = (await bob.market.trades({
      from: [alice.address],
      asset: sword,
      window: '1h',
      range: { from: 0, to: 1 },
    }).catch((error: unknown) => error)) as { code?: string }
    expect(failure.code).toBe('bad-duration')
  })

  test('range.window and top-level window cannot be mixed', async () => {
    const offer = await alice.market.sell({ asset: sword, amount: 1, price: 3 })
    await bob.market.accept(offer)
    const failure = (await bob.market.trades({
      from: [alice.address],
      asset: sword,
      window: '1h',
      range: { window: '1m' },
    }).catch((error: unknown) => error)) as { code?: string }
    expect(failure.code).toBe('bad-duration')
  })
}) 

describe('a lying read model cannot move funds (SPEC §9.2, §9.4)', () => {
  test('a node that halves the asking price gets its accept refused by the ledger', async () => {
    const offer = await alice.market.sell({ asset: sword, amount: 1, price: 10 })
    const liar = new TwoFacedNode(world.node)
    liar.lieAboutOffer(offer.hash, (honest) => ({
      ...honest,
      wantAmount: (BigInt(honest.wantAmount) / 2n).toString(),
    }))
    const victim = await world.actor('victim', { node: liar })
    const before = await world.keiRaw(victim.address)

    // The wallet reads the lie, signs the lie's terms — and the ledger refuses
    // the restatement, because the accept must restate the *offer block's* own
    // terms exactly. The lie cost a refused block, never Kei.
    const outcome = await victim.market.accept(offer.hash).catch((error: unknown) => error)
    expect(outcome).toBeInstanceOf(KeiError)
    expect((outcome as KeiError).code).toBe('swap-terms-mismatch')
    expect(await world.keiRaw(victim.address)).toBe(before)
    expect((await world.node.swapOffer(offer.hash))?.state).toBe('open')
  })

  test('a node that swaps in a different give-asset is caught by { expect } before signing', async () => {
    const shield = await world.issue({ symbol: 'SHIELD' })
    await world.mint(shield, alice, 5)
    const offer = await alice.market.sell({ asset: shield, amount: 1, price: 10 })

    const liar = new TwoFacedNode(world.node)
    liar.lieAboutOffer(offer.hash, (honest) => ({ ...honest, asset: sword }))
    const victim = await world.actor('victim', { node: liar })

    const outcome = await victim.market
      .accept(offer.hash, { expect: { give: { asset: shield, amount: 1 } } })
      .catch((error: unknown) => error)
    // The lie flipped the item; the expectation the view rendered no longer
    // matches, and the wallet refuses to sign anything at all.
    expect(outcome).toBeInstanceOf(KeiError)
    expect((outcome as KeiError).code).toBe('offer-changed')
  })

  test('a node that denies an offer exists can hide it, and only hide it', async () => {
    const offer = await alice.market.sell({ asset: sword, amount: 1, price: 10 })
    const liar = new TwoFacedNode(world.node)
    liar.lieAboutOffer(offer.hash, () => null)
    const reader = await world.actor('reader', { node: liar })

    expect(await reader.market.get(offer.hash)).toBeNull()
    const report = await reader.market.reconcile([offer.hash])
    expect(report.unknown).toEqual([offer.hash])
    // The ledger still holds the lock; an honest reader still sees it.
    expect((await world.node.swapOffer(offer.hash))?.state).toBe('open')
  })

  test('a torn read — open in the page, cancelled at the lock — costs a block, not funds', async () => {
    const offer = await alice.market.sell({ asset: sword, amount: 1, price: 10 })
    const liar = new TwoFacedNode(world.node)
    // The page still shows the offer open; the ledger has moved on.
    liar.lieAboutOffer(offer.hash, (honest) => ({ ...honest, state: 'open', settledBy: null }))
    await alice.market.cancel(offer)

    const victim = await world.actor('victim', { node: liar })
    const before = await world.keiRaw(victim.address)
    const outcome = await victim.market.accept(offer.hash).catch((error: unknown) => error)
    expect(outcome).toBeInstanceOf(KeiError)
    expect((outcome as KeiError).code).toBe('offer-cancelled')
    expect(await world.keiRaw(victim.address)).toBe(before)
  })
})

describe('adversarial directories', () => {
  test('an oversized scope is a typed refusal before an aggregate node read', async () => {
    const accountSwaps = spyOn(bob.client.node, 'accountSwaps')
    const failure = await bob.market
      .book({
        from: Array<string>(MAX_ACCOUNTS_PER_WALK + 1).fill(alice.address),
        asset: sword,
      })
      .catch((error: unknown) => error)

    expect(isMarketError(failure, 'too-many-accounts')).toBe(true)
    expect(accountSwaps).toHaveBeenCalledTimes(0)
    accountSwaps.mockRestore()
  })

  test('a directory full of garbage is skipped and counted, never signed against', async () => {
    await alice.market.sell({ asset: sword, amount: 1, price: 5 })
    const junk = {
      accounts: () => [
        alice.address,
        '',
        'kei_' + '1'.repeat(60),
        'javascript:alert(1)',
        // Not alice: addresses are case-sensitive base32, so an uppercased
        // copy fails the checksum and must be junk, not a duplicate.
        alice.address.toUpperCase(),
      ],
    }
    const book = await bob.market.book({ from: junk, asset: sword })
    expect(book.asks).toHaveLength(1)
    expect(book.coverage.skipped.length, evidence('coverage', book.coverage)).toBe(4)
    expect(book.coverage.complete).toBe(false)
  })

  test('a directory that throws fails the read loudly rather than half-answering', async () => {
    const hostile = {
      accounts: (): readonly string[] => {
        throw new Error('directory backend down')
      },
    }
    await expect(bob.market.book({ from: hostile, asset: sword })).rejects.toThrow(
      'directory backend down',
    )
  })

  test('watch-flooding evicts quietly and the book says how many leads were lost', async () => {
    await alice.market.sell({ asset: sword, amount: 1, price: 5 })
    const directory = createDirectory({ limit: 8 })
    directory.watch(alice.address)
    for (let i = 0; i < 500; i++) directory.watch(syntheticAddress(i))

    expect(directory.size).toBe(8)
    expect(directory.dropped).toBe(493)
    const book = await bob.market.book({ from: directory, asset: sword })
    // The flood evicted the one seller; the book is empty and admits why.
    expect(book.asks).toHaveLength(0)
    expect(book.coverage.dropped).toBe(493)
    expect(book.coverage.complete).toBe(false)
  })

  test('re-announcing under flood keeps a live seller readable', async () => {
    await alice.market.sell({ asset: sword, amount: 1, price: 5 })
    const directory = createDirectory({ limit: 8 })
    for (let i = 0; i < 100; i++) {
      directory.watch(syntheticAddress(i))
      directory.watch(alice.address)
    }
    expect(directory.accounts()).toContain(alice.address)
    const book = await bob.market.book({ from: directory, asset: sword })
    expect(book.asks).toHaveLength(1)
  })
})
