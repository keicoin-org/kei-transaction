/**
 * SPEC §6.7 tokens, and the policy flags §5.4 requires the protocol to enforce.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { Kei, randomSeed, type IssuerToken, type MockNode } from 'kei-transaction'

const GAME_SEED = 'C'.repeat(64)

let node: MockNode
let game: Kei
let player: Kei
let other: Kei

async function fundedGame(): Promise<Kei> {
  const instance = await Kei.server({ seed: GAME_SEED, node })
  await instance.faucet(5_000)
  return instance
}

beforeEach(async () => {
  node = await Kei.mock()
  game = await fundedGame()
  player = await Kei.start({ node, seed: randomSeed() })
  other = await Kei.start({ node, seed: randomSeed() })
})

describe('issuing', () => {
  test('one call, and the developer never runs a database (SPEC §14.2)', async () => {
    const gems = await game.token.issue({
      name: 'Gems',
      symbol: 'GEM',
      decimals: 0,
      maxSupply: 1_000_000,
      transfer: 'open',
      swap: 'one-way',
      rate: 100,
    })

    expect(gems.symbol).toBe('GEM')
    expect(gems.decimals).toBe(0)
    expect(gems.maxSupply).toBe(1_000_000)
    expect(gems.transferPolicy).toBe('open')
    expect(gems.swap).toBe('one-way')
    expect(gems.rate).toBe(100)
    expect(gems.issuer).toBe(game.address)
    expect(gems.totalSupply).toBe(0)
  })

  test('is idempotent per (issuer, symbol) — the id is derived, not assigned', async () => {
    const first = await game.token.issue({ name: 'Gems', symbol: 'GEM' })
    const balanceAfterFirst = await game.balance()
    const second = await game.token.issue({ name: 'Gems Again', symbol: 'gem' })

    expect(second.id).toBe(first.id)
    // No second burn, because nothing was issued the second time.
    expect(await game.balance()).toBe(balanceAfterFirst)
  })

  test('burns exactly 1,000 Kei — the one non-free operation (SPEC §5.6.5)', async () => {
    const before = await game.balance()
    await game.token.issue({ name: 'Gems', symbol: 'GEM' })
    expect(await game.balance()).toBe(before - 1_000)
  })

  test('an unfunded issuer is told what it costs and how to fix it', async () => {
    const poor = await Kei.server({ seed: 'D'.repeat(64), node })
    await expect(poor.token.issue({ name: 'Gems', symbol: 'GEM' })).rejects.toThrow(
      /burns 1,000 Kei.*holds 0 Kei.*faucet/s,
    )
    poor.close()
  })

  test('a player cannot issue anything', async () => {
    await expect(player.token.issue({ name: 'Gems', symbol: 'GEM' })).rejects.toThrow(
      /Only an issuer can create a token/,
    )
  })
})

describe('mint, burn, balanceOf', () => {
  let gems: IssuerToken

  beforeEach(async () => {
    gems = await game.token.issue({ name: 'Gems', symbol: 'GEM', decimals: 0, maxSupply: 1_000 })
  })

  test('a quest reward arrives without the player doing anything', async () => {
    await gems.mint(player.address, 500)
    await player.sync()
    expect(await gems.balanceOf(player.address)).toBe(500)
    expect(await gems.supply()).toBe(500)
  })

  test('balanceOf answers in a single call (SPEC §14.3)', async () => {
    await gems.mint(player.address, 380)
    await player.sync()

    let calls = 0
    const counting = new Proxy(node, {
      get(target, key, receiver) {
        if (key === 'holderBalance') {
          calls++
        }
        return Reflect.get(target, key, receiver) as unknown
      },
    })
    const view = await Kei.start({ node: counting as unknown as MockNode, seed: randomSeed() })
    const token = await view.token('GEM', game.address)
    expect(await token.balanceOf(player.address)).toBe(380)
    expect(calls).toBe(1)
    view.close()
  })

  test('burning reduces circulating supply and frees headroom (SPEC §5.6.6)', async () => {
    await gems.mint(game.address, 1_000)
    await game.sync()
    await expect(gems.mint(player.address, 1)).rejects.toThrow(/maximum supply/)

    await gems.burn(400)
    expect(await gems.supply()).toBe(600)
    await gems.mint(player.address, 400)
    expect(await gems.supply()).toBe(1_000)
  })

  test('minting past maxSupply says how much room is left', async () => {
    await expect(gems.mint(player.address, 1_001)).rejects.toThrow(/only 1000 can be created/)
  })

  test('a player holding nothing reads zero, not an error', async () => {
    expect(await gems.balanceOf(other.address)).toBe(0)
  })

  test('spending the last unit removes the holding entirely (SPEC §7)', async () => {
    await gems.mint(player.address, 3)
    await player.sync()
    const token = await player.token('GEM', game.address)

    await token.transfer(other.address, 3)
    expect(await node.holdings(player.address)).toEqual([])
    await other.sync()
    expect(await token.balanceOf(other.address)).toBe(3)
  })
})

describe('transfer policy, enforced by the ledger and not by the SDK', () => {
  test('open: anyone may transfer to anyone', async () => {
    const gems = await game.token.issue({ name: 'Gems', symbol: 'OPENGEM', transfer: 'open' })
    await gems.mint(player.address, 10)
    await player.sync()

    const token = await player.token('OPENGEM', game.address)
    await token.transfer(other.address, 4)
    await other.sync()
    expect(await token.balanceOf(other.address)).toBe(4)
  })

  test('issuer-only: players cannot trade with each other, but can still spend', async () => {
    const coin = await game.token.issue({ name: 'Coin', symbol: 'CLOSED', transfer: 'issuer-only' })
    await coin.mint(player.address, 10)
    await player.sync()

    const token = await player.token('CLOSED', game.address)
    await expect(token.transfer(other.address, 1)).rejects.toThrow(
      /issuer-only: units may only move to or from/,
    )
    // Spending back to the game is still fine, which is the point.
    await token.transfer(game.address, 4)
    await game.sync()
    expect(await coin.balanceOf(game.address)).toBe(4)
  })

  test('none: soulbound, and the error says burning is the only exit', async () => {
    const rank = await game.token.issue({ name: 'Rank', symbol: 'RANK', transfer: 'none' })
    await rank.mint(player.address, 1)
    await player.sync()

    const token = await player.token('RANK', game.address)
    await expect(token.transfer(other.address, 1)).rejects.toThrow(/soulbound.*only be burned/s)
  })

  test('the policy is immutable: re-issuing does not change it', async () => {
    await game.token.issue({ name: 'Coin', symbol: 'FIXED', transfer: 'issuer-only' })
    const again = await game.token.issue({ name: 'Coin', symbol: 'FIXED', transfer: 'open' })
    expect(again.transferPolicy).toBe('issuer-only')
  })
})

describe('purchases', () => {
  test('two signed halves: player pays, issuer delivers (SPEC §6.3)', async () => {
    const gems = await game.token.issue({ name: 'Gems', symbol: 'GEM', decimals: 0 })

    const delivered = new Promise<void>((resolve) => {
      game.onPayment(async ({ from, amount, memo }) => {
        expect(memo).toBe('Sword of Testing')
        if (amount >= 0.05) {
          await gems.mint(from, 100)
          resolve()
        }
      })
    })

    await player.faucet(1)
    const ok = await player.pay({ to: game.address, amount: 0.05, memo: 'Sword of Testing' })
    expect(ok.hash).toMatch(/^[0-9A-F]{64}$/)

    await delivered
    await player.sync()
    expect(await gems.balanceOf(player.address)).toBe(100)
  })

  test('acceptTopUps mints at the declared rate', async () => {
    const gems = await game.token.issue({ name: 'Gems', symbol: 'GEM', decimals: 0, swap: 'one-way' })
    game.acceptTopUps({ token: gems, rate: 100 })

    await player.faucet(2)
    await player.pay({ to: game.address, amount: 1.5 })

    await waitFor(async () => (await gems.balanceOf(player.address)) === 150)
    await player.sync()
    expect(await gems.balanceOf(player.address)).toBe(150)
  })

  test('acceptTopUps refuses a token whose own policy says it cannot be bought', async () => {
    const earned = await game.token.issue({ name: 'Glory', symbol: 'GLORY', swap: 'off' })
    expect(() => game.acceptTopUps({ token: earned, rate: 10 })).toThrow(/swap: 'off'/)
  })

  test('there is no charge(someoneElse) — a game cannot sign for a player', () => {
    expect((game as unknown as Record<string, unknown>).charge).toBeUndefined()
    expect((player as unknown as Record<string, unknown>).charge).toBeUndefined()
  })
})

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}
