/** M4-only commit/claim RPC coverage. M2's native-node gate does not run this file. */

import { beforeAll, describe, expect, test } from 'bun:test'
import { keyPairFromSeed, randomSeed } from '@keicoin/core'
import { nodeTestNetwork, type NodeTestNetwork } from './node-network.js'

let network: NodeTestNetwork

describe('the deferred M4 node contract', () => {
  beforeAll(async () => {
    network = await nodeTestNetwork()
  })

  test('unknown commit roots and claims are absent rather than errors', async () => {
    const http = network.connect()
    const keys = await keyPairFromSeed(randomSeed())
    expect(await http.commitInfo('B'.repeat(64))).toBeNull()
    expect(await http.hasClaimed(keys.address, 'B'.repeat(64))).toBe(false)
  })
})
