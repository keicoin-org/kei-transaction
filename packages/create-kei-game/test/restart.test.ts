/**
 * The generated game, stopped and started again — and killed mid-purchase.
 *
 * `purchase.test.ts` plays the game through in one process, which is where the
 * interesting failures are not. A `Map` of delivered payments is exactly right
 * until the process holding it exits, and then it is wrong in three ways at
 * once: a payment that arrived while the game was down is never announced to
 * anyone, a repost of a delivered payment finds nothing and times out, and — the
 * expensive one — if the payment is rediscovered while the delivery is not, the
 * "you already have a lantern" branch refunds the price of a lantern the player
 * kept, which makes the item free.
 *
 * Counting per wallet does not fix that, which is the sharpest thing this file
 * has to say. Two payments from one wallet and one answer written back is a
 * state where "one answer is still owed" is true and names nothing: a repost of
 * the *answered* payment spends the *unanswered* one's credit, and the same hash
 * walks away with a lantern and a refund. So the game writes down which hash it
 * is about to answer, before it answers it, and the chain is asked only whether
 * that one answer landed.
 *
 * These tests restart the game against the same node and the same issuer seed,
 * the way `bun run dev` does after a crash, and reproduce on the disk exactly
 * what a crash at each step of that write leaves behind.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Kei, MockNode, randomSeed, type Block, type KeiNode, type PlayerToken } from 'kei-transaction'

import { projectFrom } from '../src/naming.js'
import { scaffold } from '../src/scaffold.js'
import { writeFiles } from '../src/write.js'

type LanternOutcome =
  | { outcome: 'delivered'; item: string }
  | { outcome: 'refunded'; amount: number; reason: string }

interface GeneratedGame {
  address: string
  catalogue(): { issuer: string; lantern: { asset: string; price: number } }
  buyLantern(address: string, hash: string): Promise<LanternOutcome>
  close(): void
}

interface StartGame {
  (options: { seed: string; node: KeiNode; network: 'mock'; orders: string }): Promise<GeneratedGame>
}

const directory = join(import.meta.dir, '..', '.generated', 'restart')

let startGame: StartGame

beforeAll(async () => {
  await rm(directory, { recursive: true, force: true })
  const project = projectFrom({ name: 'Star Clicker', currency: 'Gold Pieces' })
  await writeFiles(directory, await scaffold(project, { sdkVersion: '^0.3.0' }))
  ;({ startGame } = (await import(pathToFileURL(join(directory, 'server', 'game.ts')).href)) as {
    startGame: StartGame
  })
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

interface Deployment {
  orders: string
  node: MockNode
  issuer: string
  boot(node?: KeiNode): Promise<GeneratedGame>
}

/**
 * One game, restartable: the same seed and the same node every time, which is
 * what a process that comes back up has. `orders` is a path per test rather than
 * a shared one, so the cases do not read each other's answers.
 */
async function deployment(name: string): Promise<Deployment> {
  const seed = randomSeed()
  const orders = join(directory, '.kei', `${name}.ndjson`)
  const node = await MockNode.create()

  // Booted and closed once, so the issuer's address is known before any test
  // body needs it — reading its frontier is how a crash is staged below.
  const first = await startGame({ seed, node, network: 'mock', orders })
  const issuer = first.address
  first.close()

  return {
    orders,
    node,
    issuer,
    boot: (against?: KeiNode) => startGame({ seed, node: against ?? node, network: 'mock', orders }),
  }
}

/** A player with money, on the same chain, holding their own key. */
async function player(node: KeiNode): Promise<Kei> {
  const kei = await Kei.start({ node, network: 'mock', seed: randomSeed() })
  await kei.faucet(1)
  return kei
}

async function until(what: string, ready: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await Bun.sleep(25)
  }
}

/** Everything an answer would move, read off the chain rather than from the game. */
async function holdings(kei: Kei, lanterns: PlayerToken): Promise<{ kei: number; lanterns: number }> {
  await kei.sync()
  return { kei: await kei.balance(), lanterns: await lanterns.balanceOf(kei.address) }
}

const settle = (kei: Kei, node: MockNode): Promise<void> =>
  until('the chain to settle', async () => (await kei.sync(), (await node.receivables(kei.address)).length === 0))

// ------------------------------------------------------------------ the journal

interface Entry {
  k: 'intent' | 'done' | 'void'
  hash: string
  address?: string
  outcome?: LanternOutcome
}

const lines = (path: string): string[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')

const entries = (path: string): Entry[] => lines(path).map((line) => JSON.parse(line) as Entry)

/** Rewrite the log. `torn` is appended without its newline, the way a crash mid-append leaves it. */
function rewrite(path: string, kept: string[], torn?: string): void {
  const body = kept.map((line) => `${line}\n`).join('')
  writeFileSync(path, torn === undefined ? body : `${body}${torn}`)
}

/**
 * A node that takes a block, keeps it, and then dies — the one failure a caller
 * cannot tell from "it never landed", and the reason the game asks the chain
 * rather than believing the error.
 */
function diesAfterAccepting(node: MockNode, when: (block: Block) => boolean): KeiNode {
  let armed = true
  const wrapped = Object.create(node) as KeiNode & { process: KeiNode['process'] }
  wrapped.process = async (block: Block) => {
    const accepted = await node.process(block)
    if (armed && when(block)) {
      armed = false
      throw new Error('the node accepted the block and then the connection died')
    }
    return accepted
  }
  return wrapped
}

const isMintOf = (item: string) => (block: Block) =>
  block.type === 'asset' && block.op.kind === 'mint' && block.op.asset === item

const isSend = (block: Block): boolean => block.type === 'state' && block.subtype === 'send'

interface Kept {
  node: KeiNode
  /** Whether the block this wrapper was waiting for has been taken and not answered for. */
  kept(): boolean
  /**
   * Offer the kept block back to the real node — the late acceptance. False if
   * the chain has moved past the slot it was signed against and it no longer fits.
   */
  accept(): Promise<boolean>
  /** Answer again, the way a node that was unreachable comes back. */
  revive(): void
}

/**
 * A node that takes one block, keeps it, and fails the request that carried it.
 *
 * This is the failure `diesAfterAccepting` above does not cover, and the harder
 * one: there, the block is on the chain before the caller sees the error, so a
 * single look finds it. Here the error comes *first* — a timeout on the way in,
 * a lost reply, a leader that committed after the connection went — and the look
 * that follows sees an empty chain. "Not there" and "not there yet" are the same
 * read, and only one of them is safe to act on.
 *
 * Nothing is timed: `accept()` is when the late acceptance happens, so a test
 * decides the interleaving rather than a sleep. With `thenStall` the node goes
 * quiet after keeping the block, which is the case where even the door cannot be
 * shut and the answer has to stay unknown.
 */
function keeps(node: MockNode, when: (block: Block) => boolean, options: { thenStall?: boolean } = {}): Kept {
  let held: Block | undefined
  let stalled = false
  const unreachable = (): never => {
    throw new Error('the node did not answer')
  }

  const wrapped = Object.create(node) as KeiNode & {
    process: KeiNode['process']
    accountInfo: KeiNode['accountInfo']
    accountHistory: KeiNode['accountHistory']
  }
  wrapped.process = async (block: Block) => {
    if (stalled) unreachable()
    if (held === undefined && when(block)) {
      held = block
      stalled = options.thenStall === true
      unreachable()
    }
    return node.process(block)
  }
  wrapped.accountInfo = async (address: string) => (stalled ? unreachable() : node.accountInfo(address))
  wrapped.accountHistory = async (address: string, query?: { limit?: number }) =>
    stalled ? unreachable() : node.accountHistory(address, query)

  return {
    node: wrapped,
    kept: () => held !== undefined,
    revive: () => {
      stalled = false
    },
    async accept() {
      if (!held) throw new Error('Nothing was kept: the block this test is about was never submitted.')
      try {
        await node.process(held)
        return true
      } catch {
        return false
      }
    },
  }
}

/** The reported shape: fail the request, and hand the block to the node `afterMs` later. */
function acceptsLate(node: MockNode, when: (block: Block) => boolean, afterMs: number): KeiNode {
  let armed = true
  const wrapped = Object.create(node) as KeiNode & { process: KeiNode['process'] }
  wrapped.process = async (block: Block) => {
    if (armed && when(block)) {
      armed = false
      setTimeout(() => void node.process(block).catch(() => undefined), afterMs)
      throw new Error('the node did not answer, and kept the block')
    }
    return node.process(block)
  }
  return wrapped
}

// -------------------------------------------------------------------- the tests

describe('the generated game, restarted', () => {
  test(
    'a delivered payment reposted after a restart gets the same answer, and no refund',
    async () => {
      const game = await deployment('same-answer')
      const first = await game.boot()
      const kei = await player(game.node)

      try {
        const catalogue = first.catalogue()
        const lanterns = await kei.token(catalogue.lantern.asset)
        const receipt = await kei.pay({ to: catalogue.issuer, amount: catalogue.lantern.price })

        const delivered = await first.buyLantern(kei.address, receipt.hash)
        expect(delivered).toEqual({ outcome: 'delivered', item: catalogue.lantern.asset })
        await until('the lantern to arrive', async () => (await lanterns.balanceOf(kei.address)) === 1)
        const settled = await holdings(kei, lanterns)

        // The process goes away. Everything it knew about that payment goes with
        // it, except what it wrote down and what is on the chain.
        first.close()

        const second = await game.boot()
        try {
          const again = await second.buyLantern(kei.address, receipt.hash)
          expect(again).toEqual({ outcome: 'delivered', item: catalogue.lantern.asset })

          // One lantern, and not a coin back: a second answer to one payment is
          // the bug, whichever direction it goes in.
          expect(await holdings(kei, lanterns)).toEqual(settled)
          expect(await game.node.receivables(kei.address)).toEqual([])
        } finally {
          second.close()
        }
      } finally {
        kei.close()
      }
    },
    60_000,
  )

  test(
    'a payment made while the game is down is still redeemable when it comes back',
    async () => {
      const game = await deployment('while-down')
      const first = await game.boot()
      const catalogue = first.catalogue()
      const kei = await player(game.node)

      try {
        // Down first, and paid after: nothing is watching when the block lands,
        // so the next process collects it inside `Kei.server()` — before it has
        // anywhere to report the arrival to. Reading the chain back is the only
        // thing that finds it.
        first.close()
        const receipt = await kei.pay({ to: catalogue.issuer, amount: catalogue.lantern.price })

        const second = await game.boot()
        try {
          expect(await second.buyLantern(kei.address, receipt.hash)).toEqual({
            outcome: 'delivered',
            item: catalogue.lantern.asset,
          })

          const lanterns = await kei.token(catalogue.lantern.asset)
          await until('the lantern to arrive', async () => (await lanterns.balanceOf(kei.address)) === 1)
        } finally {
          second.close()
        }
      } finally {
        kei.close()
      }
    },
    60_000,
  )

  test(
    'two payments across a restart keep their own answers, and neither is answered twice',
    async () => {
      const game = await deployment('two-payments')
      const first = await game.boot()
      const kei = await player(game.node)

      try {
        const catalogue = first.catalogue()
        const lanterns = await kei.token(catalogue.lantern.asset)
        const price = catalogue.lantern.price

        const bought = await kei.pay({ to: catalogue.issuer, amount: price })
        expect(await first.buyLantern(kei.address, bought.hash)).toEqual({
          outcome: 'delivered',
          item: catalogue.lantern.asset,
        })
        await until('the lantern to arrive', async () => (await lanterns.balanceOf(kei.address)) === 1)

        // A second payment for a second lantern. There is only one per player,
        // so this one is refunded — and the refund is an answer like any other.
        const spare = await kei.pay({ to: catalogue.issuer, amount: price })
        expect(await first.buyLantern(kei.address, spare.hash)).toEqual({
          outcome: 'refunded',
          amount: price,
          reason: 'You already have a lantern.',
        })
        await settle(kei, game.node)
        const settled = await holdings(kei, lanterns)
        first.close()

        const second = await game.boot()
        try {
          // Reposted in the other order, so nothing can be right by position.
          expect(await second.buyLantern(kei.address, spare.hash)).toEqual({
            outcome: 'refunded',
            amount: price,
            reason: 'You already have a lantern.',
          })
          expect(await second.buyLantern(kei.address, bought.hash)).toEqual({
            outcome: 'delivered',
            item: catalogue.lantern.asset,
          })

          // One lantern, one refund, two payments. Neither repost moved a thing.
          expect(await holdings(kei, lanterns)).toEqual(settled)
          expect(await game.node.receivables(kei.address)).toEqual([])
        } finally {
          second.close()
        }
      } finally {
        kei.close()
      }
    },
    60_000,
  )
})

describe('one wallet, two payments, and a log that lost its last line', () => {
  test(
    'the answered payment is named, so replaying it cannot spend the unanswered one',
    async () => {
      const game = await deployment('no-credit-stealing')
      const first = await game.boot()
      const kei = await player(game.node)

      try {
        const catalogue = first.catalogue()
        const lanterns = await kei.token(catalogue.lantern.asset)
        const price = catalogue.lantern.price

        // A is paid and answered. B is paid and never redeemed — so the chain
        // shows this wallet two payments and one answer, and nothing on the
        // chain says which of the two that answer was for.
        const a = await kei.pay({ to: catalogue.issuer, amount: price })
        expect(await first.buyLantern(kei.address, a.hash)).toEqual({
          outcome: 'delivered',
          item: catalogue.lantern.asset,
        })
        await until('the lantern to arrive', async () => (await lanterns.balanceOf(kei.address)) === 1)
        const b = await kei.pay({ to: catalogue.issuer, amount: price })
        await until('the second payment to be collected', async () => {
          return (await game.node.receivables(game.issuer)).length === 0
        })
        first.close()

        // The crash took the last line with it: A's delivery is on the chain and
        // its `done` is gone, leaving the `intent` that named it open.
        const written = lines(game.orders)
        expect(entries(game.orders).at(-1)?.k).toBe('done')
        rewrite(game.orders, written.slice(0, -1))
        expect(entries(game.orders).at(-1)).toMatchObject({ k: 'intent', hash: a.hash })

        const settled = await holdings(kei, lanterns)
        const second = await game.boot()
        try {
          // Startup reads the chain over exactly the window that intent opened
          // and finds the mint, so A is delivered again rather than counted as
          // an outstanding credit. A count would have refunded here: two
          // payments, one answer, therefore "one is owed" — and the wallet would
          // have kept the lantern and taken the price of it back.
          expect(await second.buyLantern(kei.address, a.hash)).toEqual({
            outcome: 'delivered',
            item: catalogue.lantern.asset,
          })
          expect(await holdings(kei, lanterns)).toEqual(settled)

          // And B, which really is unanswered, still gets its own answer.
          expect(await second.buyLantern(kei.address, b.hash)).toEqual({
            outcome: 'refunded',
            amount: price,
            reason: 'You already have a lantern.',
          })
          await settle(kei, game.node)
          expect(await holdings(kei, lanterns)).toEqual({ ...settled, kei: settled.kei + price })
        } finally {
          second.close()
        }
      } finally {
        kei.close()
      }
    },
    60_000,
  )

  test(
    'with the log gone entirely, both payments are refused rather than guessed at',
    async () => {
      const game = await deployment('lost-log')
      const first = await game.boot()
      const kei = await player(game.node)

      try {
        const catalogue = first.catalogue()
        const lanterns = await kei.token(catalogue.lantern.asset)
        const price = catalogue.lantern.price

        const a = await kei.pay({ to: catalogue.issuer, amount: price })
        await first.buyLantern(kei.address, a.hash)
        await until('the lantern to arrive', async () => (await lanterns.balanceOf(kei.address)) === 1)
        const b = await kei.pay({ to: catalogue.issuer, amount: price })
        await until('the second payment to be collected', async () => {
          return (await game.node.receivables(game.issuer)).length === 0
        })
        first.close()

        // A wiped disk, or a fresh container with no volume. The chain still
        // shows an answer to this wallet and nothing can say which payment it
        // was for, so neither payment can be answered — including B, which
        // genuinely is owed one. That is the cost, and it is the right way round:
        // the alternative is refunding a lantern the player is still holding.
        await rm(game.orders, { force: true })

        const settled = await holdings(kei, lanterns)
        const second = await game.boot()
        try {
          await expect(second.buyLantern(kei.address, a.hash)).rejects.toThrow(/already been answered/)
          await expect(second.buyLantern(kei.address, b.hash)).rejects.toThrow(/already been answered/)

          await Bun.sleep(200)
          expect(await holdings(kei, lanterns)).toEqual(settled)
          expect(await game.node.receivables(kei.address)).toEqual([])
        } finally {
          second.close()
        }
      } finally {
        kei.close()
      }
    },
    60_000,
  )
})

/**
 * The four writes a purchase makes, and a crash between each pair of them:
 *
 *   read the frontier → fsync `intent` → mint or refund → fsync `done`
 *
 * Each test puts the disk and the chain into exactly the state that crash
 * leaves, boots, and asks what the game says. What must hold everywhere is that
 * one hash gets one answer: never two, and never the other one.
 */
describe('a crash at every boundary of one purchase', () => {
  /** Pay, then stop the game with the payment collected and unanswered. */
  async function paidAndStopped(name: string): Promise<{
    game: Deployment
    kei: Kei
    lanterns: PlayerToken
    item: string
    price: number
    hash: string
  }> {
    const game = await deployment(name)
    const running = await game.boot()
    const catalogue = running.catalogue()
    const kei = await player(game.node)
    const receipt = await kei.pay({ to: catalogue.issuer, amount: catalogue.lantern.price })
    await until('the payment to be collected', async () => (await game.node.receivables(game.issuer)).length === 0)
    running.close()
    return {
      game,
      kei,
      lanterns: await kei.token(catalogue.lantern.asset),
      item: catalogue.lantern.asset,
      price: catalogue.lantern.price,
      hash: receipt.hash,
    }
  }

  /** An `intent` line the game would have written, for a frontier it would have read. */
  async function intentLine(game: Deployment, kei: Kei, hash: string, price: number): Promise<string> {
    const info = await game.node.accountInfo(game.issuer)
    return JSON.stringify({
      k: 'intent',
      issuer: game.issuer,
      hash,
      address: kei.address,
      plan: 'deliver',
      amount: price,
      since: info?.frontier,
    })
  }

  test(
    'before the intent is written: nothing on the disk, nothing on the chain, and the payment still works',
    async () => {
      const { game, kei, lanterns, item, hash } = await paidAndStopped('before-intent')
      try {
        expect(lines(game.orders)).toEqual([])

        const back = await game.boot()
        try {
          expect(await back.buyLantern(kei.address, hash)).toEqual({ outcome: 'delivered', item })
          await until('the lantern to arrive', async () => (await lanterns.balanceOf(kei.address)) === 1)
        } finally {
          back.close()
        }
      } finally {
        kei.close()
      }
    },
    60_000,
  )

  test(
    'while the intent is being written: the half-line is dropped, and nothing was done under it',
    async () => {
      const { game, kei, lanterns, item, price, hash } = await paidAndStopped('torn-intent')
      try {
        // The action comes strictly after this write returns, so a line torn by
        // the crash is a line nothing was ever done under. Dropping it is safe.
        const whole = await intentLine(game, kei, hash, price)
        rewrite(game.orders, [], whole.slice(0, Math.floor(whole.length / 2)))

        const back = await game.boot()
        try {
          expect(await back.buyLantern(kei.address, hash)).toEqual({ outcome: 'delivered', item })
          await until('the lantern to arrive', async () => (await lanterns.balanceOf(kei.address)) === 1)
        } finally {
          back.close()
        }
      } finally {
        kei.close()
      }
    },
    60_000,
  )

  test(
    'after the intent and before the block: the intent is voided, and the payment is answered normally',
    async () => {
      const { game, kei, lanterns, item, price, hash } = await paidAndStopped('intent-only')
      try {
        rewrite(game.orders, [await intentLine(game, kei, hash, price)])
        const before = await holdings(kei, lanterns)

        const back = await game.boot()
        try {
          // Startup looked for a mint or a refund after that frontier, found
          // neither, and said so on the disk before serving anything.
          expect(entries(game.orders).some((entry) => entry.k === 'void' && entry.hash === hash)).toBe(true)
          expect(await holdings(kei, lanterns)).toEqual(before)

          expect(await back.buyLantern(kei.address, hash)).toEqual({ outcome: 'delivered', item })
          await until('the lantern to arrive', async () => (await lanterns.balanceOf(kei.address)) === 1)
        } finally {
          back.close()
        }
      } finally {
        kei.close()
      }
    },
    60_000,
  )

  test(
    'while the block is being written, and it landed: the mint is found and claimed by the hash that intended it',
    async () => {
      const game = await deployment('mint-landed')
      const running = await game.boot()
      const catalogue = running.catalogue()
      const kei = await player(game.node)

      try {
        const lanterns = await kei.token(catalogue.lantern.asset)
        const receipt = await kei.pay({ to: catalogue.issuer, amount: catalogue.lantern.price })
        expect(await running.buyLantern(kei.address, receipt.hash)).toEqual({
          outcome: 'delivered',
          item: catalogue.lantern.asset,
        })
        await until('the lantern to arrive', async () => (await lanterns.balanceOf(kei.address)) === 1)
        running.close()

        // The mint is on the chain and the `done` never reached the disk. This
        // is also, exactly, what a crash between the two looks like: the game
        // cannot tell them apart and does not have to.
        rewrite(game.orders, lines(game.orders).slice(0, -1))
        const settled = await holdings(kei, lanterns)

        const back = await game.boot()
        try {
          expect(entries(game.orders).at(-1)).toMatchObject({ k: 'done', hash: receipt.hash })
          expect(await back.buyLantern(kei.address, receipt.hash)).toEqual({
            outcome: 'delivered',
            item: catalogue.lantern.asset,
          })
          expect(await holdings(kei, lanterns)).toEqual(settled)
        } finally {
          back.close()
        }
      } finally {
        kei.close()
      }
    },
    60_000,
  )

  test(
    'while the record is being written: the torn line is dropped and the same answer is recovered',
    async () => {
      const game = await deployment('torn-done')
      const running = await game.boot()
      const catalogue = running.catalogue()
      const kei = await player(game.node)

      try {
        const lanterns = await kei.token(catalogue.lantern.asset)
        const receipt = await kei.pay({ to: catalogue.issuer, amount: catalogue.lantern.price })
        await running.buyLantern(kei.address, receipt.hash)
        await until('the lantern to arrive', async () => (await lanterns.balanceOf(kei.address)) === 1)
        running.close()

        const written = lines(game.orders)
        const done = written.at(-1) ?? ''
        rewrite(game.orders, written.slice(0, -1), done.slice(0, Math.floor(done.length / 2)))
        const settled = await holdings(kei, lanterns)

        const back = await game.boot()
        try {
          expect(await back.buyLantern(kei.address, receipt.hash)).toEqual({
            outcome: 'delivered',
            item: catalogue.lantern.asset,
          })
          expect(await holdings(kei, lanterns)).toEqual(settled)
          expect(await game.node.receivables(kei.address)).toEqual([])
        } finally {
          back.close()
        }
      } finally {
        kei.close()
      }
    },
    60_000,
  )

  test(
    'a refund crash is recovered as a refund, and the delivery before it is not mistaken for one',
    async () => {
      const game = await deployment('refund-landed')
      const running = await game.boot()
      const catalogue = running.catalogue()
      const kei = await player(game.node)

      try {
        const lanterns = await kei.token(catalogue.lantern.asset)
        const price = catalogue.lantern.price

        const bought = await kei.pay({ to: catalogue.issuer, amount: price })
        await running.buyLantern(kei.address, bought.hash)
        await until('the lantern to arrive', async () => (await lanterns.balanceOf(kei.address)) === 1)

        const spare = await kei.pay({ to: catalogue.issuer, amount: price })
        expect(await running.buyLantern(kei.address, spare.hash)).toEqual({
          outcome: 'refunded',
          amount: price,
          reason: 'You already have a lantern.',
        })
        await settle(kei, game.node)
        running.close()

        // The refund's `done` is lost. Its intent's window starts after the mint,
        // so the delivery this wallet already had cannot be read as this
        // payment's answer — which is the whole point of recording the frontier.
        rewrite(game.orders, lines(game.orders).slice(0, -1))
        const settled = await holdings(kei, lanterns)

        const back = await game.boot()
        try {
          expect(entries(game.orders).at(-1)).toMatchObject({
            k: 'done',
            hash: spare.hash,
            outcome: { outcome: 'refunded', amount: price },
          })
          expect(await back.buyLantern(kei.address, spare.hash)).toEqual({
            outcome: 'refunded',
            amount: price,
            reason: 'You already have a lantern.',
          })
          expect(await back.buyLantern(kei.address, bought.hash)).toEqual({
            outcome: 'delivered',
            item: catalogue.lantern.asset,
          })

          // Not a second refund, and not a second lantern.
          expect(await holdings(kei, lanterns)).toEqual(settled)
          expect(await game.node.receivables(kei.address)).toEqual([])
        } finally {
          back.close()
        }
      } finally {
        kei.close()
      }
    },
    60_000,
  )

  test(
    'a node that keeps the block and then dies is not taken at its word',
    async () => {
      const game = await deployment('accepted-then-died')
      const probe = await game.boot()
      const catalogue = probe.catalogue()
      probe.close()

      const running = await game.boot(diesAfterAccepting(game.node, isMintOf(catalogue.lantern.asset)))
      const kei = await player(game.node)

      try {
        const lanterns = await kei.token(catalogue.lantern.asset)
        const receipt = await kei.pay({ to: catalogue.issuer, amount: catalogue.lantern.price })

        // `items.mint()` rejects, and the mint is on the chain regardless. The
        // game asks the chain over the window its own intent opened rather than
        // believing the error, so the player is told what actually happened.
        expect(await running.buyLantern(kei.address, receipt.hash)).toEqual({
          outcome: 'delivered',
          item: catalogue.lantern.asset,
        })
        await until('the lantern to arrive', async () => (await lanterns.balanceOf(kei.address)) === 1)
        expect(entries(game.orders).at(-1)).toMatchObject({ k: 'done', hash: receipt.hash })
        const settled = await holdings(kei, lanterns)
        running.close()

        // And it survives the restart, because it was written down as an answer
        // rather than as a failure.
        const back = await game.boot()
        try {
          expect(await back.buyLantern(kei.address, receipt.hash)).toEqual({
            outcome: 'delivered',
            item: catalogue.lantern.asset,
          })
          expect(await holdings(kei, lanterns)).toEqual(settled)
        } finally {
          back.close()
        }
      } finally {
        kei.close()
      }
    },
    60_000,
  )
})

/**
 * A block the node refuses and then accepts.
 *
 * This is the failure that makes an immediate look at the chain worthless as
 * proof. The submit throws, the game asks the chain, the chain has nothing yet —
 * and if that is written down as "nothing happened", the block landing a moment
 * later gives the same payment a second answer. The expensive direction is the
 * one that costs money: the mint lands, the next post finds a player who already
 * owns a lantern, and refunds what they paid for it. One payment, one lantern,
 * and its price back.
 *
 * So absence is made true rather than observed. Before anything is written down,
 * the game puts a block of its own on the chain; one account has one chain, so
 * whatever was in flight is building on a slot that is now taken and can never
 * be accepted. Only then does an empty window mean the action never happened —
 * and when even that cannot be done, the answer stays unknown and the payment
 * stays open rather than being closed on a guess.
 */
describe('a node that refuses a block and takes it afterwards', () => {
  test(
    'a mint accepted after it was refused does not turn the payment into a refund',
    async () => {
      const game = await deployment('late-mint')
      const probe = await game.boot()
      const catalogue = probe.catalogue()
      probe.close()

      const node = keeps(game.node, isMintOf(catalogue.lantern.asset))
      const running = await game.boot(node.node)
      const kei = await player(game.node)

      try {
        const lanterns = await kei.token(catalogue.lantern.asset)
        const receipt = await kei.pay({ to: catalogue.issuer, amount: catalogue.lantern.price })
        await until('the payment to be collected', async () => (await game.node.receivables(game.issuer)).length === 0)
        const paid = await holdings(kei, lanterns)

        // The mint is kept and the request fails. Nothing is on the chain, which
        // is the reading that must not be mistaken for a decision.
        await expect(running.buyLantern(kei.address, receipt.hash)).rejects.toThrow()
        expect(node.kept()).toBe(true)

        // The late acceptance, offered now. It no longer fits: the game wrote
        // its own block on that slot before it wrote anything down.
        expect(await node.accept()).toBe(false)

        // So the payment is still owed an answer, and gets exactly one.
        expect(await running.buyLantern(kei.address, receipt.hash)).toEqual({
          outcome: 'delivered',
          item: catalogue.lantern.asset,
        })
        await until('the lantern to arrive', async () => (await lanterns.balanceOf(kei.address)) === 1)
        await settle(kei, game.node)

        // One lantern, and the price of it gone. A refund here would be the bug
        // reported: the lantern, for free.
        expect(await holdings(kei, lanterns)).toEqual({ kei: paid.kei, lanterns: 1 })
        expect(await game.node.receivables(kei.address)).toEqual([])
      } finally {
        running.close()
        kei.close()
      }
    },
    60_000,
  )

  test(
    'a refund accepted after it was refused is not paid a second time',
    async () => {
      const game = await deployment('late-refund')
      // The issuer sends Kei for one reason, so any send from it is the refund.
      const node = keeps(game.node, isSend)
      const running = await game.boot(node.node)
      const catalogue = running.catalogue()
      const kei = await player(game.node)

      try {
        const lanterns = await kei.token(catalogue.lantern.asset)
        const price = catalogue.lantern.price

        const bought = await kei.pay({ to: catalogue.issuer, amount: price })
        expect(await running.buyLantern(kei.address, bought.hash)).toEqual({
          outcome: 'delivered',
          item: catalogue.lantern.asset,
        })
        await until('the lantern to arrive', async () => (await lanterns.balanceOf(kei.address)) === 1)

        // A second payment, which this game answers by giving it back. That
        // refund is refused and kept.
        const spare = await kei.pay({ to: catalogue.issuer, amount: price })
        await until('the second payment to be collected', async () => {
          return (await game.node.receivables(game.issuer)).length === 0
        })
        const paid = await holdings(kei, lanterns)

        await expect(running.buyLantern(kei.address, spare.hash)).rejects.toThrow()
        expect(node.kept()).toBe(true)
        expect(await node.accept()).toBe(false)

        expect(await running.buyLantern(kei.address, spare.hash)).toEqual({
          outcome: 'refunded',
          amount: price,
          reason: 'You already have a lantern.',
        })
        await settle(kei, game.node)

        // The price back once, not twice, and still one lantern.
        expect(await holdings(kei, lanterns)).toEqual({ kei: paid.kei + price, lanterns: 1 })
      } finally {
        running.close()
        kei.close()
      }
    },
    60_000,
  )

  test(
    'the reported sequence — refused, taken 100ms later, reposted — still costs one lantern',
    async () => {
      const game = await deployment('late-by-a-timer')
      const probe = await game.boot()
      const catalogue = probe.catalogue()
      probe.close()

      const running = await game.boot(acceptsLate(game.node, isMintOf(catalogue.lantern.asset), 100))
      const kei = await player(game.node)

      try {
        const lanterns = await kei.token(catalogue.lantern.asset)
        const receipt = await kei.pay({ to: catalogue.issuer, amount: catalogue.lantern.price })
        await until('the payment to be collected', async () => (await game.node.receivables(game.issuer)).length === 0)
        const paid = await holdings(kei, lanterns)

        // Whether the door is shut before the timer fires or the mint gets in
        // first is a race, and deliberately not asserted: the point is that both
        // arms end in the same place. One of them answers this call and the
        // other rejects it.
        const answered = await running.buyLantern(kei.address, receipt.hash).catch(() => undefined)
        await Bun.sleep(300)

        expect(await running.buyLantern(kei.address, receipt.hash)).toEqual({
          outcome: 'delivered',
          item: catalogue.lantern.asset,
        })
        if (answered !== undefined) expect(answered).toEqual({ outcome: 'delivered', item: catalogue.lantern.asset })

        await until('the lantern to arrive', async () => (await lanterns.balanceOf(kei.address)) === 1)
        await settle(kei, game.node)
        expect(await holdings(kei, lanterns)).toEqual({ kei: paid.kei, lanterns: 1 })
        expect(await game.node.receivables(kei.address)).toEqual([])
      } finally {
        running.close()
        kei.close()
      }
    },
    60_000,
  )
})

/**
 * And when the door cannot be shut either.
 *
 * A node that stops answering leaves the game unable to find out what happened
 * *and* unable to make it not happen. There is no safe answer to give, so it
 * gives none: the intent stays open, the wallet is told its payment is still
 * being settled, and nothing is written down that a later block could
 * contradict. The cost is liveness, and it is paid by that one wallet only,
 * until the node comes back — which the next attempt and every restart checks.
 */
describe('a node that stops answering mid-purchase', () => {
  /** Paid, collected, and then an action nobody can find out the fate of. */
  async function stalled(name: string): Promise<{
    game: Deployment
    node: Kept
    running: GeneratedGame
    kei: Kei
    lanterns: PlayerToken
    item: string
    hash: string
    paid: { kei: number; lanterns: number }
  }> {
    const game = await deployment(name)
    const probe = await game.boot()
    const catalogue = probe.catalogue()
    probe.close()

    const node = keeps(game.node, isMintOf(catalogue.lantern.asset), { thenStall: true })
    const running = await game.boot(node.node)
    const kei = await player(game.node)
    const lanterns = await kei.token(catalogue.lantern.asset)
    const receipt = await kei.pay({ to: catalogue.issuer, amount: catalogue.lantern.price })
    await until('the payment to be collected', async () => (await game.node.receivables(game.issuer)).length === 0)
    const paid = await holdings(kei, lanterns)

    await expect(running.buyLantern(kei.address, receipt.hash)).rejects.toThrow(/still being settled/)

    // The whole fix, in one assertion: the intent is still open. A `void` here
    // would be a claim about a block that is still in the air.
    expect(entries(game.orders).at(-1)).toMatchObject({ k: 'intent', hash: receipt.hash })

    return { game, node, running, kei, lanterns, item: catalogue.lantern.asset, hash: receipt.hash, paid }
  }

  test(
    'the payment stays open, and the next attempt after the node returns settles it',
    async () => {
      const { game, node, running, kei, lanterns, item, hash, paid } = await stalled('unreachable')
      try {
        // Asking again while it is still unknown is refused the same way, and
        // moves nothing. This is the liveness cost, and it is only this wallet's.
        await expect(running.buyLantern(kei.address, hash)).rejects.toThrow(/still being settled/)
        expect(await holdings(kei, lanterns)).toEqual(paid)

        // The node comes back. The next attempt settles the open intent before
        // it does anything else: the kept block is fenced out, the fact that
        // nothing landed is written down, and only then is the payment answered.
        node.revive()
        expect(await running.buyLantern(kei.address, hash)).toEqual({ outcome: 'delivered', item })
        expect(entries(game.orders).some((entry) => entry.k === 'void' && entry.hash === hash)).toBe(true)
        expect(await node.accept()).toBe(false)

        await until('the lantern to arrive', async () => (await lanterns.balanceOf(kei.address)) === 1)
        await settle(kei, game.node)
        expect(await holdings(kei, lanterns)).toEqual({ kei: paid.kei, lanterns: 1 })
      } finally {
        running.close()
        kei.close()
      }
    },
    60_000,
  )

  test(
    'a restart shuts the door on the block still in flight before it serves anybody',
    async () => {
      const { game, node, running, kei, lanterns, item, hash, paid } = await stalled('restart-in-flight')
      running.close()

      const back = await game.boot()
      try {
        // Startup could not find the mint, so it shut the door and said so —
        // before the first request was served, and before the kept block was
        // offered back below.
        expect(entries(game.orders).some((entry) => entry.k === 'void' && entry.hash === hash)).toBe(true)
        expect(await node.accept()).toBe(false)

        expect(await back.buyLantern(kei.address, hash)).toEqual({ outcome: 'delivered', item })
        await until('the lantern to arrive', async () => (await lanterns.balanceOf(kei.address)) === 1)
        await settle(kei, game.node)
        expect(await holdings(kei, lanterns)).toEqual({ kei: paid.kei, lanterns: 1 })
        expect(await game.node.receivables(kei.address)).toEqual([])
      } finally {
        back.close()
        kei.close()
      }
    },
    60_000,
  )

  test(
    'a restart finds the block that did land, and answers the payment with it',
    async () => {
      const { game, node, running, kei, lanterns, item, hash, paid } = await stalled('restart-it-landed')
      running.close()

      // This time the kept block gets in before anything else is written, which
      // is the other arm of the same race. The restart must read it as this
      // payment's delivery rather than as an unexplained lantern.
      expect(await node.accept()).toBe(true)

      const back = await game.boot()
      try {
        expect(entries(game.orders).at(-1)).toMatchObject({ k: 'done', hash })
        expect(await back.buyLantern(kei.address, hash)).toEqual({ outcome: 'delivered', item })

        await settle(kei, game.node)
        // One lantern and no refund: the delivery it already had is the answer.
        expect(await holdings(kei, lanterns)).toEqual({ kei: paid.kei, lanterns: 1 })
        expect(await game.node.receivables(kei.address)).toEqual([])
      } finally {
        back.close()
        kei.close()
      }
    },
    60_000,
  )
})
