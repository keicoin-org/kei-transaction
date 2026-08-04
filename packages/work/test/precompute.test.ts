import { describe, expect, test } from 'bun:test'
import {
  KeiClient,
  MOCK_THRESHOLDS,
  MockNode,
  generateWork,
  keyPairFromSeed,
  type WorkProvider,
  type WorkTier,
} from '@keicoin/core'
import { WorkServerProvider } from '../src/index.js'

const ROOT_A = 'A'.repeat(64)
const ROOT_B = 'B'.repeat(64)

function workResponse(work = '0000000000000000'): Response {
  return new Response(JSON.stringify({ work }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

type FetchStub = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function providerWith(fetchImpl: FetchStub, fallback?: WorkProvider): WorkServerProvider {
  return new WorkServerProvider({
    url: 'https://work.invalid',
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
    ...(fallback ? { fallback } : {}),
  })
}

describe('WorkServerProvider precompute', () => {
  test('a resolved precompute is consumed once by the same normalized root and tier', async () => {
    let calls = 0
    const provider = providerWith(async () => {
      calls++
      return workResponse()
    })

    provider.precompute(ROOT_A.toLowerCase(), 'B')
    await Promise.resolve()

    expect(await provider.generate(ROOT_A, 'B')).toBe('0000000000000000')
    expect(calls).toBe(1)

    await provider.generate(ROOT_A, 'B')
    expect(calls).toBe(2)
  })

  test('generate racing a pending precompute awaits the same request', async () => {
    let calls = 0
    let release!: (response: Response) => void
    const provider = providerWith(() => {
      calls++
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    })

    provider.precompute(ROOT_A, 'B')
    const generated = provider.generate(ROOT_A, 'B')

    expect(calls).toBe(1)
    release(workResponse('1111111111111111'))
    expect(await generated).toBe('1111111111111111')
    expect(calls).toBe(1)
  })

  test('duplicate precomputes coalesce while preserving root and tier separation', async () => {
    const requests: Array<{ hash: string; tier: WorkTier }> = []
    const provider = providerWith(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { hash: string; tier: WorkTier }
      requests.push({ hash: body.hash, tier: body.tier })
      return workResponse(String(requests.length).padStart(16, '0'))
    })

    provider.precompute(ROOT_A, 'B')
    provider.precompute(ROOT_A.toLowerCase(), 'B')
    provider.precompute(ROOT_A, 'C')
    provider.precompute(ROOT_B, 'B')

    expect(requests).toEqual([
      { hash: ROOT_A, tier: 'B' },
      { hash: ROOT_A, tier: 'C' },
      { hash: ROOT_B, tier: 'B' },
    ])
    expect(await provider.generate(ROOT_A, 'B')).toBe('0000000000000001')
    expect(await provider.generate(ROOT_A, 'C')).toBe('0000000000000002')
    expect(await provider.generate(ROOT_B, 'B')).toBe('0000000000000003')
    expect(requests).toHaveLength(3)
  })

  test('failed and invalid speculative responses are evicted so generate retries', async () => {
    for (const firstResponse of [
      new Response('unavailable', { status: 503 }),
      new Response(JSON.stringify({ error: 'no work' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]) {
      let calls = 0
      const provider = providerWith(async () => {
        calls++
        return calls === 1 ? firstResponse : workResponse('2222222222222222')
      })

      provider.precompute(ROOT_A, 'B')
      await Bun.sleep(0)

      expect(await provider.generate(ROOT_A, 'B')).toBe('2222222222222222')
      expect(calls).toBe(2)
    }
  })

  test('a successful fallback remains precomputed and is consumed normally', async () => {
    let fetchCalls = 0
    let fallbackCalls = 0
    const fallback: WorkProvider = {
      async generate() {
        fallbackCalls++
        return '3333333333333333'
      },
    }
    const provider = providerWith(async () => {
      fetchCalls++
      throw new Error('offline')
    }, fallback)

    provider.precompute(ROOT_A, 'B')
    await Promise.resolve()
    expect(await provider.generate(ROOT_A, 'B')).toBe('3333333333333333')
    expect(fetchCalls).toBe(1)
    expect(fallbackCalls).toBe(1)
  })

  test('retention is bounded to eight entries with deterministic oldest-first eviction', async () => {
    let calls = 0
    const provider = providerWith(async () => {
      calls++
      return workResponse(calls.toString(16).padStart(16, '0'))
    })
    const roots = Array.from({ length: 9 }, (_, index) => index.toString(16).padStart(64, '0'))

    for (const root of roots) provider.precompute(root, 'B')
    await Promise.resolve()
    expect(calls).toBe(9)

    // The ninth insertion evicts root 0, while the newest entry remains ready.
    expect(await provider.generate(roots[0]!, 'B')).toBe('000000000000000a')
    expect(calls).toBe(10)
    expect(await provider.generate(roots[8]!, 'B')).toBe('0000000000000009')
    expect(calls).toBe(10)
  })

  test('AccountClient consumes the work precomputed for its accepted frontier', async () => {
    const requests: Array<{ hash: string; tier: WorkTier }> = []
    const provider = providerWith(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { hash: string; tier: WorkTier }
      requests.push(body)
      return workResponse(generateWork(body.hash, BigInt(MOCK_THRESHOLDS[body.tier])))
    })
    const node = await MockNode.create()
    const payer = await keyPairFromSeed('A1'.repeat(32))
    const payee = await keyPairFromSeed('B2'.repeat(32))
    const client = new KeiClient({ node, work: provider, keys: payer, role: 'player' })

    await client.faucet(2)
    const funded = await node.accountInfo(payer.address)
    expect(funded?.frontier).toBe(requests[1]?.hash)
    expect(requests).toHaveLength(2)

    const sent = await client.send(payee.address, 1)
    // The send consumes request 2. Only the next-frontier precompute is new;
    // a broken provider would also issue a second request for funded.frontier.
    expect(requests).toHaveLength(3)
    expect(requests[2]?.hash).toBe(sent.hash)
  })
})
