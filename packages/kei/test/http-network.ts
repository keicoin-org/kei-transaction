import { HttpNode, MockNode, mockRpcHandler } from '@keicoin/core'

/** One endpoint and no shared client state; KEI_NODE_URL swaps only the transport. */
export async function httpNodeFactory(): Promise<() => HttpNode> {
  const liveUrl = process.env.KEI_NODE_URL
  if (liveUrl) return () => new HttpNode({ url: liveUrl, network: 'testnet', pollInterval: 50 })

  const handler = mockRpcHandler({ node: await MockNode.create() })
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) =>
    handler(new Request(String(url), init))) as unknown as typeof globalThis.fetch
  return () => new HttpNode({ url: 'http://node.test/rpc', network: 'mock', pollInterval: 5, fetch: fetchImpl })
}
