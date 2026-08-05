/**
 * A browser's `fetch` refuses any receiver but `window` and throws
 * "Illegal invocation". Node and Bun do not check, so a `fetch` stored on an
 * instance and called as `this.fetchImpl(...)` passes every automated run and
 * fails only on the platform SPEC §5.5 built the work server for — a phone.
 *
 * These stand in for that check with a `fetch` that asserts its own receiver,
 * which is the only way CI can hold the `.bind(globalThis)` in place.
 * `HttpNode` carries the same test at packages/core/test/http-node.test.ts:183.
 */

import { describe, expect, test } from 'bun:test'
import type { WorkProvider, WorkTier } from '@keicoin/core'
import { WorkServerProvider } from '../src/index.js'

const ROOT = 'A'.repeat(64)
const WORK = '0123456789abcdef'

/** Refuses to run with anything but the global as `this`, as a browser does. */
function browserLikeFetch(): typeof globalThis.fetch {
  return function (this: unknown) {
    if (this !== globalThis) throw new TypeError('Illegal invocation')
    return Promise.resolve(
      new Response(JSON.stringify({ work: WORK }), { headers: { 'content-type': 'application/json' } }),
    )
  } as unknown as typeof globalThis.fetch
}

describe('WorkServerProvider calls fetch with the global as its receiver', () => {
  test('a receiver-checking fetch is used rather than reported as unreachable', async () => {
    const provider = new WorkServerProvider({ url: 'https://work.example/rpc', fetch: browserLikeFetch() })
    expect(await provider.generate(ROOT, 'B')).toBe(WORK)
  })

  test('a configured fallback does not quietly take over every request', async () => {
    let fellBack = 0
    const fallback: WorkProvider = {
      generate: async (_root: string, _tier: WorkTier) => {
        fellBack += 1
        return 'fedcba9876543210'
      },
    }
    const provider = new WorkServerProvider({
      url: 'https://work.example/rpc',
      fetch: browserLikeFetch(),
      fallback,
    })

    expect(await provider.generate(ROOT, 'B')).toBe(WORK)
    expect(fellBack).toBe(0)
  })

  test('the receiver survives precompute, which requests off the caller stack', async () => {
    let receiver: unknown = 'never called'
    const provider = new WorkServerProvider({
      url: 'https://work.example/rpc',
      fetch: function (this: unknown) {
        receiver = this
        return Promise.resolve(
          new Response(JSON.stringify({ work: WORK }), { headers: { 'content-type': 'application/json' } }),
        )
      } as unknown as typeof globalThis.fetch,
    })

    provider.precompute(ROOT, 'B')
    expect(await provider.generate(ROOT, 'B')).toBe(WORK)
    expect(receiver).toBe(globalThis)
  })
})
