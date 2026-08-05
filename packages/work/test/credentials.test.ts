/**
 * SPEC §6.6: a credential never reaches an error, a log, or a stack trace.
 *
 * This package runs in the browser, so `work-server-unreachable` fires in front
 * of a player on every ordinary transport failure — offline, DNS, CORS, a proxy
 * — and whatever it says goes to the console and to any crash reporter the game
 * installed. So the URL it names is the safe form, and a token has somewhere to
 * live that an error message never reads.
 */

import { describe, expect, test } from 'bun:test'
import { MockNode } from '@keicoin/core'
import { WorkServerProvider, createWorkProvider } from '../src/index.js'

const ROOT = 'A'.repeat(64)

const offline = (async () => {
  throw new Error('Failed to fetch')
}) as unknown as typeof globalThis.fetch

function refused(url: string): Promise<Error> {
  const provider = new WorkServerProvider({ url, fetch: offline })
  return provider.generate(ROOT, 'B').then(
    () => {
      throw new Error('expected the work server to be reported as unreachable')
    },
    (error: Error) => error,
  )
}

describe('the work server URL in an error', () => {
  test('userinfo and a credential-bearing query never reach the message or the stack', async () => {
    const error = await refused('https://user:hunter2@work.example/rpc?token=abc123-correct-horse')

    expect(error.message).toContain('work.example')
    for (const text of [error.message, error.stack ?? '']) {
      expect(text).not.toContain('hunter2')
      expect(text).not.toContain('abc123-correct-horse')
      expect(text).not.toContain('user:')
    }
  })

  test('a token carried as a path segment is redacted, and the host survives', async () => {
    const error = await refused('https://work.example/tok_0123456789abcdefghij/rpc')

    expect(error.message).toContain('https://work.example/[redacted]/rpc')
    expect(error.stack ?? '').not.toContain('tok_0123456789abcdefghij')
  })
})

describe('carrying a work server token outside the URL', () => {
  test('headers passed to the provider are sent with the request', async () => {
    const seen: Array<Record<string, string>> = []
    const provider = new WorkServerProvider({
      url: 'https://work.example/rpc',
      headers: { authorization: 'Bearer t0ken' },
      fetch: (async (_input: unknown, init: RequestInit) => {
        seen.push(Object.fromEntries(new Headers(init.headers).entries()))
        return new Response(JSON.stringify({ work: '0000000000000000' }), {
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof globalThis.fetch,
    })

    expect(await provider.generate(ROOT, 'B')).toBe('0000000000000000')
    expect(seen[0]?.authorization).toBe('Bearer t0ken')
    expect(seen[0]?.['content-type']).toBe('application/json')
  })

  test('createWorkProvider forwards them, so Kei.start has a way to send one', async () => {
    const seen: Array<Record<string, string>> = []
    const provider = createWorkProvider(await MockNode.create(), {
      workServer: 'https://work.example/rpc',
      headers: { authorization: 'Bearer t0ken' },
      fetch: (async (_input: unknown, init: RequestInit) => {
        seen.push(Object.fromEntries(new Headers(init.headers).entries()))
        return new Response(JSON.stringify({ work: '0000000000000000' }), {
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof globalThis.fetch,
    })

    expect(await provider.generate(ROOT, 'B')).toBe('0000000000000000')
    expect(seen[0]?.authorization).toBe('Bearer t0ken')
  })
})
