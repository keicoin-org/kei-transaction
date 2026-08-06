/**
 * SPEC §6.7 tokens, and the policy flags §5.4 requires the protocol to enforce.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  Kei,
  KeiError,
  randomSeed,
  type IssueOptions,
  type IssuerToken,
  type MockNode,
  type TopUpFailure,
} from 'kei-transaction'

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
    const second = await game.token.issue({ name: 'Gems', symbol: 'gem' })

    expect(second.id).toBe(first.id)
    // No second burn, because nothing was issued the second time.
    expect(await game.balance()).toBe(balanceAfterFirst)
  })

  test('a full re-issue that matches writes no block and burns no Kei', async () => {
    const args: IssueOptions = {
      name: 'Gems',
      symbol: 'GEM',
      decimals: 2,
      maxSupply: 1_000_000,
      transfer: 'issuer-only',
      swap: 'off',
      rate: 100,
      description: 'The hard currency.',
      image: 'ipfs://gem',
      kind: 'token',
    }

    const first = await game.token.issue(args)
    const balanceAfterFirst = await game.balance()
    const blocksAfterFirst = (await node.accountInfo(game.address))?.height

    const second = await game.token.issue(args)
    expect(second.id).toBe(first.id)
    expect(await game.balance()).toBe(balanceAfterFirst)
    expect((await node.accountInfo(game.address))?.height).toBe(blocksAfterFirst)
    // And the issuer's asset count did not move, so the next asset is not dearer.
    expect((await node.accountInfo(game.address))?.issuedCount).toBe(1)
  })

  // SPEC §5.4: the policy is chosen at issuance and immutable thereafter. The
  // one call that can notice the source file and the chain disagreeing is this
  // one, so it has to say so out loud rather than report success.
  describe('a re-issue that contradicts the stored asset', () => {
    const original: IssueOptions = {
      name: 'Gold',
      symbol: 'GOLD',
      decimals: 0,
      maxSupply: 1_000_000,
      transfer: 'open',
      swap: 'one-way',
      description: 'Coin of the realm.',
      image: 'ipfs://gold',
      kind: 'token',
    }

    beforeEach(async () => {
      await game.token.issue(original)
    })

    test('tightening transfer is refused, not silently ignored', async () => {
      const attempt = game.token.issue({ ...original, transfer: 'issuer-only' })
      await expect(attempt).rejects.toThrow(
        /GOLD already exists on this account.*transfer is 'open' and you asked for 'issuer-only'.*immutable/s,
      )
      await expect(attempt).rejects.toThrow(/SPEC §5\.4/)
      // Still open on chain, and the caller was told rather than left guessing.
      const gold = await game.token('GOLD', game.address)
      expect(gold.transferPolicy).toBe('open')
    })

    test('every field the chain stores is compared', async () => {
      const cases: Array<[Partial<IssueOptions>, RegExp]> = [
        [{ name: 'Golde' }, /name is 'Gold' and you asked for 'Golde'/],
        [{ decimals: 2 }, /decimals is 0 and you asked for 2/],
        [{ maxSupply: 10_000_000 }, /maxSupply is 1000000 and you asked for 10000000/],
        [{ transfer: 'none' }, /transfer is 'open' and you asked for 'none'/],
        [{ swap: 'two-way' }, /swap is 'one-way' and you asked for 'two-way'/],
        [{ description: 'Nope.' }, /description is 'Coin of the realm\.' and you asked for 'Nope\.'/],
        [{ image: 'ipfs://other' }, /image is 'ipfs:\/\/gold' and you asked for 'ipfs:\/\/other'/],
        [{ kind: 'item' }, /kind is 'token' and you asked for 'item'/],
      ]
      for (const [override, expected] of cases) {
        await expect(game.token.issue({ ...original, ...override })).rejects.toThrow(expected)
      }
    })

    test('the refusal names every field that differs, not just the first', async () => {
      await expect(
        game.token.issue({ ...original, transfer: 'none', swap: 'off' }),
      ).rejects.toThrow(/transfer is 'open' and you asked for 'none'; swap is 'one-way' and you asked for 'off'/)
    })

    test('the refusal is a KeiError with a code an agent can branch on', async () => {
      try {
        await game.token.issue({ ...original, transfer: 'issuer-only' })
        throw new Error('should have refused')
      } catch (error) {
        expect((error as { code?: string }).code).toBe('issuance-mismatch')
      }
    })

    test('a field the caller omitted is not compared against a default', async () => {
      // No transfer, no swap, no maxSupply, no decimals, no metadata: this has
      // not asked for 'open', it has not asked.
      const gold = await game.token.issue({ name: 'Gold', symbol: 'GOLD' })
      expect(gold.transferPolicy).toBe('open')
      expect(gold.maxSupply).toBe(1_000_000)
    })

    test('rate is issuer configuration, so it never counts as a contradiction', async () => {
      const gold = await game.token.issue({ ...original, rate: 7 })
      expect(gold.rate).toBe(7)
    })
  })

  // maxSupply is a cap in whole units against a raw value on the chain, so at
  // 18 decimals a `number` comparison loses the bottom of it entirely.
  test('maxSupply is compared in raw units, at a scale a number cannot hold', async () => {
    const wei: IssueOptions = { name: 'Wei', symbol: 'WEI', decimals: 18, maxSupply: '1000000' }
    await game.token.issue(wei)

    // Same cap: no block, no burn.
    const balanceAfter = await game.balance()
    await game.token.issue(wei)
    expect(await game.balance()).toBe(balanceAfter)

    // One raw unit off — 10^-18 of a token, invisible as a float.
    await expect(
      game.token.issue({ ...wei, maxSupply: '1000000.000000000000000001' }),
    ).rejects.toThrow(/maxSupply is 1000000 and you asked for 1000000\.000000000000000001/)
  })

  test('a cap asked of an uncapped token says so', async () => {
    await game.token.issue({ name: 'Air', symbol: 'AIR' })
    await expect(game.token.issue({ name: 'Air', symbol: 'AIR', maxSupply: 10 })).rejects.toThrow(
      /maxSupply is uncapped and you asked for 10/,
    )
  })

  test('a first token burns 1 Kei — the one non-free operation (SPEC §5.6.5)', async () => {
    const before = await game.balance()
    await game.token.issue({ name: 'Gems', symbol: 'GEM' })
    expect(await game.balance()).toBe(before - 1)
  })

  // The nth asset an account issues burns n Kei, so a catalogue's running total
  // is quadratic rather than linear. This is the whole anti-spam mechanism.
  test('each further token costs one Kei more than the last', async () => {
    const before = await game.balance()
    await game.token.issue({ name: 'Gems', symbol: 'GEM' })
    await game.token.issue({ name: 'Ore', symbol: 'ORE' })
    await game.token.issue({ name: 'Wood', symbol: 'WOOD' })
    // 1 + 2 + 3, not 3 x 1.
    expect(await game.balance()).toBe(before - 6)

    const info = await node.accountInfo(game.address)
    expect(info?.issuedCount).toBe(3)
  })

  test('an unfunded issuer is told what it costs and how to fix it', async () => {
    const poor = await Kei.server({ seed: 'D'.repeat(64), node })
    await expect(poor.token.issue({ name: 'Gems', symbol: 'GEM' })).rejects.toThrow(
      /asset number 1, which burns 1 Kei.*holds 0 Kei.*faucet/s,
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

  test('a player burns their own units, and needs nothing from the issuer to do it', async () => {
    await gems.mint(player.address, 100)
    await player.sync()
    const token = await player.token('GEM', game.address)

    const burned = await token.burn(30)
    expect(burned.amount).toBe(30)
    expect(burned.hash).toMatch(/^[0-9A-F]{64}$/)
    expect(await token.balance()).toBe(70)
    // A sink is a sink: the units are gone from circulation, not parked
    // somewhere (SPEC §5.6.6).
    expect(await gems.supply()).toBe(70)
  })

  test('a burn is signed by whoever holds the units, so it is not the issuer\'s to refuse', async () => {
    const rank = await game.token.issue({ name: 'Rank', symbol: 'RANK', transfer: 'none' })
    await rank.mint(player.address, 1)
    await player.sync()

    // Soulbound: transfer is refused, and burning is the one exit (SPEC §5.4).
    const token = await player.token('RANK', game.address)
    await expect(token.transfer(other.address, 1)).rejects.toThrow(/soulbound/)
    await token.burn(1)
    expect(await rank.balanceOf(player.address)).toBe(0)
  })

  test('a player cannot burn what they do not hold', async () => {
    await gems.mint(player.address, 5)
    await player.sync()
    const token = await player.token('GEM', game.address)
    await expect(token.burn(6)).rejects.toThrow(/Not enough GEM/)
    await expect(token.burn(0)).rejects.toThrow(/greater than zero/)
    expect(await token.balance()).toBe(5)
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

  test('the policy is immutable, and asking for a different one is refused', async () => {
    await game.token.issue({ name: 'Coin', symbol: 'FIXED', transfer: 'issuer-only' })
    await expect(
      game.token.issue({ name: 'Coin', symbol: 'FIXED', transfer: 'open' }),
    ).rejects.toThrow(/transfer is 'issuer-only' and you asked for 'open'/)

    // Unchanged, which was always true; what is new is being told.
    const again = await game.token.issue({ name: 'Coin', symbol: 'FIXED' })
    expect(again.transferPolicy).toBe('issuer-only')
  })
})

describe('purchases', () => {
  test('two signed halves: player pays, issuer delivers (SPEC §6.3)', async () => {
    const gems = await game.token.issue({ name: 'Gems', symbol: 'GEM', decimals: 0 })

    // A Kei payment carries no memo until M4 (decisions-m2.md §17) — the
    // issuer correlates this purchase by the returned hash instead of by a
    // memo string, passed out of band the way a real order flow would.
    const delivered = new Promise<void>((resolve) => {
      game.onPayment(async ({ from, amount }) => {
        if (amount >= 0.05) {
          await gems.mint(from, 100)
          resolve()
        }
      })
    })

    await player.faucet(1)
    const ok = await player.pay({ to: game.address, amount: 0.05 })
    expect(ok.hash).toMatch(/^[0-9A-F]{64}$/)

    await delivered
    await player.sync()
    expect(await gems.balanceOf(player.address)).toBe(100)
  })

  test('a memo on a Kei payment is refused, not silently dropped (decisions-m2.md §17)', async () => {
    await player.faucet(1)
    await expect(player.pay({ to: game.address, amount: 0.05, memo: 'Sword of Testing' })).rejects.toThrow(
      /no wire representation until M4/,
    )
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

  test('acceptTopUps uses exact math for decimal payment amounts', async () => {
    const shards = await game.token.issue({ name: 'Shards', symbol: 'SHARD', decimals: 0, swap: 'one-way' })
    game.acceptTopUps({ token: shards, rate: 100 })

    await player.faucet(2)
    await player.pay({ to: game.address, amount: 0.29 })

    await waitFor(async () => (await shards.balanceOf(player.address)) === 29)
    await player.sync()
    expect(await shards.balanceOf(player.address)).toBe(29)
  })

  test('acceptTopUps floors to the token decimals', async () => {
    const gems = await game.token.issue({
      name: 'Gem Fragments',
      symbol: 'GF',
      decimals: 2,
      swap: 'one-way',
    })
    game.acceptTopUps({ token: gems, rate: 0.333 })

    await player.faucet(2)
    await player.pay({ to: game.address, amount: 1 })

    await waitFor(async () => (await gems.balanceOf(player.address)) === 0.33)
    await player.sync()
    expect(await gems.balanceOf(player.address)).toBe(0.33)
  })

  // #175: PaymentEvent.amount is fromRaw(raw, 18) — a double, which loses
  // precision above ~0.009 Kei. Feeding it back into the mint could create
  // raw units nobody paid for. acceptTopUps now computes from payment.raw,
  // the exact bigint, so this asserts against the raw circulating supply
  // rather than through balanceOf() — also a double, and unable to represent
  // the one- or two-unit differences this bug produced.
  test('acceptTopUps mints exactly the raw amount paid, even where a double cannot represent it (#175)', async () => {
    const shards = await game.token.issue({ name: 'Precise Shards', symbol: 'PSHARD', decimals: 18, swap: 'one-way' })
    game.acceptTopUps({ token: shards, rate: 1 })

    await player.faucet(1)
    // Sent as a string so toRaw() parses it exactly; the bug was entirely on
    // the receiving side, in how the received PaymentEvent got turned back
    // into a mint quantity.
    await player.pay({ to: game.address, amount: '0.123456789012345678' })

    await waitFor(async () => (await game.client.node.assetInfo(shards.id))?.circulating !== '0')
    await player.sync()

    const info = await game.client.node.assetInfo(shards.id)
    // Old behaviour minted 123456789012345680 — two raw units more than paid.
    expect(info?.circulating).toBe('123456789012345678')
  })

  test('acceptTopUps never mints more than floor(paid_raw * rate), across a range of awkward amounts', async () => {
    const shards = await game.token.issue({ name: 'Range Shards', symbol: 'RSHARD', decimals: 18, swap: 'one-way' })
    game.acceptTopUps({ token: shards, rate: 1 })

    const amounts = [
      '0.000000000000000001',
      '0.100000000000000001',
      '0.999999999999999999',
      '1.234567890123456789',
    ]
    let mintedSoFar = 0n
    for (const amount of amounts) {
      await player.faucet(2)
      await player.pay({ to: game.address, amount })
      const paidRaw = BigInt(amount.replace('.', ''))
      const expected = mintedSoFar + paidRaw
      await waitFor(async () => (await game.client.node.assetInfo(shards.id))?.circulating === expected.toString())
      mintedSoFar = expected
    }
    await player.sync()
    expect((await game.client.node.assetInfo(shards.id))?.circulating).toBe(mintedSoFar.toString())
  })

  test('acceptTopUps honours minimum exactly at the raw boundary, not a double approximation of it', async () => {
    const gems = await game.token.issue({ name: 'Boundary Gems', symbol: 'BGEM', decimals: 0, swap: 'one-way' })
    game.acceptTopUps({ token: gems, rate: 100, minimum: 0.05 })

    await player.faucet(1)
    // Exactly at the boundary: must be accepted, not excluded by a `<` that
    // compares two doubles that do not agree on where the boundary is.
    await player.pay({ to: game.address, amount: '0.05' })

    await waitFor(async () => (await gems.balanceOf(player.address)) === 5)
    await player.sync()
    expect(await gems.balanceOf(player.address)).toBe(5)
  })

  test('acceptTopUps accepts a decimal-string rate, exactly', async () => {
    const shards = await game.token.issue({ name: 'String Rate Shards', symbol: 'SRSHARD', decimals: 6, swap: 'one-way' })
    game.acceptTopUps({ token: shards, rate: '0.333333' })

    await player.faucet(2)
    await player.pay({ to: game.address, amount: 1 })

    await waitFor(async () => (await game.client.node.assetInfo(shards.id))?.circulating !== '0')
    await player.sync()
    expect((await game.client.node.assetInfo(shards.id))?.circulating).toBe('333333')
  })

  test('acceptTopUps refuses a token whose own policy says it cannot be bought', async () => {
    const earned = await game.token.issue({ name: 'Glory', symbol: 'GLORY', swap: 'off' })
    expect(() => game.acceptTopUps({ token: earned, rate: 10 })).toThrow(/swap: 'off'/)
  })

  // #164: onPayment fires after the Kei is already received and irreversible,
  // so a handler's failure has to be reported rather than lost. Three ways it
  // used to be lost: a synchronous throw never reaching `reportError`, a
  // rejected mint inside acceptTopUps naming nothing a game could act on, and
  // nothing surviving past the in-memory emitter.
  describe('onPayment and acceptTopUps do not lose a failure (#164)', () => {
    test('a synchronous throw in a handler reaches the error event, not nothing', async () => {
      const errors: KeiError[] = []
      game.client.on('error', (error) => errors.push(error))
      // The obvious way to write a handler — no async, no try/catch — used to
      // propagate straight into Emitter.emit's blanket swallow and vanish.
      game.onPayment(() => {
        throw new Error('boom')
      })

      await player.faucet(1)
      await player.pay({ to: game.address, amount: 0.01 })

      await waitFor(async () => errors.length > 0)
      expect(errors).toHaveLength(1)
      expect(errors[0]?.message).toContain('boom')
    })

    test('acceptTopUps reports a failed mint through onSettlementFailure, naming the payer, the raw amount, and what was owed', async () => {
      const gems = await game.token.issue({
        name: 'Gems', symbol: 'GEM', decimals: 0, maxSupply: 1_000, swap: 'one-way',
      })
      await gems.mint(game.address, 995) // 5 left under the cap

      const failures: TopUpFailure[] = []
      game.acceptTopUps({
        token: gems,
        rate: 100, // 1 Kei asks for 100 GEM — more than the 5 remaining
        onSettlementFailure: (failure) => {
          failures.push(failure)
        },
      })

      await player.faucet(1)
      await player.pay({ to: game.address, amount: 1 })

      await waitFor(async () => failures.length > 0)
      expect(failures).toHaveLength(1)
      const [failure] = failures
      expect(failure?.payment.from).toBe(player.address)
      // The exact raw amount (#175), not a re-derived double.
      expect(failure?.payment.raw).toBe('1000000000000000000')
      expect(failure?.owed).toBe('100')
      expect(String(failure?.error)).toMatch(/maximum supply/)

      // The Kei was already received and is not returned automatically —
      // acceptTopUps reports the shortfall, it does not invent a refund.
      expect(await game.balance()).toBeGreaterThan(0)
    })

    test('without onSettlementFailure, the error event still names the payer and the owed units', async () => {
      const gems = await game.token.issue({
        name: 'Gems', symbol: 'GEM', decimals: 0, maxSupply: 1_000, swap: 'one-way',
      })
      await gems.mint(game.address, 995)

      const errors: KeiError[] = []
      game.client.on('error', (error) => errors.push(error))
      game.acceptTopUps({ token: gems, rate: 100 })

      await player.faucet(1)
      await player.pay({ to: game.address, amount: 1 })

      await waitFor(async () => errors.length > 0)
      const [error] = errors
      expect(error?.message).toContain(player.address)
      expect(error?.message).toContain('100 GEM')
      expect(error?.message).toMatch(/not returned automatically/)
    })

    test('a settled top-up is not redelivered to a fresh client restarted against the same seed and node', async () => {
      const gems = await game.token.issue({ name: 'Gems', symbol: 'GEM', decimals: 0, swap: 'one-way' })
      game.acceptTopUps({ token: gems, rate: 100 })

      await player.faucet(1)
      await player.pay({ to: game.address, amount: 0.5 })
      await waitFor(async () => (await gems.balanceOf(player.address)) === 50)

      // The closest this test suite can come to "the server restarted": a
      // fresh Kei.server() against the identical seed and node, so it is a
      // different in-memory client over the same on-chain state.
      game.close()
      const restarted = await fundedGame()
      let redelivered = false
      restarted.onPayment(() => {
        redelivered = true
      })
      await restarted.sync()

      expect(redelivered).toBe(false)
      expect(await gems.balanceOf(player.address)).toBe(50)
      restarted.close()
    })
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
