/**
 * The parts where getting it wrong is a security incident rather than a bug:
 * SPEC §6.3 (two entry points, one signer each), §6.4/§6.6 (seed handling), and
 * acceptance criteria 6 and 8.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { containsSecret, keyPairFromSeed, randomSeed, type MockNode } from '@keicoin/core'
import { Kei as KeiFacade } from 'kei-transaction'
import { assertServerOnly, looksLikeBrowser } from 'kei-transaction'

const GAME_SEED = 'C'.repeat(64)
let node: MockNode

beforeEach(async () => {
  node = await KeiFacade.mock()
})

describe('the issuer seed cannot reach a browser (acceptance criterion 6)', () => {
  test('Kei.server() refuses to run when a document is present, and says why', async () => {
    const scope = globalThis as { window?: unknown; document?: unknown }
    const hadWindow = 'window' in scope
    scope.window = {}
    scope.document = {}
    try {
      expect(looksLikeBrowser()).toBe(true)
      expect(() => assertServerOnly()).toThrow(/refusing to run.*mint your currency without limit/s)
      await expect(KeiFacade.server({ seed: GAME_SEED, node })).rejects.toThrow(/refusing to run/)
    } finally {
      delete scope.document
      if (!hadWindow) delete scope.window
    }
  })

  test('the refusal message does not contain the seed', async () => {
    const scope = globalThis as { window?: unknown; document?: unknown }
    scope.window = {}
    scope.document = {}
    try {
      await KeiFacade.server({ seed: GAME_SEED, node })
      throw new Error('should have refused')
    } catch (error) {
      expect((error as Error).message).not.toContain(GAME_SEED)
    } finally {
      delete scope.document
      delete scope.window
    }
  })

  test('a missing issuer seed explains where to put one', async () => {
    await expect(
      KeiFacade.server({ seed: undefined as unknown as string, node }),
    ).rejects.toThrow(/process\.env\.KEI_SEED/)
  })
})

describe('one signer per operation (SPEC §6.3)', () => {
  test('a player cannot mint or issue', async () => {
    const game = await KeiFacade.server({ seed: GAME_SEED, node })
    await game.faucet(5_000)
    await game.token.issue({ name: 'Gems', symbol: 'GEM', decimals: 0 })

    const player = await KeiFacade.start({ node, seed: randomSeed() })
    const gems = await player.token('GEM', game.address)

    expect((gems as unknown as Record<string, unknown>).mint).toBeUndefined()
    await expect(player.token.issue({ name: 'Fake Gems', symbol: 'FAKE' })).rejects.toThrow(
      /Only an issuer/,
    )
  })

  /**
   * Burning used to be asserted absent from the player surface alongside mint
   * and issue. That was an SDK-shape assumption the ledger never made: `burn`
   * debits the signer's own holding and checks nobody's issuer (SPEC §5.6.6),
   * which is exactly why a soulbound token's refusal says burning is its one
   * exit (§5.4). The property that matters is not that a player cannot burn —
   * it is that a player can only burn what is theirs.
   */
  test('a player burns only their own units, and cannot reach anybody else\'s', async () => {
    const game = await KeiFacade.server({ seed: GAME_SEED, node })
    await game.faucet(5_000)
    const gems = await game.token.issue({ name: 'Gems', symbol: 'GEM', decimals: 0 })

    const player = await KeiFacade.start({ node, seed: randomSeed() })
    const other = await KeiFacade.start({ node, seed: randomSeed() })
    await gems.mint(player.address, 10)
    await gems.mint(other.address, 10)
    await Promise.all([player.sync(), other.sync()])

    const token = await player.token('GEM', game.address)
    // No `from`: the signer is the holder, so there is no argument through
    // which somebody else's balance could be named.
    expect(token.burn.length).toBe(1)
    await token.burn(4)

    expect(await gems.balanceOf(player.address)).toBe(6)
    expect(await gems.balanceOf(other.address)).toBe(10)
    // Past their own balance it is refused by the ledger, not by the SDK.
    await expect(token.burn(7)).rejects.toThrow(/Not enough GEM/)
    expect(await gems.balanceOf(other.address)).toBe(10)

    player.close()
    other.close()
  })

  test('a block signed by the wrong key is rejected by the ledger', async () => {
    const attacker = await keyPairFromSeed('E'.repeat(64))
    const victim = await keyPairFromSeed('F'.repeat(64))
    const { hashBlock, generateWork, workRoot, signHash, tierFor, MOCK_THRESHOLDS, ZERO_HASH } =
      await import('@keicoin/core')

    const body = {
      type: 'state' as const,
      subtype: 'change' as const,
      account: victim.address,
      previous: ZERO_HASH,
      representative: attacker.address,
      balance: '0',
      link: ZERO_HASH,
    }
    const hash = hashBlock(body)
    const forged = {
      ...body,
      // Valid work, so the block is rejected on its signature and not waved
      // away by the cheaper anti-spam check first.
      work: generateWork(workRoot(body), BigInt(MOCK_THRESHOLDS[tierFor(body)])),
      // Signed by the attacker, claiming to be the victim's block.
      signature: await signHash(attacker.privateKey, hash),
    }
    await expect(node.process(forged)).rejects.toThrow(/not signed by/)
  })

  test('transfer takes no `from` — the signer is the sender', async () => {
    const game = await KeiFacade.server({ seed: GAME_SEED, node })
    await game.faucet(5_000)
    const gems = await game.token.issue({ name: 'Gems', symbol: 'GEM', decimals: 0 })
    const player = await KeiFacade.start({ node, seed: randomSeed() })
    await gems.mint(player.address, 10)
    await player.sync()

    const token = await player.token('GEM', game.address)
    expect(token.transfer.length).toBe(2)
  })
})

describe('seeds (SPEC §6.4, §6.6)', () => {
  test('reveal defaults to on-request, and exports for backup', async () => {
    const seed = randomSeed()
    const kei = await KeiFacade.start({ node, seed })
    expect(kei.seed).toBe(seed)
    kei.close()
  })

  test('reveal: never refuses, and names the setting that would change it', async () => {
    const kei = await KeiFacade.start({ node, seed: randomSeed(), reveal: 'never' })
    expect(() => kei.seed).toThrow(/reveal: 'never'.*Kei\.start\(\)/s)
    kei.close()
  })

  test('no seed appears in any error, under any policy (acceptance criterion 8)', async () => {
    const seed = randomSeed()
    const kei = await KeiFacade.start({ node, seed })
    const errors: string[] = []

    const capture = async (action: () => Promise<unknown>): Promise<void> => {
      try {
        await action()
      } catch (error) {
        errors.push(String((error as Error).message), String((error as Error).stack ?? ''))
      }
    }

    const stranger = await KeiFacade.start({ node, seed: randomSeed() })
    await capture(() => kei.send('kei_not_an_address', 1))
    await capture(() => kei.send(kei.address, 1))
    await capture(() => kei.send(stranger.address, 999))
    await capture(() => kei.token('NOPE'))
    await capture(() => kei.claims.claim({ root: '0'.repeat(64), asset: '0'.repeat(64), amount: '1', proof: [] }))
    await capture(() => kei.pay({ to: kei.address, amount: -1 }))

    expect(errors.length).toBeGreaterThan(4)
    for (const text of errors) {
      expect(text).not.toContain(seed)
      expect(text).not.toContain(seed.toLowerCase())
      expect(containsSecret(text)).toBe(false)
    }
    kei.close()
    stranger.close()
  })

  test('a seed never leaves through a serialised client', async () => {
    const seed = randomSeed()
    const kei = await KeiFacade.start({ node, seed })
    expect(JSON.stringify(kei)).not.toContain(seed)
    expect(JSON.stringify(kei.client)).not.toContain(seed)
    expect(Object.keys(kei.client)).not.toContain('keys')
    kei.close()
  })
})

describe('consensus weight comes from Kei only (SPEC §5.6.2)', () => {
  test('a token with an absurd supply buys no weight at all', async () => {
    const game = await KeiFacade.server({ seed: GAME_SEED, node })
    await game.faucet(5_000)
    const huge = await game.token.issue({
      name: 'Capture',
      symbol: 'CAPTURE',
      decimals: 0,
      maxSupply: '1000000000000000000000000000000',
    })
    await huge.mint(game.address, '1000000000000000000000000000000')
    await game.sync()

    const weights = node.ledger.weights()
    const keiBalance = BigInt((await node.accountInfo(game.address))?.balance ?? '0')
    expect(weights.get(game.address)).toBe(keiBalance)
  })

  test('reserve accounts hold 90% of supply and carry no weight of any kind (SPEC §5.7)', async () => {
    const addresses = node.ledger.genesisAddresses()
    const reserve = await node.accountInfo(addresses.reserve)
    expect(reserve?.balance).toBe((900_000_000_000n * 10n ** 18n).toString())
    expect(node.ledger.isReserve(addresses.reserve)).toBe(true)
    expect(node.ledger.weights().get(addresses.reserve)).toBeUndefined()

    // And it cannot be moved without the vote that does not exist yet.
    for (const [role, address] of Object.entries(addresses)) {
      if (role !== 'reserve') expect(node.ledger.isReserve(address)).toBe(false)
    }
  })

  test('circulating allocations sum to exactly 100 billion Kei', async () => {
    const addresses = node.ledger.genesisAddresses()
    let circulating = 0n
    for (const [role, address] of Object.entries(addresses)) {
      if (role === 'reserve') continue
      circulating += BigInt((await node.accountInfo(address))?.balance ?? '0')
    }
    expect(circulating).toBe(100_000_000_000n * 10n ** 18n)
  })
})
