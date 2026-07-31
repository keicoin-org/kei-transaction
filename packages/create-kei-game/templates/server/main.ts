/**
 * `bun run dev` — the whole thing, one process.
 *
 * Three things live here and only one of them is your game:
 *
 *   /rpc      a Kei node, in memory. A development tool: point this at a real
 *             node later and nothing above it changes.
 *   /game/*   the issuer, which is `server/game.ts`.
 *   /         the client, bundled on startup.
 *
 * They are one process because it is one command, not because they belong
 * together. The player's browser reaches the node directly and signs everything
 * it writes; this server never sees a player's key and cannot move their money.
 */

import { MockNode, mockRpcHandler, randomSeed } from 'kei-transaction'

import { GameError, startGame } from './game.js'

/** Native, and with a trailing separator — `pathname` would hand Windows `/C:/…`. */
const root = Bun.fileURLToPath(new URL('..', import.meta.url))
const port = Number(process.env.PORT ?? 7777)

const bundle = await Bun.build({
  entrypoints: [`${root}src/main.ts`],
  outdir: `${root}public/build`,
  target: 'browser',
  sourcemap: 'linked',
})
if (!bundle.success) {
  for (const log of bundle.logs) console.error(log)
  process.exit(1)
}

// A fresh chain every run, because it is in memory. The player's wallet lives in
// their browser and outlives it, which just means they come back to an empty
// account on a new chain — the honest behaviour for a mock.
const node = await MockNode.create()
const rpc = mockRpcHandler({ node })

const game = await startGame({
  // Set GAME_SEED in .env to keep the same issuer across restarts. It is the
  // game's money: it belongs in an environment variable, never in a commit.
  seed: process.env.GAME_SEED ?? randomSeed(),
  node,
  network: 'mock',
})

const json = (body: unknown, status = 200): Response => Response.json(body, { status })

const server = Bun.serve({
  port,
  routes: {
    '/': () => new Response(Bun.file(`${root}index.html`), { headers: { 'content-type': 'text/html' } }),

    '/build/*': (request) => {
      // Only what the bundler wrote, and only by name — no path walking.
      const name = new URL(request.url).pathname.slice('/build/'.length)
      if (!/^[\w.-]+$/.test(name)) return new Response('Not found', { status: 404 })
      // Rebuilt on every start, so a cached copy is always the wrong one.
      return new Response(Bun.file(`${root}public/build/${name}`), { headers: { 'cache-control': 'no-store' } })
    },

    '/rpc': { POST: rpc, OPTIONS: rpc },

    '/game/catalogue': () => json(game.catalogue()),

    '/game/earn': {
      async POST(request) {
        try {
          const { address, clicks } = (await request.json()) as { address: string; clicks: number }
          return json({ bundle: await game.earn(address, clicks) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return json({ error: message }, error instanceof GameError ? 400 : 500)
        }
      },
    },
  },
})

console.log(`
  __PROJECT_TITLE__

  play          ${server.url}
  node (mock)   ${server.url}rpc
  issuer        ${game.address}

  This chain is in memory and dies with this process. Nothing on it is worth
  anything, which is exactly what you want while you are building.
`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    game.close()
    void server.stop(true).then(() => process.exit(0))
  })
}
