/**
 * The RPC contract (docs/rpc.md).
 *
 * No node answers this yet — that is M2/M3. What this pins is the request and
 * response shape the node fork has to serve, so "swap the mock for RPC" is a
 * one-line change at the call site and not a renegotiation.
 */

import { describe, expect, test } from 'bun:test'
import { HttpNode } from '@keicoin/core'

interface Call {
  action: string
  body: Record<string, unknown>
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
    expect((await node.workThresholds()).B).toBe('2')

    expect(calls.map((call) => call.action)).toEqual([
      'account_info',
      'asset_balance',
      'account_holdings',
      'commit_info',
      'claim_status',
      'work_thresholds',
    ])
    expect(calls[0]?.body).toEqual({ action: 'account_info', account: 'kei_1' })
    expect(calls[1]?.body).toEqual({ action: 'asset_balance', asset: 'B'.repeat(64), account: 'kei_1' })
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
