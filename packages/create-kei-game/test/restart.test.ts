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
  await writeFiles(directory, await scaffold(project, { sdkVersion: '^0.1.0' }))
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
