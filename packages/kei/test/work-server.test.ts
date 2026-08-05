/**
 * A work server that wants a token gets it through `Kei.start`, in a header.
 * Putting it in the URL was the only route before, and a URL is what an error
 * message names (SPEC §6.6).
 */

import { describe, expect, test } from 'bun:test'
import { Kei } from 'kei-transaction'

/** Records what the work provider sent, then fails so the local fallback answers. */
function recordingFetch(seen: Array<Record<string, string>>): typeof globalThis.fetch {
  return (async (_input: unknown, init: RequestInit) => {
    seen.push(Object.fromEntries(new Headers(init.headers).entries()))
    throw new Error('Failed to fetch')
  }) as unknown as typeof globalThis.fetch
}

async function startAndSpend(
  workServer: NonNullable<Parameters<typeof Kei.start>[0]>['workServer'],
): Promise<Array<Record<string, string>>> {
  const node = await Kei.mock()
  const seen: Array<Record<string, string>> = []
  const real = globalThis.fetch
  globalThis.fetch = recordingFetch(seen)
  try {
    const kei = await Kei.start({ node, ...(workServer ? { workServer } : {}) })
    await kei.faucet()
    kei.close()
  } finally {
    globalThis.fetch = real
  }
  return seen
}

describe('Kei.start({ workServer })', () => {
  test('the object form sends its headers with every work request', async () => {
    const seen = await startAndSpend({
      url: 'https://work.example/rpc',
      headers: { authorization: 'Bearer t0ken' },
    })

    expect(seen.length).toBeGreaterThan(0)
    for (const headers of seen) expect(headers.authorization).toBe('Bearer t0ken')
  })

  test('a plain URL string still reaches the work server, as it always did', async () => {
    const seen = await startAndSpend('https://work.example/rpc')

    expect(seen.length).toBeGreaterThan(0)
    for (const headers of seen) expect(headers.authorization).toBeUndefined()
  })
})
