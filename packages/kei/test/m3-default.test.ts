import { describe, expect, test } from 'bun:test'
import { HttpNode, Kei, randomSeed } from 'kei-transaction'

describe('M3 default transport', () => {
  test('Kei.start() selects the real testnet while mock stays explicit', async () => {
    const live = await Kei.start({ seed: randomSeed(), autoReceive: false })
    expect(live.network).toBe('testnet')
    expect(live.client.node).toBeInstanceOf(HttpNode)
    expect((live.client.node as unknown as { url: string }).url).toBe(
      'https://testnet.keicoin.org/rpc',
    )
    live.close()

    const mock = await Kei.start({ network: 'mock', seed: randomSeed(), autoReceive: false })
    expect(mock.network).toBe('mock')
    mock.close()
  })
})
