/**
 * `mockRpcHandler` — docs/rpc.md, executed.
 *
 * http-node.test.ts pins what `HttpNode` sends against a stub. This pins the
 * other half: a real node object answering those calls, driven by the real
 * client, so the two halves of the contract are checked against each other
 * rather than against two readings of the same document.
 */

import { describe, expect, test } from 'bun:test'
import {
  HttpNode,
  KEI_ASSET,
  MockNode,
  ZERO_HASH,
  keyPairFromSeed,
  mockRpcHandler,
  randomSeed,
  type Block,
} from '@keicoin/core'

/** An `HttpNode` and the `MockNode` behind it, joined by the handler alone. */
async function connected(): Promise<{ http: HttpNode; mock: MockNode }> {
  const mock = await MockNode.create()
  const handler = mockRpcHandler({ node: mock })
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) =>
    handler(new Request(String(url), init))) as unknown as typeof globalThis.fetch

  return { http: new HttpNode({ url: 'http://node.test/rpc', network: 'mock', pollInterval: 5, fetch: fetchImpl }), mock }
}

describe('the mock node over HTTP', () => {
  test('a faucet, then an account that exists', async () => {
    const { http } = await connected()
    const keys = await keyPairFromSeed(randomSeed())

    expect(await http.accountInfo(keys.address)).toBeNull()

    const { hash } = await http.faucet(keys.address, (5n * 10n ** 18n).toString())
    expect(hash).toMatch(/^[0-9A-F]{64}$/)

    const receivables = await http.receivables(keys.address)
    expect(receivables).toHaveLength(1)
    expect(receivables[0]?.asset).toBe(KEI_ASSET)
    expect(receivables[0]?.amount).toBe((5n * 10n ** 18n).toString())
  })

  test('an unknown account, asset, root and block are null, not errors', async () => {
    const { http } = await connected()
    const keys = await keyPairFromSeed(randomSeed())

    expect(await http.accountInfo(keys.address)).toBeNull()
    expect(await http.assetInfo('A'.repeat(64))).toBeNull()
    expect(await http.commitInfo('B'.repeat(64))).toBeNull()
    expect(await http.blockInfo('C'.repeat(64))).toBeNull()
    expect(await http.holdings(keys.address)).toEqual([])
    expect(await http.holderBalance('A'.repeat(64), keys.address)).toBe('0')
    expect(await http.hasClaimed(keys.address, 'B'.repeat(64))).toBe(false)
  })

  test('work thresholds come across as decimal strings', async () => {
    const { http, mock } = await connected()
    expect(await http.workThresholds()).toEqual(await mock.workThresholds())
  })

  test('a rejected block is a sentence, not a status code', async () => {
    const { http } = await connected()
    const keys = await keyPairFromSeed(randomSeed())
    const unsigned = {
      type: 'state',
      subtype: 'send',
      account: keys.address,
      previous: ZERO_HASH,
      representative: keys.address,
      balance: '0',
      link: ZERO_HASH,
      work: '0000000000000000',
      signature: '0'.repeat(128),
    } as unknown as Block

    await expect(http.process(unsigned)).rejects.toThrow(/rejected "process"/)
  })

  test('an action the node does not have says so, and points at the list', async () => {
    const { mock } = await connected()
    const handler = mockRpcHandler({ node: mock })
    const response = await handler(
      new Request('http://node.test/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'account_balance' }),
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      error: 'This node has no "account_balance" action. See docs/rpc.md for the list.',
    })
  })

  test('a browser can reach it — preflight and origin', async () => {
    const { mock } = await connected()
    const handler = mockRpcHandler({ node: mock })

    const preflight = await handler(new Request('http://node.test/rpc', { method: 'OPTIONS' }))
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')

    const answered = await handler(
      new Request('http://node.test/rpc', { method: 'POST', body: JSON.stringify({ action: 'work_thresholds' }) }),
    )
    expect(answered.headers.get('access-control-allow-origin')).toBe('*')
  })

  test('cors: false leaves the headers off', async () => {
    const { mock } = await connected()
    const handler = mockRpcHandler({ node: mock, cors: false })
    const response = await handler(
      new Request('http://node.test/rpc', { method: 'POST', body: JSON.stringify({ action: 'work_thresholds' }) }),
    )
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('subscribe polls receivables, so an arrival is noticed without a socket', async () => {
    const { http } = await connected()
    const keys = await keyPairFromSeed(randomSeed())

    const seen: string[] = []
    const stop = http.subscribe(keys.address, (event) => seen.push(event.hash))
    const { hash } = await http.faucet(keys.address)

    await Bun.sleep(40)
    stop()
    expect(seen).toContain(hash)
  })
})
