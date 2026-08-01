/**
 * End-to-end check of the packaged bin (`kei-work-server`, wired in
 * package.json to `cli.ts` -> `./server.js`'s `startWorkServer`): the whole
 * point of the M4 split is that this still works as one process a developer
 * runs, even though the code moved into a separate `node:http`-only module.
 *
 * Readiness is polled by port rather than by reading the child's stdout —
 * piped, non-TTY stdout is block-buffered on this platform and does not
 * surface `console.log` output to the parent until the child exits, which
 * would make a "read the first line" approach hang rather than fail cleanly.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { mockRpcHandler, MockNode, randomSeed } from '@keicoin/core'

const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = probe.port
  await probe.stop(true)
  if (port === undefined) throw new Error('server did not bind a TCP port')
  return port
}

async function waitForServer(url: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      await fetch(url, { method: 'POST', body: '{}' })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error(`kei-work-server never came up at ${url}`)
}

describe('kei-work-server CLI', () => {
  let rpcServer: ReturnType<typeof Bun.serve> | undefined
  let proc: ReturnType<typeof Bun.spawn> | undefined

  afterEach(() => {
    proc?.kill()
    rpcServer?.stop(true)
  })

  test('starts as a real subprocess and serves real work over the wire', async () => {
    const node = await MockNode.create()
    const handler = mockRpcHandler({ node })
    rpcServer = Bun.serve({ port: 0, fetch: (request) => handler(request) })

    const port = await freePort()
    const url = `http://127.0.0.1:${port}`

    proc = Bun.spawn([process.execPath, 'run', CLI_PATH], {
      env: { ...process.env, KEI_NODE_URL: rpcServer.url.toString(), PORT: String(port), HOST: '127.0.0.1' },
      stdout: 'ignore',
      stderr: 'ignore',
    })

    await waitForServer(url, Date.now() + 10_000)

    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ action: 'work_generate', hash: randomSeed(), tier: 'C' }),
    })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { work: string }).work).toMatch(/^[0-9a-f]{16}$/i)
  }, 15_000)
})
