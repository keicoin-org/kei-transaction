/**
 * M2's RPC contract, against either MockNode or the native node.
 *
 * Run normally for the reference model, or set KEI_NODE_URL to run this exact
 * file and these exact assertions against a live node. Commit/claim belong to
 * M4 and are deliberately tested in m4-node.test.ts instead.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { KEI_ASSET, ZERO_HASH, keyPairFromSeed, randomSeed, type Block } from '@keicoin/core'
import { nodeTestNetwork, type NodeTestNetwork } from './node-network.js'

let network: NodeTestNetwork

/**
 * The same file now runs three distances: an in-process mock, a node on
 * loopback, and the public testnet across the internet and a CDN. Only the last
 * one needs the room, and 5 s of it is not enough for a faucet plus its
 * confirmation.
 */
const TIMEOUT = process.env.KEI_NODE_URL ? 60_000 : 5_000

const rpc = (body: Record<string, unknown>): Promise<Response> =>
  network.request({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('the M2 node contract over HTTP', () => {
  beforeAll(async () => {
    network = await nodeTestNetwork()
  })

  // A test rather than a hook, because `beforeAll` takes no timeout and the
  // first request to a public endpoint pays for DNS, TCP, and TLS at once —
  // seconds, where every later request on the pooled connection is milliseconds.
  test('a node is answering at all', async () => {
    const response = await rpc({ action: 'work_thresholds' }).catch(() => null)
    if (!response?.ok) throw new Error(`No node is answering at ${network.url}.`)
    expect(response.ok).toBe(true)
  }, TIMEOUT)

  test('a faucet, then an account that exists', async () => {
    const http = network.connect()
    const keys = await keyPairFromSeed(randomSeed())
    expect(await http.accountInfo(keys.address)).toBeNull()
    const { hash } = await http.faucet(keys.address, (5n * 10n ** 18n).toString())
    expect(hash).toMatch(/^[0-9A-F]{64}$/)

    const receivables = await http.receivables(keys.address)
    expect(receivables).toHaveLength(1)
    expect(receivables[0]?.asset).toBe(KEI_ASSET)
    expect(receivables[0]?.amount).toBe((5n * 10n ** 18n).toString())
  }, TIMEOUT)

  test('unknown M2 records are null, empty, or zero rather than errors', async () => {
    const http = network.connect()
    const keys = await keyPairFromSeed(randomSeed())
    expect(await http.accountInfo(keys.address)).toBeNull()
    expect(await http.assetInfo('A'.repeat(64))).toBeNull()
    expect(await http.blockInfo('C'.repeat(64))).toBeNull()
    expect(await http.holdings(keys.address)).toEqual([])
    expect(await http.holderBalance('A'.repeat(64), keys.address)).toBe('0')
  }, TIMEOUT)

  test('history returns complete blocks, including a legacy open subtype', async () => {
    const http = network.connect()
    const keys = await keyPairFromSeed(randomSeed())
    const faucet = await network.faucetAccount()
    await http.faucet(keys.address, (5n * 10n ** 18n).toString())

    const history = await http.accountHistory(faucet, { limit: 10_000 })
    expect(history.length).toBeGreaterThan(1)
    const newest = history[0]!
    expect(newest.type).toBe('state')
    expect(newest.account).toBe(faucet)
    expect((newest as { subtype?: string }).subtype).toBe('send')
    for (const field of ['previous', 'representative', 'balance', 'link', 'signature', 'work'] as const) {
      expect(typeof (newest as unknown as Record<string, unknown>)[field]).toBe('string')
    }

    // Mock genesis is a state-open while the fork keeps its inherited legacy
    // open block. The shared contract is the semantic subtype the SDK needs.
    const oldest = history.at(-1) as unknown as Record<string, unknown>
    expect(oldest.subtype).toBe('open')
  }, TIMEOUT)

  test('work thresholds are ordered decimal strings', async () => {
    const thresholds = await network.connect().workThresholds()
    for (const tier of ['A', 'B', 'C'] as const) expect(thresholds[tier]).toMatch(/^[0-9]+$/)
    expect(BigInt(thresholds.A)).toBeGreaterThan(BigInt(thresholds.B))
    expect(BigInt(thresholds.B)).toBeGreaterThan(BigInt(thresholds.C))
  }, TIMEOUT)

  test('a rejected block is a sentence, not a status code', async () => {
    const http = network.connect()
    const keys = await keyPairFromSeed(randomSeed())
    const unsigned = {
      type: 'state', subtype: 'send', account: keys.address, previous: ZERO_HASH,
      representative: keys.address, balance: '0', link: ZERO_HASH,
      work: '0000000000000000', signature: '0'.repeat(128),
    } as unknown as Block
    await expect(http.process(unsigned)).rejects.toThrow(/rejected "process"/)
  }, TIMEOUT)

  test('an unknown action returns a useful JSON error', async () => {
    const response = await rpc({ action: 'definitely_not_an_action' })
    expect(response.status).toBe(200)
    const error = ((await response.json()) as { error?: unknown }).error
    expect(typeof error).toBe('string')
    expect((error as string).length).toBeGreaterThan(0)
  }, TIMEOUT)

  test('a browser can reach it through preflight and CORS', async () => {
    const preflight = await network.request({ method: 'OPTIONS' })
    expect(preflight.status).toBeLessThan(400)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    const answered = await rpc({ action: 'work_thresholds' })
    expect(answered.headers.get('access-control-allow-origin')).toBe('*')
  }, TIMEOUT)

  test('subscribe polls receivables, so an arrival is noticed without a socket', async () => {
    const http = network.connect()
    const keys = await keyPairFromSeed(randomSeed())
    const seen: string[] = []
    const stop = http.subscribe(keys.address, (event) => seen.push(event.hash))
    const { hash } = await http.faucet(keys.address)
    await Bun.sleep(network.live ? 3_000 : 50)
    stop()
    expect(seen).toContain(hash)
  }, TIMEOUT)
})
