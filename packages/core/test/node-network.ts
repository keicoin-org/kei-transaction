import { HttpNode, MockNode, keyPairFromSeed, mockRpcHandler, randomSeed } from '@keicoin/core'

export interface NodeTestNetwork {
  readonly live: boolean
  readonly url: string
  connect(): HttpNode
  request(init: RequestInit): Promise<Response>
  faucetAccount(): Promise<string>
}

/** Use the reference mock by default, or the native node when KEI_NODE_URL is set. */
export async function nodeTestNetwork(): Promise<NodeTestNetwork> {
  const liveUrl = process.env.KEI_NODE_URL
  if (liveUrl) {
    // 50 ms is free against an in-process mock and 20 requests a second against
    // a public endpoint, which is the whole per-edge budget the gateway allows.
    const connect = () => new HttpNode({ url: liveUrl, network: 'testnet', pollInterval: 250 })
    let discoveredFaucet: string | undefined
    return {
      live: true,
      url: liveUrl,
      connect,
      request: (init) => fetch(liveUrl, init),
      faucetAccount: async () => {
        if (discoveredFaucet) return discoveredFaucet
        const keys = await keyPairFromSeed(randomSeed())
        await connect().faucet(keys.address, (1n * 10n ** 18n).toString())
        const from = (await connect().receivables(keys.address))[0]?.from
        if (!from) throw new Error('The faucet paid nothing, so its account could not be discovered.')
        discoveredFaucet = from
        return from
      },
    }
  }

  const mock = await MockNode.create()
  const handler = mockRpcHandler({ node: mock })
  const url = 'http://node.test/rpc'
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(String(input), init))) as unknown as typeof globalThis.fetch
  const connect = () => new HttpNode({ url, network: 'mock', pollInterval: 5, fetch: fetchImpl })
  return {
    live: false,
    url,
    connect,
    request: (init) => fetchImpl(url, init),
    faucetAccount: async () => mock.ledger.genesisAddresses().community,
  }
}
