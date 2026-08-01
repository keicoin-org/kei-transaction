import { afterEach, describe, expect, test } from 'bun:test'
import { MockNode, randomSeed } from '@keicoin/core'
import { startWorkServer, WorkServerProvider, type RunningWorkServer } from '../src/index.js'

describe('work HTTP server', () => {
  let running: RunningWorkServer | undefined
  afterEach(async () => running?.close())

  test('serves valid tiered work to the production client', async () => {
    const node = await MockNode.create()
    running = await startWorkServer(node)
    const provider = new WorkServerProvider({ url: running.url })
    const root = randomSeed()
    expect(await provider.generate(root, 'C')).toMatch(/^[0-9a-f]{16}$/i)
  })
})
