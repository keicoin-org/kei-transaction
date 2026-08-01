/** Mock-handler-only behaviour; the shared M2 contract lives in m2-node.test.ts. */

import { describe, expect, test } from 'bun:test'
import { HttpNode, MockNode, mockRpcHandler } from '@keicoin/core'

async function connected(): Promise<{ http: HttpNode; mock: MockNode }> {
  const mock = await MockNode.create()
  const handler = mockRpcHandler({ node: mock })
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) =>
    handler(new Request(String(url), init))) as unknown as typeof globalThis.fetch
  return { http: new HttpNode({ url: 'http://node.test/rpc', network: 'mock', pollInterval: 5, fetch: fetchImpl }), mock }
}

describe('mock-only HTTP handler behaviour', () => {
  test('account_history without a shape is refused rather than guessed', async () => {
    const { mock } = await connected()
    const handler = mockRpcHandler({ node: mock })
    const response = await handler(
      new Request('http://node.test/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'account_history', account: mock.ledger.genesisAddresses().community }),
      }),
    )
    expect(((await response.json()) as { error?: string }).error).toMatch(/"shape": "block"/)
  })

  test('HttpNode and MockNode publish the same work thresholds', async () => {
    const { http, mock } = await connected()
    expect(await http.workThresholds()).toEqual(await mock.workThresholds())
  })

  test('cors: false leaves the headers off', async () => {
    const { mock } = await connected()
    const handler = mockRpcHandler({ node: mock, cors: false })
    const response = await handler(
      new Request('http://node.test/rpc', { method: 'POST', body: JSON.stringify({ action: 'work_thresholds' }) }),
    )
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})
