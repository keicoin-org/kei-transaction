/**
 * `workRpcHandler` is the browser-safe half of the split (SPEC §6.3, M4): a
 * plain `Request → Response` function with no `node:http`. These exercise its
 * request/response contract directly, without going through the `node:http`
 * listener in `server.ts` — that's `server.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { MockNode, randomSeed } from '@keicoin/core'
import { LocalWorkProvider, MAX_WORK_REQUEST_BYTES, workRpcHandler } from '../src/index.js'

async function handler(token?: string) {
  const node = await MockNode.create()
  return workRpcHandler({ provider: new LocalWorkProvider(node), ...(token ? { token } : {}) })
}

describe('workRpcHandler', () => {
  test('rejects non-POST methods', async () => {
    const handle = await handler()
    const response = await handle(new Request('http://work.test/', { method: 'GET' }))
    expect(response.status).toBe(405)
  })

  test('rejects a missing or wrong bearer token when one is configured', async () => {
    const handle = await handler('secret')
    const unauthenticated = await handle(new Request('http://work.test/', { method: 'POST', body: '{}' }))
    expect(unauthenticated.status).toBe(401)

    const wrong = await handle(
      new Request('http://work.test/', {
        method: 'POST',
        headers: { authorization: 'Bearer nope' },
        body: '{}',
      }),
    )
    expect(wrong.status).toBe(401)
  })

  test('accepts the right bearer token', async () => {
    const handle = await handler('secret')
    const root = randomSeed()
    const response = await handle(
      new Request('http://work.test/', {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'work_generate', hash: root, tier: 'C' }),
      }),
    )
    expect(response.status).toBe(200)
  })

  test('rejects invalid JSON', async () => {
    const handle = await handler()
    const response = await handle(new Request('http://work.test/', { method: 'POST', body: 'not json' }))
    expect(response.status).toBe(400)
    expect((await response.json()) as { error: string }).toEqual({ error: 'invalid JSON' })
  })

  test('rejects a body over the size limit before parsing it', async () => {
    const handle = await handler()
    const oversized = JSON.stringify({
      action: 'work_generate',
      hash: '0'.repeat(64),
      tier: 'C',
      padding: 'x'.repeat(MAX_WORK_REQUEST_BYTES),
    })
    const response = await handle(new Request('http://work.test/', { method: 'POST', body: oversized }))
    expect(response.status).toBe(413)
  })

  test('rejects an action other than work_generate', async () => {
    const handle = await handler()
    const response = await handle(
      new Request('http://work.test/', { method: 'POST', body: JSON.stringify({ action: 'mint' }) }),
    )
    expect(response.status).toBe(400)
    expect((await response.json()) as { error: string }).toEqual({ error: 'unknown action' })
  })

  test('rejects a hash that is not 64 hex characters', async () => {
    const handle = await handler()
    const response = await handle(
      new Request('http://work.test/', {
        method: 'POST',
        body: JSON.stringify({ action: 'work_generate', hash: 'not-a-hash', tier: 'C' }),
      }),
    )
    expect(response.status).toBe(400)
    expect((await response.json()) as { error: string }).toEqual({ error: 'hash must be 64 hex characters' })
  })

  test('rejects a tier outside A, B, C', async () => {
    const handle = await handler()
    const response = await handle(
      new Request('http://work.test/', {
        method: 'POST',
        body: JSON.stringify({ action: 'work_generate', hash: randomSeed(), tier: 'D' }),
      }),
    )
    expect(response.status).toBe(400)
    expect((await response.json()) as { error: string }).toEqual({ error: 'tier must be A, B, or C' })
  })

  test('answers a valid request with tiered work, matching the provider directly', async () => {
    const node = await MockNode.create()
    const provider = new LocalWorkProvider(node)
    const handle = workRpcHandler({ provider })
    const root = randomSeed()
    const response = await handle(
      new Request('http://work.test/', {
        method: 'POST',
        body: JSON.stringify({ action: 'work_generate', hash: root, tier: 'C' }),
      }),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { work: string }
    expect(body.work).toMatch(/^[0-9a-f]{16}$/i)
  })

  test('answers 503, not 400, when the provider itself fails on a well-formed request', async () => {
    const failing = { generate: () => Promise.reject(new Error('node unreachable')), precompute() {} }
    const handle = workRpcHandler({ provider: failing })
    const response = await handle(
      new Request('http://work.test/', {
        method: 'POST',
        body: JSON.stringify({ action: 'work_generate', hash: randomSeed(), tier: 'C' }),
      }),
    )
    expect(response.status).toBe(503)
    expect((await response.json()) as { error: string }).toEqual({
      error: 'could not generate work: node unreachable',
    })
  })
})
