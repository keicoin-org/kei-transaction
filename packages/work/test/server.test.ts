import { afterEach, describe, expect, test } from 'bun:test'
import { MockNode, randomSeed } from '@keicoin/core'
import { MAX_WORK_REQUEST_BYTES, WorkServerProvider } from '../src/index.js'
import { startWorkServer, type RunningWorkServer } from '../src/server.js'

describe('work HTTP server (node:http listener)', () => {
  let running: RunningWorkServer | undefined
  afterEach(async () => running?.close())

  test('serves valid tiered work to the production client', async () => {
    const node = await MockNode.create()
    running = await startWorkServer(node)
    const provider = new WorkServerProvider({ url: running.url })
    const root = randomSeed()
    expect(await provider.generate(root, 'C')).toMatch(/^[0-9a-f]{16}$/i)
  })

  test('rejects unauthenticated callers when a token is configured', async () => {
    const node = await MockNode.create()
    running = await startWorkServer(node, { token: 'test-secret' })
    expect((await fetch(running.url, { method: 'POST', body: '{}' })).status).toBe(401)
  })

  test('accepts the right bearer token over the wire', async () => {
    const node = await MockNode.create()
    running = await startWorkServer(node, { token: 'test-secret' })
    const provider = new WorkServerProvider({ url: running.url, headers: { authorization: 'Bearer test-secret' } })
    expect(await provider.generate(randomSeed(), 'B')).toMatch(/^[0-9a-f]{16}$/i)
  })

  test('rejects an oversized request body while it is still streaming in, over real TCP', async () => {
    const node = await MockNode.create()
    running = await startWorkServer(node)
    const oversized = 'x'.repeat(MAX_WORK_REQUEST_BYTES + 1)
    const response = await fetch(running.url, { method: 'POST', body: oversized })
    expect(response.status).toBe(413)
  })

  test('binds an ephemeral port on 127.0.0.1 by default', async () => {
    const node = await MockNode.create()
    running = await startWorkServer(node)
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })
})
