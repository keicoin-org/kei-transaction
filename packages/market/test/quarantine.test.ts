/**
 * What a market does with an account whose swap rows cannot be parsed.
 *
 * The rows here are refused at the transport (`@keicoin/core`'s `swaps.ts`),
 * which leaves the market with a chain that threw — the same situation as a
 * chain that timed out, and it already has an answer for that: `walkAccounts`
 * keeps the accounts that answered and names the one that did not in
 * `coverage.failed`. That reuse is the point. A poisoned account costs a market
 * exactly one account's worth of coverage, and the caller can tell "three
 * offers" from "three offers and a chain I refused to read".
 *
 * Everything runs over a real `HttpNode` against the mock node's own RPC
 * handler, with one account's answers doctored on the wire. The ledger
 * underneath stays honest, so nothing here is a test of the mock.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { HttpNode, KeiError, MockNode, mockRpcHandler, type AssetId } from '@keicoin/core'
import { isMarketError } from '@keicoin/market'

import { World, type Actor } from './harness/world.js'

interface Wire {
  fetch: typeof globalThis.fetch
  /** Every action the wire carried, in order. */
  actions: string[]
  /** Answer `account_swaps` for this account with `body` instead of the truth. */
  poisonSwapsOf(account: string, body: unknown): void
  /** Answer `swap_info` for this offer with `body` instead of the truth. */
  poisonOfferOf(hash: string, body: unknown): void
}

function wireOver(node: MockNode): Wire {
  const handler = mockRpcHandler({ node })
  const actions: string[] = []
  const swaps = new Map<string, unknown>()
  const offers = new Map<string, unknown>()

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { action: string }
    actions.push(body.action)
    const doctored =
      body.action === 'account_swaps'
        ? swaps.get(String(body.account))
        : body.action === 'swap_info'
          ? offers.get(String(body.hash).toUpperCase())
          : undefined
    if (doctored !== undefined) {
      return new Response(JSON.stringify(doctored), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return handler(new Request(String(url), init))
  }) as unknown as typeof globalThis.fetch

  return {
    fetch: fetchImpl,
    actions,
    poisonSwapsOf: (account, body) => swaps.set(account, body),
    poisonOfferOf: (hash, body) => offers.set(hash.toUpperCase(), body),
  }
}

/**
 * The row from the issue: a forged hash, an account that never wrote it, an
 * amount `BigInt()` throws on, an impossible expiry, and settlement fields that
 * disagree with the state they claim.
 */
const POISON = {
  hash: 'F'.repeat(64),
  from: 'kei_wrong_account',
  asset: 'A'.repeat(64),
  amount: 'not-an-integer',
  wantAsset: 'B'.repeat(64),
  wantAmount: '1',
  counterparty: null,
  expiresAt: -1,
  state: 'accepted',
  settledBy: null,
  acceptedBy: null,
  height: 0,
  seenAt: -10,
  settledAt: null,
}

let world: World
let wire: Wire
let alice: Actor
let mallory: Actor
let reader: Actor
let sword: AssetId

beforeEach(async () => {
  world = await World.create()
  wire = wireOver(world.node)
  alice = await world.actor('alice')
  mallory = await world.actor('mallory')
  reader = await world.actor('reader', { node: httpNode() })
  sword = await world.issue({ symbol: 'SWORD' })
  await world.mint(sword, alice, 10)
  await world.mint(sword, mallory, 10)
})

afterEach(() => {
  world.close()
})

function httpNode(): HttpNode {
  return new HttpNode({
    url: 'http://node.test/rpc',
    network: 'mock',
    // Long enough that no background receivable poll runs inside a test.
    pollInterval: 600_000,
    fetch: wire.fetch,
  })
}

describe('one poisoned chain costs one account of coverage', () => {
  test('a book keeps the healthy asks and names the account it refused', async () => {
    await alice.market.sell({ asset: sword, amount: 1, price: 3 })
    await alice.market.sell({ asset: sword, amount: 1, price: 5 })
    await mallory.market.sell({ asset: sword, amount: 1, price: 1 })
    wire.poisonSwapsOf(mallory.address, { offers: [POISON] })

    const book = await reader.market.book({
      from: [alice.address, mallory.address],
      asset: sword,
    })

    expect(wire.actions).toContain('account_swaps')
    expect(book.asks.map((level) => level.price)).toEqual([3, 5])
    expect(book.coverage.asked).toBe(2)
    expect(book.coverage.read).toBe(1)
    expect(book.coverage.complete).toBe(false)
    expect(book.coverage.failed.map((failure) => failure.account)).toEqual([mallory.address])
    expect(book.coverage.failed[0]?.reason).toContain('cannot be trusted')
    // The refused chain is a gap, not an emptiness and not an outage: it is
    // distinct from `truncated`, from `skipped`, and from a chain that answered.
    expect(book.coverage.truncated).toEqual([])
    expect(book.coverage.skipped).toEqual([])
  })

  test('not one field of a refused row reaches the book', async () => {
    await alice.market.sell({ asset: sword, amount: 1, price: 3 })
    wire.poisonSwapsOf(mallory.address, { offers: [POISON, POISON] })

    const book = await reader.market.book({
      from: [alice.address, mallory.address],
      asset: sword,
    })
    const everything = [...book.asks, ...book.bids, ...book.other]
    expect(everything).toHaveLength(1)
    expect(everything.map((offer) => offer.hash)).not.toContain(POISON.hash)
    expect(everything.every((offer) => offer.from === alice.address)).toBe(true)
    expect(book.bestAsk?.price).toBe(3)
  })

  test('a good row in the same page as a bad one is refused with it', async () => {
    const honest = await mallory.market.sell({ asset: sword, amount: 1, price: 4 })
    const page = await world.node.accountSwaps(mallory.address, { state: 'open' })
    wire.poisonSwapsOf(mallory.address, { offers: [...page, POISON] })

    const book = await reader.market.book({ from: [mallory.address], asset: sword })

    // Keeping the parseable row and dropping the other one would publish a book
    // that is quietly missing a listing, which is the failure this refuses to
    // make: an offer that vanishes from one read and returns in the next is how
    // a double sale gets told as a story about the buyer.
    expect(book.asks).toHaveLength(0)
    expect(book.coverage.failed).toHaveLength(1)
    expect(await world.node.swapOffer(honest.hash)).not.toBeNull()
  })

  test('trade history quarantines the same way and keeps the rest', async () => {
    const offer = await alice.market.sell({ asset: sword, amount: 1, price: 7 })
    await mallory.market.accept(offer)
    wire.poisonSwapsOf(mallory.address, { offers: [POISON] })

    const trades = await reader.market.trades({
      from: [alice.address, mallory.address],
      asset: sword,
    })

    expect(trades.map((trade) => trade.price)).toEqual([7])
    expect(trades.coverage.read).toBe(1)
    expect(trades.coverage.failed.map((failure) => failure.account)).toEqual([mallory.address])
    expect(trades.coverage.complete).toBe(false)
  })
})

describe('a refused read is not an empty market', () => {
  test('every chain poisoned reads as no coverage rather than no offers', async () => {
    await alice.market.sell({ asset: sword, amount: 1, price: 3 })
    wire.poisonSwapsOf(alice.address, { offers: [POISON] })
    wire.poisonSwapsOf(mallory.address, { offers: 'nope' })

    const book = await reader.market.book({
      from: [alice.address, mallory.address],
      asset: sword,
    })

    expect(book.asks).toHaveLength(0)
    expect(book.coverage.read).toBe(0)
    expect(book.coverage.failed).toHaveLength(2)
    expect(book.coverage.complete).toBe(false)

    // The distinction the whole thing exists for: a shelf with nothing on it
    // answers the same question with `complete: true`.
    const empty = await reader.market.book({ from: [reader.address], asset: sword })
    expect(empty.asks).toHaveLength(0)
    expect(empty.coverage.complete).toBe(true)
    expect(empty.coverage.failed).toHaveLength(0)
  })

  test('an answer with no offers field in it is refused, not read as an empty chain', async () => {
    wire.poisonSwapsOf(alice.address, {})
    const book = await reader.market.book({ from: [alice.address], asset: sword })
    expect(book.coverage.failed).toHaveLength(1)
    expect(book.coverage.complete).toBe(false)
  })
})

describe('execution fails closed', () => {
  test('a malformed swap_info stops an accept before anything is signed', async () => {
    const offer = await alice.market.sell({ asset: sword, amount: 1, price: 6 })
    wire.poisonOfferOf(offer.hash, { offer: { ...POISON, hash: offer.hash } })
    wire.actions.length = 0

    const error = await reader.market.accept(offer.hash).then(
      () => new Error('the accept went through'),
      (reason: unknown) => reason,
    )

    expect(error).toBeInstanceOf(KeiError)
    expect((error as KeiError).code).toBe('invalid-node-response')
    expect(wire.actions).toContain('swap_info')
    expect(wire.actions).not.toContain('process')
    expect((await world.node.swapOffer(offer.hash))?.state).toBe('open')
  })

  test('an accept that is answered with another offer is refused', async () => {
    const offer = await alice.market.sell({ asset: sword, amount: 1, price: 6 })
    const other = await alice.market.sell({ asset: sword, amount: 1, price: 9 })
    const substitute = await world.node.swapOffer(other.hash)
    wire.poisonOfferOf(offer.hash, { offer: substitute })
    wire.actions.length = 0

    const error = await reader.market.accept(offer.hash).then(
      () => new Error('the accept went through'),
      (reason: unknown) => reason,
    )

    expect((error as KeiError).code).toBe('invalid-node-response')
    expect(wire.actions).not.toContain('process')
    // A core refusal, deliberately: it is not the market's `offer-changed`,
    // because nothing about the offer changed — the answer was to another
    // question entirely.
    expect(isMarketError(error)).toBe(false)
  })
})
