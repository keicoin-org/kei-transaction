/**
 * The RPC contract (docs/rpc.md).
 *
 * No node answers this yet — that is M2/M3. What this pins is the request and
 * response shape the node fork has to serve, so "swap the mock for RPC" is a
 * one-line change at the call site and not a renegotiation.
 */

import { describe, expect, test } from 'bun:test'
import { HttpNode, KeiError } from '@keicoin/core'

interface Call {
  action: string
  body: Record<string, unknown>
}

const RPC = 'https://node.example/rpc'

/** For the constructor tests, which check that a fetch exists and never call it. */
const unusedFetch = (() => new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch

/**
 * The worse node, and the one the bound has to be measured against: it accepts
 * the request, never answers, and ignores the `AbortSignal` completely. Nothing
 * the client does *to the request* can make a call against this settle, so a
 * test that passes here is testing the client's own deadline and not `fetch`'s
 * cooperation. `answer` is the reply that arrives long after anyone wanted it.
 */
function deafFetch(): {
  fetch: typeof globalThis.fetch
  started: () => number
  signals: AbortSignal[]
  answer: (body: unknown) => void
} {
  const signals: AbortSignal[] = []
  const pending: ((response: Response) => void)[] = []
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal as AbortSignal)
    return new Promise<Response>((resolve) => {
      pending.push(resolve)
    })
  }) as unknown as typeof globalThis.fetch
  return {
    fetch: fetchImpl,
    started: () => signals.length,
    signals,
    answer: (body) => {
      for (const resolve of pending.splice(0)) resolve(new Response(JSON.stringify(body)))
    },
  }
}

/** Let every already-queued microtask and timer callback run. */
const settle = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

async function refused(promise: Promise<unknown>): Promise<KeiError> {
  const error = await promise.then(
    () => new Error('the call resolved, and it was supposed to be refused'),
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(KeiError)
  return error as KeiError
}

function stubNode(handler: (call: Call) => unknown): { node: HttpNode; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { action: string }
    const call = { action: body.action, body }
    calls.push(call)
    return new Response(JSON.stringify(handler(call)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch

  return { node: new HttpNode({ url: 'https://node.example/rpc', fetch: fetchImpl }), calls }
}

describe('HttpNode', () => {
  test('sends one action per call, as JSON', async () => {
    const { node, calls } = stubNode(({ action }) => {
      switch (action) {
        case 'account_info':
          return {
            account: {
              address: 'kei_1',
              frontier: 'A'.repeat(64),
              height: 3,
              balance: '5000',
              representative: 'kei_2',
              receivableCount: 0,
            },
          }
        case 'asset_balance':
          return { balance: '380' }
        case 'account_holdings':
          return { holdings: [{ asset: 'B'.repeat(64), balance: '1' }] }
        case 'commit_info':
          return { commit: { root: 'C'.repeat(64), issuer: 'kei_1', asset: 'B'.repeat(64), count: 2, total: '3', closed: false } }
        case 'claim_status':
          return { claimed: true }
        case 'swap_info':
          return {
            offer: {
              hash: 'E'.repeat(64),
              from: 'kei_1',
              asset: 'B'.repeat(64),
              amount: '1',
              wantAsset: '0'.repeat(64),
              wantAmount: '5000',
              counterparty: null,
              expiresAt: null,
              state: 'open',
              settledBy: null,
              acceptedBy: null,
              height: 4,
              seenAt: 1_700_000_000_000,
              settledAt: null,
            },
          }
        case 'account_swaps':
          return { offers: [] }
        case 'work_thresholds':
          return { thresholds: { A: '1', B: '2', C: '3' } }
        default:
          return {}
      }
    })

    expect((await node.accountInfo('kei_1'))?.height).toBe(3)
    expect(await node.holderBalance('B'.repeat(64), 'kei_1')).toBe('380')
    expect(await node.holdings('kei_1')).toHaveLength(1)
    expect((await node.commitInfo('C'.repeat(64)))?.closed).toBe(false)
    expect(await node.hasClaimed('kei_1', 'C'.repeat(64))).toBe(true)
    expect((await node.swapOffer('E'.repeat(64)))?.state).toBe('open')
    expect(await node.accountSwaps('kei_1')).toEqual([])
    expect((await node.workThresholds()).B).toBe('2')

    expect(calls.map((call) => call.action)).toEqual([
      'account_info',
      'asset_balance',
      'account_holdings',
      'commit_info',
      'claim_status',
      'swap_info',
      'account_swaps',
      'work_thresholds',
    ])
    expect(calls[0]?.body).toEqual({ action: 'account_info', account: 'kei_1' })
    expect(calls[1]?.body).toEqual({ action: 'asset_balance', asset: 'B'.repeat(64), account: 'kei_1' })
    expect(calls[6]?.body).toEqual({ action: 'account_swaps', account: 'kei_1', count: 100 })
  })

  test('an unknown offer is null, not an error', async () => {
    const { node } = stubNode(() => ({}))
    expect(await node.swapOffer('E'.repeat(64))).toBeNull()
  })

  test('accountSwaps forwards limit and state exactly as asked', async () => {
    const { node, calls } = stubNode(() => ({ offers: [] }))
    await node.accountSwaps('kei_1', { limit: 10, state: 'accepted' })
    expect(calls[0]?.body).toEqual({ action: 'account_swaps', account: 'kei_1', count: 10, state: 'accepted' })
  })

  test('an unknown account is null, not an error', async () => {
    const { node } = stubNode(() => ({}))
    expect(await node.accountInfo('kei_1')).toBeNull()
    expect(await node.assetInfo('B'.repeat(64))).toBeNull()
    expect(await node.receivables('kei_1')).toEqual([])
  })

  test('a node error becomes a sentence naming the node and the action', async () => {
    const { node } = stubNode(() => ({ error: 'Fork' }))
    await expect(node.process({} as never)).rejects.toThrow(/rejected "process": Fork/)
  })

  test('fetch is called with the global as its receiver, as a browser demands', async () => {
    // A browser's fetch throws "Illegal invocation" unless `this` is the window.
    // Node and Bun do not check, so only a real browser ever caught this.
    let receiver: unknown = 'never called'
    const fetchImpl = function (this: unknown) {
      receiver = this
      return Promise.resolve(new Response('{}'))
    } as unknown as typeof globalThis.fetch

    const node = new HttpNode({ url: 'https://node.example/rpc', fetch: fetchImpl })
    await node.accountInfo('kei_1')
    expect(receiver).toBe(globalThis)
  })

  test('an unreachable node says so, and names the URL', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch
    const node = new HttpNode({ url: 'https://node.example/rpc', fetch: fetchImpl })
    await expect(node.accountInfo('kei_1')).rejects.toThrow(/Could not reach the Kei node at https:\/\/node\.example\/rpc/)
  })

  test('there is no faucet on mainnet', async () => {
    const { node } = stubNode(() => ({}))
    const mainnet = new HttpNode({ url: 'https://node.example/rpc', network: 'mainnet', fetch: globalThis.fetch })
    await expect(mainnet.faucet('kei_1')).rejects.toThrow(/no faucet on mainnet/)
    void node
  })

  test('subscribe polls receivables and reports each hash once', async () => {
    let served = 0
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { action: string }
      if (body.action !== 'accounts_receivable') return new Response('{}')
      served++
      return new Response(
        JSON.stringify({
          receivables: [{ hash: 'D'.repeat(64), from: 'kei_2', asset: '0'.repeat(64), amount: '1' }],
        }),
      )
    }) as unknown as typeof globalThis.fetch

    const node = new HttpNode({ url: 'https://node.example/rpc', pollInterval: 5, fetch: fetchImpl })
    const seen: string[] = []
    const stop = node.subscribe('kei_1', (event) => seen.push(event.hash))

    await new Promise((resolve) => setTimeout(resolve, 40))
    stop()
    expect(served).toBeGreaterThan(1)
    expect(seen).toEqual(['D'.repeat(64)])
  })
})

/**
 * Issue #36: a node that accepts a request and never finishes it used to leave
 * `Kei.start()`, a send, or a read pending forever, and the polling subscription
 * kept starting new requests on top of the ones already stuck.
 */
describe('HttpNode against a node that never answers', () => {
  test('a direct call settles against a fetch that ignores the signal', async () => {
    // The signal is a request, not a guarantee: this fetch never looks at it,
    // so only the client's own deadline can end the call.
    const deaf = deafFetch()
    const node = new HttpNode({
      url: RPC,
      requestTimeout: 25,
      headers: { authorization: 'Bearer abcdef0123456789' },
      fetch: deaf.fetch,
    })

    const error = await refused(node.accountInfo('kei_1'))
    expect(error.code).toBe('node-timeout')
    expect(error.message).toContain('account_info')
    expect(error.message).toContain(RPC)
    expect(error.message).toContain('25ms')
    // The endpoint and the action, and nothing that was sent with them.
    expect(error.message).not.toContain('abcdef0123456789')
    expect(error.message).not.toContain('authorization')
    expect(error.message).not.toContain('kei_1')

    // Abandoned by the client, and still aborted for the sake of a fetch that
    // would have freed a socket on hearing it.
    expect(deaf.started()).toBe(1)
    expect(deaf.signals[0]?.aborted).toBe(true)
  })

  test('a hanging response body is inside the bound too', async () => {
    // Headers arrive, the body never does. `response.json()` hangs exactly as
    // `fetch` does, so the deadline has to cover the whole exchange.
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Never enqueues, never closes.
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch

    const node = new HttpNode({ url: RPC, requestTimeout: 25, fetch: fetchImpl })
    const error = await refused(node.accountInfo('kei_1'))
    expect(error.code).toBe('node-timeout')
  })

  test('a timed-out call is one attempt, never a replay', async () => {
    const deaf = deafFetch()
    const node = new HttpNode({ url: RPC, requestTimeout: 20, fetch: deaf.fetch })

    // A `process` that timed out may still have landed. Resending it is the
    // caller's decision about a signed block, so the transport does not make it.
    const error = await refused(node.process({} as never))
    expect(error.code).toBe('node-timeout')
    await settle(60)
    expect(deaf.started()).toBe(1)
  })

  test('requestTimeout has to be a finite number of milliseconds', () => {
    const build = (requestTimeout: number): HttpNode =>
      new HttpNode({ url: RPC, requestTimeout, fetch: unusedFetch })
    expect(() => build(Number.POSITIVE_INFINITY)).toThrow(/finite/)
    expect(() => build(Number.NaN)).toThrow(/finite/)
    expect(() => build(0)).toThrow(/finite/)
    expect(() => build(-1)).toThrow(/finite/)
    // Omitting it is not a way to opt out of one, and giving one is allowed.
    expect(new HttpNode({ url: RPC, fetch: unusedFetch })).toBeInstanceOf(HttpNode)
    expect(new HttpNode({ url: RPC, requestTimeout: 5, fetch: unusedFetch })).toBeInstanceOf(HttpNode)
  })

  test('at most one poll is ever in flight', async () => {
    const deaf = deafFetch()
    // A poll interval far below the timeout: the old interval would have
    // started roughly fifty requests in the window below.
    const node = new HttpNode({ url: RPC, pollInterval: 1, requestTimeout: 10_000, fetch: deaf.fetch })

    const stop = node.subscribe('kei_1', () => {})
    await settle(50)
    expect(deaf.started()).toBe(1)
    stop()
  })

  test('unsubscribing aborts the poll it is inside, and schedules no other', async () => {
    const deaf = deafFetch()
    const node = new HttpNode({ url: RPC, pollInterval: 1, requestTimeout: 10_000, fetch: deaf.fetch })

    const seen: string[] = []
    const stop = node.subscribe('kei_1', (event) => seen.push(event.hash))
    expect(deaf.started()).toBe(1)
    expect(deaf.signals[0]?.aborted).toBe(false)

    stop()
    expect(deaf.signals[0]?.aborted).toBe(true)

    // The poll is inside a fetch that ignored that abort, so the reply still
    // comes — to nobody, and without starting the next poll.
    deaf.answer({ receivables: [{ hash: 'D'.repeat(64), from: 'kei_2', asset: '0'.repeat(64), amount: '1' }] })
    await settle(30)
    expect(deaf.started()).toBe(1)
    expect(seen).toEqual([])
  })

  test('a listener that unsubscribes stops the rest of its own batch', async () => {
    const hashes = ['D', 'E', 'F'].map((letter) => letter.repeat(64))
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          receivables: hashes.map((hash) => ({ hash, from: 'kei_2', asset: '0'.repeat(64), amount: '1' })),
        }),
      )) as unknown as typeof globalThis.fetch

    const node = new HttpNode({ url: RPC, pollInterval: 1, fetch: fetchImpl })
    const seen: string[] = []
    const stop = node.subscribe('kei_1', (event) => {
      seen.push(event.hash)
      stop()
    })

    await settle(20)
    expect(seen).toEqual(hashes.slice(0, 1))
  })

  test('polling recovers after a transient timeout, without a storm', async () => {
    let attempts = 0
    const fetchImpl = (() => {
      attempts += 1
      // The first attempt is deaf as well as silent: recovery has to come from
      // the deadline, not from the abort being honoured.
      if (attempts === 1) return new Promise<Response>(() => {})
      return Promise.resolve(
        new Response(
          JSON.stringify({
            receivables: [{ hash: 'D'.repeat(64), from: 'kei_2', asset: '0'.repeat(64), amount: '1' }],
          }),
        ),
      )
    }) as unknown as typeof globalThis.fetch

    const node = new HttpNode({ url: RPC, pollInterval: 5, requestTimeout: 15, fetch: fetchImpl })
    const seen: string[] = []
    // Awaited rather than slept on: the assertion is that it arrives, not when.
    const arrived = new Promise<void>((resolve) => {
      const stop = node.subscribe('kei_1', (event) => {
        seen.push(event.hash)
        stop()
        resolve()
      })
    })

    await arrived
    expect(seen).toEqual(['D'.repeat(64)])
    // The first attempt was abandoned, and the second is what answered — the
    // failure backed off by at least one interval rather than retrying at once.
    expect(attempts).toBe(2)
  })
})

/**
 * Backoff read as numbers rather than waited out.
 *
 * `setTimeout` is recorded instead of armed, and the poll loop is stepped by
 * hand. Sleeping through a schedule would make these tests slow where they can
 * be, flaky where they must not be, and — for the interval that matters most,
 * one longer than the 30s cap — impossible to write at all.
 */
function captureTimers(): { flush: () => Promise<void>; step: () => Promise<number>; restore: () => void } {
  const armed: { ms: number; fire: () => void }[] = []
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = ((fire: () => void, ms = 0) => {
    armed.push({ ms, fire })
    return armed.length
  }) as unknown as typeof globalThis.setTimeout
  globalThis.clearTimeout = (() => {}) as unknown as typeof globalThis.clearTimeout

  return {
    /** Lets the immediately-started poll settle and arm its first retry. */
    flush: () => new Promise((resolve) => realSetTimeout(resolve, 0)),
    /**
     * Runs the timer armed last and returns how long it had been asked to
     * wait. The loop's final act before going quiet is arming its next poll, so
     * the newest timer is that poll rather than some request's deadline.
     */
    step: async (): Promise<number> => {
      const next = armed.pop()
      next?.fire()
      // A real macrotask, which every microtask the poll queues runs before.
      await new Promise((resolve) => realSetTimeout(resolve, 0))
      return next?.ms ?? Number.NaN
    },
    restore: (): void => {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    },
  }
}

/** A node that refuses every connection, so every poll fails at once. */
const refusingFetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof globalThis.fetch

/** Drives `polls` polls, answering the ones `answers` names, and returns each wait. */
async function backoffSchedule(
  pollInterval: number,
  polls: number,
  answers: ReadonlySet<number> = new Set(),
  jitter = 0.5,
): Promise<number[]> {
  const realRandom = Math.random
  Math.random = () => jitter
  const timers = captureTimers()
  try {
    let attempts = 0
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
      attempts += 1
      return answers.has(attempts)
        ? Promise.resolve(new Response(JSON.stringify({ receivables: [] })))
        : refusingFetch(url as string, init)
    }) as unknown as typeof globalThis.fetch

    const node = new HttpNode({ url: RPC, pollInterval, requestTimeout: 30_000, fetch: fetchImpl })
    const stop = node.subscribe('kei_1', () => {})
    await timers.flush()
    const waits: number[] = []
    // The first poll runs on subscribe; stepping from here fires the wait it
    // scheduled, which is the first number under test.
    for (let i = 0; i < polls; i += 1) waits.push(await timers.step())
    stop()
    return waits
  } finally {
    timers.restore()
    Math.random = realRandom
  }
}

describe('HttpNode backoff between failed polls', () => {
  test('doubles, is capped, and starts over after a poll that works', async () => {
    // Jitter pinned mid-window: every number below is the whole formula, not a
    // bound on it. The fifth failure is the cap — 30s, halved and jittered.
    const waits = await backoffSchedule(2_000, 7, new Set([6]))
    expect(waits.slice(0, 5)).toEqual([3_000, 6_000, 12_000, 22_500, 22_500])
    // Poll six is answered, so poll seven is due one plain interval later...
    expect(waits[5]).toBe(2_000)
    // ...and poll seven's failure is a first failure again, not a sixth.
    expect(waits[6]).toBe(3_000)
  })

  test('a poll interval longer than the cap is a floor, not something to shorten to', async () => {
    // Jitter at its lowest, which is where a retry lands soonest. A wallet that
    // asked to be polled every 45s is not moved to every 30s by the node
    // failing: the cap bounds the doubling, it does not overrule the interval.
    const waits = await backoffSchedule(45_000, 5, new Set(), 0)
    expect(waits).toEqual([45_000, 45_000, 45_000, 45_000, 45_000])
  })

  test('the first retry is never sooner than the interval, at any jitter', async () => {
    for (const jitter of [0, 0.25, 0.999]) {
      const [first] = await backoffSchedule(2_000, 1, new Set(), jitter)
      expect(first).toBeGreaterThanOrEqual(2_000)
    }
  })
})

/**
 * Issue #113: `seen` inside `subscribe` used to keep every hash it had ever
 * added, growing with lifetime payment count on a process that never restarts.
 * The fix prunes it to what the node's own answer says is outstanding, at the
 * end of each successful poll.
 */
describe('HttpNode subscribe and the seen set', () => {
  const hashFor = (i: number): string => String(i).padStart(64, '0')
  const receivableFor = (hash: string): unknown => ({ hash, from: 'kei_2', asset: '0'.repeat(64), amount: '1' })

  test('a hash the node has stopped listing is forgotten, not retained forever', async () => {
    // 500 polls, each reporting only its own new receivable — the node has
    // already paid out everything before it, so it is off the list. Poll 501
    // brings back the very first hash, as if it had reappeared. 501 real
    // macrotask round trips through `captureTimers` is slower than the
    // default per-test budget, hence the explicit timeout below.
    const N = 500
    let poll = 0
    const fetchImpl = (async () => {
      poll += 1
      const hash = poll <= N ? hashFor(poll) : hashFor(1)
      return new Response(JSON.stringify({ receivables: [receivableFor(hash)] }))
    }) as unknown as typeof globalThis.fetch

    const timers = captureTimers()
    try {
      const node = new HttpNode({ url: RPC, pollInterval: 5, fetch: fetchImpl })
      const seen: string[] = []
      const stop = node.subscribe('kei_1', (event) => seen.push(event.hash))
      await timers.flush()
      for (let i = 1; i <= N + 1; i += 1) await timers.step()
      stop()

      // Every one of the 500 distinct hashes arrived exactly once, plus hash
      // #1 a second time from poll 501.
      expect(seen).toHaveLength(N + 1)
      expect(seen.slice(0, N)).toEqual(Array.from({ length: N }, (_, i) => hashFor(i + 1)))

      // Hash #1 reappearing 500 polls later is delivered again. If `seen` had
      // kept every hash it was ever given, this would have been swallowed as
      // a duplicate — it is only deliverable because `seen` had already
      // forgotten it, which is what keeps its size tied to the account's
      // current backlog instead of to lifetime payment count.
      expect(seen[N]).toBe(hashFor(1))
    } finally {
      timers.restore()
    }
  }, 20_000)

  test('a receivable that stays outstanding is never delivered twice', async () => {
    const hash = hashFor(1)
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ receivables: [receivableFor(hash)] }))) as unknown as typeof globalThis.fetch

    const timers = captureTimers()
    try {
      const node = new HttpNode({ url: RPC, pollInterval: 5, fetch: fetchImpl })
      const seen: string[] = []
      const stop = node.subscribe('kei_1', (event) => seen.push(event.hash))
      await timers.flush()
      // Many polls, the node saying the same thing every time — the case
      // pruning to "outstanding" exists to keep working for.
      for (let i = 0; i < 50; i += 1) await timers.step()
      stop()
      expect(seen).toEqual([hash])
    } finally {
      timers.restore()
    }
  })

  test('a failed poll does not clear seen, so recovery does not re-notify everything', async () => {
    const hash = hashFor(1)
    let attempts = 0
    const fetchImpl = (async () => {
      attempts += 1
      // First poll succeeds and reports the receivable. Second poll fails
      // outright. Third poll succeeds and reports the same receivable again —
      // still outstanding, not a new arrival.
      if (attempts === 2) throw new Error('ECONNREFUSED')
      return new Response(JSON.stringify({ receivables: [receivableFor(hash)] }))
    }) as unknown as typeof globalThis.fetch

    const timers = captureTimers()
    try {
      const node = new HttpNode({ url: RPC, pollInterval: 5, fetch: fetchImpl })
      const seen: string[] = []
      const stop = node.subscribe('kei_1', (event) => seen.push(event.hash))
      await timers.flush()
      // The initial poll from `subscribe` is attempt 1; two more steps drive
      // the failing attempt 2 and the recovering attempt 3.
      for (let i = 0; i < 2; i += 1) await timers.step()
      stop()
      expect(attempts).toBe(3)
      expect(seen).toEqual([hash])
    } finally {
      timers.restore()
    }
  })
})

/**
 * A node URL is somewhere people keep credentials, and a timeout message is
 * something people paste into an issue. What `safeEndpoint` keeps and drops is
 * pinned in endpoint.test.ts; what these two check is that every error path
 * through this client names the safe form and not `options.url`.
 */
describe('HttpNode error messages and the node URL', () => {
  test('userinfo, query and fragment never reach a timeout message', async () => {
    const node = new HttpNode({
      url: 'https://operator:hunter2-correct-horse@node.example:8443/rpc?apiKey=sk-live-9f8e7d6c5b4a3210&v=2#staging',
      requestTimeout: 10,
      fetch: deafFetch().fetch,
    })
    const error = await refused(node.accountInfo('kei_1'))

    expect(error.code).toBe('node-timeout')
    expect(error.message).toContain('https://node.example:8443/rpc')
    expect(error.message).not.toContain('operator')
    expect(error.message).not.toContain('hunter2-correct-horse')
    expect(error.message).not.toContain('apiKey')
    expect(error.message).not.toContain('sk-live-9f8e7d6c5b4a3210')
    expect(error.message).not.toContain('staging')
  })

  test('the same endpoint is what an unreachable node is named by', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch
    const node = new HttpNode({ url: 'https://operator:hunter2@node.example/rpc', fetch: fetchImpl })
    const error = await refused(node.accountInfo('kei_1'))
    expect(error.code).toBe('node-unreachable')
    expect(error.message).toContain('https://node.example/rpc')
    expect(error.message).not.toContain('hunter2')
  })
})
