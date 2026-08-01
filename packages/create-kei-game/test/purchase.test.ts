/**
 * The generated game, actually run.
 *
 * `scaffold.test.ts` reads what comes out and parses it, which catches a syntax
 * error and nothing else. It is not enough to catch the thing that actually goes
 * wrong with a scaffolder living next to a moving SDK: code that parses,
 * imports, and type-checks, and then throws the moment it is run. That is
 * exactly what happened when `kei.pay({ memo })` started refusing a memo it had
 * previously accepted (decisions-m2.md §17). Every generated file still parsed.
 * The shop was dead.
 *
 * So this writes the project out, imports both halves of it, puts an HTTP server
 * between them, and buys the lantern.
 *
 * It is written under this package rather than into a system temp directory
 * because it has to resolve `kei-transaction` the way a generated project does —
 * by walking up to a `node_modules` that has it. Here that is the workspace
 * link, which is the SDK in this tree: the one the emitted code has to match.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Kei, MockNode, mockRpcHandler, randomSeed, type KeiNode } from 'kei-transaction'

import { projectFrom } from '../src/naming.js'
import { scaffold } from '../src/scaffold.js'
import { writeFiles } from '../src/write.js'

type LanternOutcome =
  | { outcome: 'delivered'; item: string }
  | { outcome: 'refunded'; amount: number; reason: string }

/** What the generated `server/game.ts` returns. */
interface GeneratedGame {
  address: string
  catalogue(): { issuer: string; lantern: { asset: string; price: number } }
  earn(address: string, clicks: number): Promise<unknown>
  buyLantern(address: string, hash: string): Promise<LanternOutcome>
  close(): void
}

/** What the generated `src/economy.ts` returns. */
interface GeneratedEconomy {
  state: { online: boolean; lanterns: number; perClick: number; coins: number; message: string | null }
  click(): void
  buyLantern(): Promise<void>
  close(): void
}

const directory = join(import.meta.dir, '..', '.generated', 'purchase')

/** The `/game/*` routes stood up here. The last test holds them to `server/main.ts`. */
const SERVED = ['/game/catalogue', '/game/earn', '/game/lantern']

let game: GeneratedGame
let server: ReturnType<typeof Bun.serve>
let origin: string
let mainSource: string

/** Restored afterwards — nothing else in the suite runs in a browser. */
const realFetch = globalThis.fetch
const realLocation = (globalThis as { location?: unknown }).location

beforeAll(async () => {
  await rm(directory, { recursive: true, force: true })
  const project = projectFrom({ name: 'Star Clicker', currency: 'Gold Pieces' })
  const files = await scaffold(project, { sdkVersion: '^0.1.0' })
  await writeFiles(directory, files)
  mainSource = files.find((file) => file.path === 'server/main.ts')?.contents ?? ''

  const node = await MockNode.create()
  const { startGame } = (await import(pathToFileURL(join(directory, 'server', 'game.ts')).href)) as {
    startGame(options: { seed: string; node: KeiNode; network: 'mock'; orders: string }): Promise<GeneratedGame>
  }
  // Named, because the default is relative to the working directory and that is
  // this repository's root when the suite runs. `restart.test.ts` is where the
  // file itself is under test; here it just needs somewhere of its own.
  game = await startGame({
    seed: randomSeed(),
    node,
    network: 'mock',
    orders: join(directory, '.kei', 'orders.ndjson'),
  })

  // The generated `server/main.ts` cannot be imported directly: it bundles the
  // Babylon.js client at startup, and that dependency belongs to the generated
  // project rather than to this one. Its routes are mirrored instead, and the
  // last test in this file fails if the two ever stop agreeing.
  const rpc = mockRpcHandler({ node })
  const json = (body: unknown, status = 200): Response => Response.json(body, { status })
  const failed = (error: unknown): Response =>
    json({ error: error instanceof Error ? error.message : String(error) }, 400)

  server = Bun.serve({
    port: 0,
    routes: {
      '/rpc': { POST: rpc, OPTIONS: rpc },
      '/game/catalogue': () => json(game.catalogue()),
      '/game/earn': {
        async POST(request) {
          const { address, clicks } = (await request.json()) as { address: string; clicks: number }
          try {
            return json({ bundle: await game.earn(address, clicks) })
          } catch (error) {
            return failed(error)
          }
        },
      },
      '/game/lantern': {
        async POST(request) {
          const { address, hash } = (await request.json()) as { address: string; hash: string }
          try {
            return json(await game.buyLantern(address, hash))
          } catch (error) {
            return failed(error)
          }
        },
      },
    },
  })
  origin = server.url.origin

  // The browser, stood in for. `src/economy.ts` reads `location.origin` for the
  // node URL and fetches `/game/…` by path — which is all a page gets for free,
  // and neither of which Bun has. Nothing else about it is browser-shaped.
  ;(globalThis as { location?: unknown }).location = { origin }
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    realFetch(typeof input === 'string' && input.startsWith('/') ? `${origin}${input}` : input, init)) as typeof fetch
})

afterAll(async () => {
  globalThis.fetch = realFetch
  if (realLocation === undefined) delete (globalThis as { location?: unknown }).location
  else (globalThis as { location?: unknown }).location = realLocation

  game?.close()
  await server?.stop(true)
  await rm(directory, { recursive: true, force: true })
})

async function until(what: string, ready: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await Bun.sleep(50)
  }
}

/** A player who is not the browser: for the posts the browser half will not make. */
async function player(): Promise<Kei> {
  const kei = await Kei.start({ node: `${origin}/rpc`, network: 'mock', seed: randomSeed() })
  await kei.faucet(1)
  return kei
}

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await realFetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('the generated game, run', () => {
  test(
    'a player clicks, banks the coins, and buys the lantern with the hash of their payment',
    async () => {
      const { connect } = (await import(pathToFileURL(join(directory, 'src', 'economy.ts')).href)) as {
        connect(): Promise<GeneratedEconomy>
      }
      const economy = await connect()

      try {
        expect(economy.state.online).toBe(true)
        expect(economy.state.message).toBeNull()

        // Clicks first, so the doubling below is measured against a real payout
        // rather than against a constant. Twenty is the batch `save()` waits for.
        for (let click = 0; click < 20; click++) economy.click()
        await until('the clicks to be paid', () => economy.state.coins === 20)

        // The purchase: one payment with no memo on it, and one hash sent after
        // it saying which payment that was. `buyLantern` reports failure through
        // `state.message` rather than by throwing, so the message is the
        // assertion — a broken purchase path puts the SDK's own refusal there.
        await economy.buyLantern()
        expect(economy.state.message).toMatch(/on its way/)

        await until('the lantern to arrive', () => economy.state.lanterns === 1)
        expect(economy.state.perClick).toBe(2)

        // And it is worth what it says: the same twenty clicks now pay double.
        for (let click = 0; click < 20; click++) economy.click()
        await until('the doubled clicks to be paid', () => economy.state.coins === 60)
      } finally {
        economy.close()
      }
    },
    60_000,
  )

  test(
    'one payment buys one lantern, however many times it is posted',
    async () => {
      const kei = await player()
      try {
        const catalogue = game.catalogue()
        const receipt = await kei.pay({ to: catalogue.issuer, amount: catalogue.lantern.price })

        const first = await post('/game/lantern', { address: kei.address, hash: receipt.hash })
        const second = await post('/game/lantern', { address: kei.address, hash: receipt.hash })

        expect(first.status).toBe(200)
        expect(first.body).toEqual({ outcome: 'delivered', item: catalogue.lantern.asset })
        // The same answer as the first post: not a second lantern, and not an error.
        expect(second.body).toEqual(first.body)

        const lanterns = await kei.token(catalogue.lantern.asset)
        await until('the lantern to arrive', async () => (await lanterns.balanceOf(kei.address)) === 1)
        expect(await lanterns.balanceOf(kei.address)).toBe(1)
      } finally {
        kei.close()
      }
    },
    60_000,
  )

  test(
    'a payment somebody else made buys nothing',
    async () => {
      const payer = await player()
      const opportunist = await player()
      try {
        const catalogue = game.catalogue()
        const receipt = await payer.pay({ to: catalogue.issuer, amount: catalogue.lantern.price })

        const stolen = await post('/game/lantern', { address: opportunist.address, hash: receipt.hash })
        expect(stolen.status).toBe(400)
        expect(stolen.body.error).toMatch(/signed by a different wallet/)

        const lanterns = await opportunist.token(catalogue.lantern.asset)
        expect(await lanterns.balanceOf(opportunist.address)).toBe(0)

        // The payer's own hash still works, which is the point: the refusal was
        // about who quoted it, not about the payment.
        const theirs = await post('/game/lantern', { address: payer.address, hash: receipt.hash })
        expect(theirs.body).toEqual({ outcome: 'delivered', item: catalogue.lantern.asset })
      } finally {
        payer.close()
        opportunist.close()
      }
    },
    60_000,
  )

  test(
    'a hash nobody paid is refused rather than guessed at',
    async () => {
      const kei = await player()
      try {
        const refused = await post('/game/lantern', { address: kei.address, hash: 'A'.repeat(64) })

        expect(refused.status).toBe(400)
        expect(refused.body.error).toMatch(/No payment/)
      } finally {
        kei.close()
      }
    },
    30_000,
  )

  test('the routes served here are the routes the generated server serves', () => {
    const declared = [...mainSource.matchAll(/'(\/game\/[a-z]+)'/g)].map((match) => match[1] ?? '')
    expect([...new Set(declared)].sort()).toEqual([...SERVED].sort())
    expect(mainSource).toContain('game.buyLantern(')
  })
})
