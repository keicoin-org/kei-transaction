/**
 * Shipping a game on testnet (SPEC §5.9, §15).
 *
 * Testnet is where this SDK expects you to build and is the wrong place to
 * finish: its Kei is worth nothing and its chain can be reset, so a game that
 * reaches real players there has an economy with an expiry date nobody chose.
 * `Kei.server()` therefore refuses to boot a deployment pointed at testnet, and
 * the refusal names mainnet.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { HttpNode, KeiError, MockNode, mockRpcHandler, randomSeed, type NetworkName } from '@keicoin/core'
import { Kei, deploymentSignal } from 'kei-transaction'

const GAME_SEED = 'D'.repeat(64)
const touched = new Set<string>()

/** Set an environment variable for one test, and put the environment back after. */
function env(name: string, value: string | undefined): void {
  touched.add(name)
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  for (const name of touched) delete process.env[name]
  touched.clear()
})

/**
 * One node reachable only by URL, that says it is whichever network you ask for.
 * Returns a factory, because the issuer and the player are two processes and
 * must share nothing but the URL.
 */
async function networkOn(network: NetworkName): Promise<() => HttpNode> {
  const handler = mockRpcHandler({ node: await MockNode.create() })
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) =>
    handler(new Request(String(url), init))) as unknown as typeof globalThis.fetch
  return () => new HttpNode({ url: 'http://node.test/rpc', network, pollInterval: 5, fetch: fetchImpl })
}

/** A single client's view of a fresh testnet-shaped node. */
const nodeOn = async (network: NetworkName): Promise<HttpNode> => (await networkOn(network))()

describe('what counts as a deployment', () => {
  test('a developer machine is not one', () => {
    env('NODE_ENV', undefined)
    expect(deploymentSignal()).toBeUndefined()
  })

  test('NODE_ENV=production is, and is reported by name', () => {
    env('NODE_ENV', 'production')
    expect(deploymentSignal()).toBe('NODE_ENV=production')
  })

  test('so is a platform marker nobody set on purpose', () => {
    env('NODE_ENV', undefined)
    env('FLY_APP_NAME', 'crystal-clicker')
    expect(deploymentSignal()).toBe('FLY_APP_NAME')
  })

  test('NODE_ENV=development wins over nothing at all', () => {
    env('NODE_ENV', 'development')
    expect(deploymentSignal()).toBeUndefined()
  })
})

describe('a deployment pointed at testnet is pushed back on', () => {
  test('Kei.server() refuses, and the refusal says to move to mainnet', async () => {
    env('NODE_ENV', 'production')
    const node = await nodeOn('testnet')

    const failure = await Kei.server({ seed: GAME_SEED, node }).then(
      () => undefined,
      (error: unknown) => error as KeiError,
    )

    expect(failure).toBeInstanceOf(KeiError)
    expect(failure?.code).toBe('testnet-in-deployment')
    expect(failure?.message).toContain("network: 'mainnet'")
    // It says what tripped it, what it costs, and the one way past it.
    expect(failure?.message).toContain('NODE_ENV=production')
    expect(failure?.message).toMatch(/not worth anything/)
    expect(failure?.message).toMatch(/KEI_ALLOW_TESTNET=1/)
  })

  test('the refusal happens before the seed is used, and never carries it', async () => {
    env('NODE_ENV', 'production')
    const node = await nodeOn('testnet')
    await expect(Kei.server({ seed: GAME_SEED, node })).rejects.toThrow(
      expect.not.stringContaining(GAME_SEED) as unknown as string,
    )
  })

  test('a platform marker alone is enough to trip it', async () => {
    env('NODE_ENV', undefined)
    env('RAILWAY_ENVIRONMENT', 'production')
    const node = await nodeOn('testnet')
    await expect(Kei.server({ seed: GAME_SEED, node })).rejects.toThrow(/RAILWAY_ENVIRONMENT/)
  })
})

describe('what it does not block', () => {
  test('building on testnet on your own machine', async () => {
    env('NODE_ENV', undefined)
    const game = await Kei.server({ seed: GAME_SEED, node: await nodeOn('testnet') })
    expect(game.network).toBe('testnet')
    game.close()
  })

  test('a mock, deployed or not — it was never pretending to be money', async () => {
    env('NODE_ENV', 'production')
    const game = await Kei.server({ seed: GAME_SEED, node: await MockNode.create() })
    expect(game.network).toBe('mock')
    game.close()
  })

  test('a deployment that has said KEI_ALLOW_TESTNET=1 out loud', async () => {
    env('NODE_ENV', 'production')
    env('KEI_ALLOW_TESTNET', '1')
    const node = await networkOn('testnet')
    const game = await Kei.server({ seed: GAME_SEED, node: node() })
    expect(game.network).toBe('testnet')

    // And it is a working game, not a client that limped past a guard.
    await game.faucet(2_000)
    const coins = await game.token.issue({ name: 'Coins', symbol: 'COIN', decimals: 0 })
    const player = await Kei.start({ seed: randomSeed(), node: node() })
    await coins.mint(player.address, 5)
    await player.sync()
    expect(await (await player.token('COIN', game.address)).balance()).toBe(5)

    game.close()
    player.close()
  })

  test('the player half, which has no deploy of its own to guard', async () => {
    env('NODE_ENV', 'production')
    const player = await Kei.start({ seed: randomSeed(), node: await nodeOn('testnet') })
    expect(player.network).toBe('testnet')
    player.close()
  })
})

describe('following the advice', () => {
  test("network: 'mainnet' says why mainnet is not there yet", async () => {
    env('NODE_ENV', 'production')
    await expect(Kei.server({ seed: GAME_SEED, network: 'mainnet' })).rejects.toThrow(
      /mainnet is not open yet.*validator set/s,
    )
  })
})
