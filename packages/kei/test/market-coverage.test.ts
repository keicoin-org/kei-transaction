/**
 * Every market read, against a real ledger, held to the three properties the
 * book already had and nothing else did.
 *
 * The defect these close is not a crash. It is a number that looks whole: a
 * A median over five sellers when one chain timed out used to answer from four
 * and say so nowhere. `price()` now labels that useful partial result; the
 * legacy scalar `medianPrice()` cannot carry provenance, so callers that need
 * completeness use the summary rather than the compatibility shortcut.
 *
 * The other two are cost. A walk that reads one chain at a time is a refresh
 * whose latency is the size of the roster, and a walk that cannot be stopped is
 * a poll that outlives the screen it was drawn for.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Kei, createDirectory, randomSeed, type Item, type KeiNode, type MockNode } from 'kei-transaction'

let node: MockNode
let game: Kei
let alice: Kei
let bob: Kei
let carol: Kei
let sword: Item
const opened: Kei[] = []

/** A node that answers `account_swaps` late, or not at all, for named chains. */
function slowNode(
  base: KeiNode,
  options: { delayMs?: number; breaks?: ReadonlySet<string>; onRead?: (account: string) => void } = {},
): KeiNode {
  return new Proxy(base, {
    get: (target, property, receiver) =>
      property === 'accountSwaps'
        ? async (address: string, swapOptions?: { limit?: number; state?: string }) => {
            options.onRead?.(address)
            if (options.breaks?.has(address)) throw new Error('node unreachable')
            if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
            return (target as KeiNode).accountSwaps(
              address,
              swapOptions as { limit?: number; state?: 'open' | 'accepted' | 'cancelled' } | undefined,
            )
          }
        : Reflect.get(target, property, receiver),
  }) as unknown as KeiNode
}

async function reader(against: KeiNode): Promise<Kei> {
  const wallet = await Kei.start({ node: against, seed: randomSeed(), autoCancelExpired: false })
  opened.push(wallet)
  return wallet
}

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
  await Promise.all([alice, bob, carol].map((player) => game.send(player.address, 1_000)))
  await Promise.all([alice.sync(), bob.sync(), carol.sync()])

  sword = await game.items.create({ name: 'Iron Sword', supply: 100 })
  const swords = await game.items.token(sword.id)
  await swords.mint(alice.address, 10)
  await swords.mint(carol.address, 10)
  await Promise.all([alice.sync(), carol.sync()])
})

afterEach(() => {
  for (const wallet of opened) wallet.close()
})

describe('a price is a statement about the chains that answered (SPEC §9.1)', () => {
  test('an unreachable seller lowers the median, and the summary says the read was short', async () => {
    await bob.market.accept(await alice.market.sell({ asset: sword, price: 4 }))
    await bob.market.accept(await carol.market.sell({ asset: sword, price: 100 }))

    const whole = await bob.market.price(sword, { from: [alice.address, carol.address] })
    expect(whole?.median).toBe(52)
    expect(whole?.trades).toBe(2)
    expect(whole?.coverage?.complete).toBe(true)

    // Carol's chain goes dark. The median is still a real number — it is just a
    // different market's median, and that is the whole point of the field.
    const blind = await reader(slowNode(node, { breaks: new Set([carol.address]) }))
    const partial = await blind.market.price(sword, { from: [alice.address, carol.address] })

    expect(partial?.median).toBe(4)
    expect(partial?.trades).toBe(1)
    expect(partial?.coverage?.complete).toBe(false)
    expect(partial?.coverage?.failed[0]?.account).toBe(carol.address)
    expect(partial?.coverage?.failed[0]?.reason).toContain('unreachable')
  })

  test('trades() carries the coverage the summary is built from', async () => {
    await bob.market.accept(await alice.market.sell({ asset: sword, price: 5 }))
    const blind = await reader(slowNode(node, { breaks: new Set([carol.address]) }))

    const trades = await blind.market.trades({ from: [alice.address, carol.address] })
    expect(trades).toHaveLength(1)
    expect(trades.coverage.asked).toBe(2)
    expect(trades.coverage.read).toBe(1)
    expect(trades.coverage.complete).toBe(false)
  })

  test('a series and its candles carry it too, so a chart can label itself', async () => {
    for (const price of [5, 7]) {
      await bob.market.accept(await alice.market.sell({ asset: sword, price }))
    }
    const blind = await reader(slowNode(node, { breaks: new Set([carol.address]) }))

    const series = await blind.market.series({ asset: sword, from: [alice.address, carol.address] })
    expect(series.points).toHaveLength(2)
    expect(series.coverage?.complete).toBe(false)
    expect(series.summary?.coverage?.complete).toBe(false)

    const candles = await blind.market.candles({
      asset: sword,
      from: [alice.address, carol.address],
      every: '1d',
    })
    expect(candles.coverage.complete).toBe(false)
  })

  test('prices() labels every row with the walk they all came out of', async () => {
    await bob.market.accept(await alice.market.sell({ asset: sword, price: 6 }))
    const blind = await reader(slowNode(node, { breaks: new Set([carol.address]) }))

    const prices = await blind.market.prices({ from: [alice.address, carol.address] })
    expect(prices.get(sword.id)?.last).toBe(6)
    expect(prices.coverage?.complete).toBe(false)
    expect(prices.get(sword.id)?.coverage?.complete).toBe(false)
  })

  test('a whole read still says so, which is what makes the false one worth reading', async () => {
    await bob.market.accept(await alice.market.sell({ asset: sword, price: 6 }))
    const trades = await bob.market.trades({ from: [alice.address] })
    expect(trades.coverage.complete).toBe(true)
    expect((await bob.market.price(sword, { from: [alice.address] }))?.coverage?.complete).toBe(true)
  })
})

describe('listings say what the walk could not see', () => {
  test('offers() carries coverage and keeps going past an unreachable chain', async () => {
    await alice.market.sell({ asset: sword, price: 4 })
    await carol.market.sell({ asset: sword, price: 5 })
    const blind = await reader(slowNode(node, { breaks: new Set([carol.address]) }))

    const listings = await blind.market.offers({ from: [alice.address, carol.address] })
    expect(listings).toHaveLength(1)
    expect(listings[0]?.from).toBe(alice.address)
    expect(listings.coverage.failed[0]?.account).toBe(carol.address)
    expect(listings.coverage.complete).toBe(false)
  })

  test('a full page is truncated rather than silently the whole shelf', async () => {
    await alice.market.sell({ asset: sword, price: 4 })
    await alice.market.sell({ asset: sword, price: 5 })

    const listings = await bob.market.offers({ from: alice.address, limit: 2 })
    expect(listings).toHaveLength(2)
    expect(listings.coverage.truncated).toEqual([alice.address])
    expect(listings.coverage.complete).toBe(false)
  })

  test('one bad entry in a roster is skipped, not the whole read', async () => {
    await alice.market.sell({ asset: sword, price: 4 })
    const listings = await bob.market.offers({ from: [alice.address, 'not-an-address'] })
    expect(listings).toHaveLength(1)
    expect(listings.coverage.skipped).toEqual(['not-an-address'])
  })

  test('a from with nothing walkable in it is still named as a caller mistake', async () => {
    await expect(bob.market.offers({ from: [] })).rejects.toThrow(/nothing to walk/i)
    // And when the reason is a typo, the message names the typo rather than
    // leaving "no accounts" to be read as "nobody is selling".
    await expect(bob.market.offers({ from: 'kei_not_real' })).rejects.toThrow(/not being a Kei address/i)
  })

  test('mine() carries it as well, so a stall knows if its own read was short', async () => {
    await alice.market.sell({ asset: sword, price: 4 })
    const own = await alice.market.mine()
    expect(own).toHaveLength(1)
    expect(own.coverage).toMatchObject({ asked: 1, read: 1, complete: true })
  })

  test('rows come back in the order the accounts were named, whoever answered first', async () => {
    await alice.market.sell({ asset: sword, price: 4 })
    await carol.market.sell({ asset: sword, price: 5 })

    // Alice's chain is the slow one, and is still first in the answer.
    const delayed = await reader(
      slowNode(node, {
        delayMs: 0,
        onRead: () => undefined,
      }),
    )
    const listings = await delayed.market.offers({ from: [alice.address, carol.address] })
    expect(listings.map((offer) => offer.from)).toEqual([alice.address, carol.address])

    const reversed = await delayed.market.offers({ from: [carol.address, alice.address] })
    expect(reversed.map((offer) => offer.from)).toEqual([carol.address, alice.address])
  })
})

describe('a walk is bounded, and a read can be stopped', () => {
  test('a roster is read in parallel, so latency stops being the size of the roster', async () => {
    await alice.market.sell({ asset: sword, price: 4 })
    const roster = [alice.address, ...(await extras(15))]

    // 16 chains at 20 ms each. One at a time is 16 round trips; eight at a time
    // is two. The assertion is the ratio rather than a wall-clock number,
    // because a CI box's absolute timings are nobody's business.
    const serial = await elapsed(async () => {
      const wallet = await reader(slowNode(node, { delayMs: 20 }))
      await wallet.market.book({ from: roster, asset: sword, concurrency: 1 })
    })
    const parallel = await elapsed(async () => {
      const wallet = await reader(slowNode(node, { delayMs: 20 }))
      await wallet.market.book({ from: roster, asset: sword })
    })

    expect(parallel).toBeLessThan(serial / 2)
  })

  test('the same rows come back whichever way it was read', async () => {
    await alice.market.sell({ asset: sword, price: 9 })
    await alice.market.sell({ asset: sword, price: 3 })
    await carol.market.sell({ asset: sword, price: 6 })
    const roster = [alice.address, carol.address]

    const one = await bob.market.book({ from: roster, asset: sword, concurrency: 1 })
    const many = await bob.market.book({ from: roster, asset: sword, concurrency: 16 })
    expect(many.asks.map((offer) => offer.hash)).toEqual(one.asks.map((offer) => offer.hash))
    expect(many.asks.map((offer) => offer.price)).toEqual([3, 6, 9])
  })

  test('an aborted read refuses with a code a poll can match on', async () => {
    await alice.market.sell({ asset: sword, price: 4 })
    const controller = new AbortController()
    const wallet = await reader(slowNode(node, { delayMs: 50 }))

    const reading = wallet.market.book({ from: [alice.address, carol.address], signal: controller.signal })
    controller.abort()

    const failure = (await reading.catch((error: unknown) => error)) as { code?: string; message?: string }
    expect(failure.code).toBe('read-aborted')
    expect(failure.message).toContain('Nothing was signed')
  })

  test('every walking read takes the signal, not just the book', async () => {
    const controller = new AbortController()
    controller.abort()
    const from = [alice.address]

    const reads: (() => Promise<unknown>)[] = [
      () => bob.market.offers({ from, signal: controller.signal }),
      () => bob.market.mine({ signal: controller.signal }),
      () => bob.market.trades({ from, signal: controller.signal }),
      () => bob.market.prices({ from, signal: controller.signal }),
      () => bob.market.series({ asset: sword, from, signal: controller.signal }),
      () => bob.market.candles({ asset: sword, from, every: '1h', signal: controller.signal }),
      () => bob.market.reconcile([sword.id], { signal: controller.signal }),
    ]
    for (const read of reads) {
      const failure = (await read().catch((error: unknown) => error)) as { code?: string }
      expect(failure.code).toBe('read-aborted')
    }
  })

  test('default trade history aborts while its direct account-history read is still in flight', async () => {
    const controller = new AbortController()
    let historySettled = false
    const hangingHistory = new Proxy(node, {
      get: (target, property, receiver) =>
        property === 'accountHistory'
          ? async (...args: Parameters<KeiNode['accountHistory']>) => {
              await new Promise((resolve) => setTimeout(resolve, 200))
              historySettled = true
              return target.accountHistory(...args)
            }
          : Reflect.get(target, property, receiver),
    }) as unknown as KeiNode
    const wallet = await reader(hangingHistory)

    const reading = wallet.market.trades({ signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort(new Error('history view closed'))

    const failure = (await reading.catch((error: unknown) => error)) as { code?: string; message?: string }
    expect(failure.code).toBe('read-aborted')
    expect(failure.message).toContain('history view closed')
    expect(historySettled).toBe(false)
  })

  test('every account-walk entry point rejects ambiguous or unbounded limits', async () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const reads: (() => Promise<unknown>)[] = [
        () => bob.market.book({ from: [alice.address], asset: sword, limit }),
        () => bob.market.offers({ from: [alice.address], limit }),
        () => bob.market.mine({ limit }),
        () => bob.market.trades({ from: [alice.address], limit }),
      ]
      for (const read of reads) {
        const failure = (await read().catch((error: unknown) => error)) as { code?: string }
        expect(failure.code).toBe('bad-limit')
      }
    }
  })
})

describe('reconcile — the poll a market view runs on a timer', () => {
  test('a listing whose re-read failed is reported as failed, never as gone', async () => {
    const standing = await alice.market.sell({ asset: sword, price: 4 })
    const sold = await alice.market.sell({ asset: sword, price: 5 })
    await bob.market.accept(sold)

    const flaky = new Proxy(node, {
      get: (target, property, receiver) =>
        property === 'swapOffer'
          ? async (hash: string) => {
              if (hash === standing.hash) throw new Error('node unreachable')
              return (target as MockNode).swapOffer(hash)
            }
          : Reflect.get(target, property, receiver),
    }) as unknown as KeiNode
    const wallet = await reader(flaky)

    const report = await wallet.market.reconcile([standing.hash, sold.hash])
    expect(report.failed).toEqual([{ hash: standing.hash, reason: 'node unreachable' }])
    // The property worth having: an unreachable node did not take a live listing
    // off the screen by reporting it sold.
    expect(report.gone.map((entry) => entry.hash)).toEqual([sold.hash])
    expect(report.live).toHaveLength(0)
  })

  test('the report follows the snapshot order, not the order the reads answered', async () => {
    const first = await alice.market.sell({ asset: sword, price: 4 })
    const second = await alice.market.sell({ asset: sword, price: 5 })
    const third = await carol.market.sell({ asset: sword, price: 6 })

    const report = await bob.market.reconcile([third.hash, first.hash, second.hash])
    expect(report.live.map((offer) => offer.hash)).toEqual([third.hash, first.hash, second.hash])
  })
})

describe('a directory read is still a floor, and now a fast one', () => {
  test('the whole aggregate surface agrees about what it could not see', async () => {
    await alice.market.sell({ asset: sword, price: 4 })
    const directory = createDirectory({ limit: 1 })
    directory.watch(alice.address)
    directory.watch(carol.address)

    const book = await bob.market.book({ from: directory, asset: sword })
    const listings = await bob.market.offers({ from: directory })
    expect(book.coverage.dropped).toBe(1)
    expect(listings.coverage.dropped).toBe(1)
    expect(listings.coverage.complete).toBe(false)
  })
})

async function extras(count: number): Promise<string[]> {
  const wallets = await Promise.all(
    Array.from({ length: count }, () => Kei.start({ node, seed: randomSeed(), autoCancelExpired: false })),
  )
  opened.push(...wallets)
  return wallets.map((wallet) => wallet.address)
}

async function elapsed(work: () => Promise<unknown>): Promise<number> {
  const started = performance.now()
  await work()
  return performance.now() - started
}
