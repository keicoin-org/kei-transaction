/**
 * SPEC §5.5 — everything on-chain, made to scale by moving the signature to the
 * player: one issuer root, many parallel player claims.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { Kei, randomSeed, type IssuerToken, type MockNode } from 'kei-transaction'

let node: MockNode
let game: Kei
let gems: IssuerToken
let playerA: Kei
let playerB: Kei

beforeEach(async () => {
  node = await Kei.mock()
  game = await Kei.server({ seed: 'C'.repeat(64), node })
  await game.faucet(5_000)
  gems = await game.token.issue({ name: 'Gems', symbol: 'GEM', decimals: 0 })
  playerA = await Kei.start({ node, seed: randomSeed() })
  playerB = await Kei.start({ node, seed: randomSeed() })
})

describe('rooted claims', () => {
  test('one issuer block underwrites a whole batch', async () => {
    const drop = await gems.commit([
      { to: playerA.address, amount: 500 },
      { to: playerB.address, amount: 120 },
    ])

    expect(drop.root).toMatch(/^[0-9A-F]{64}$/)
    expect(drop.count).toBe(2)
    // One block on the issuer's chain, whatever the batch size.
    const history = await node.accountHistory(game.address, { limit: 1 })
    expect(history[0]?.type).toBe('asset')

    await playerA.claims.add(drop.proofFor(playerA.address))
    expect(await gems.balanceOf(playerA.address)).toBe(500)
    expect(await gems.balanceOf(playerB.address)).toBe(0)
  })

  test('the same batch twice is two drops, not a duplicate root', async () => {
    // A game hands out the same reward to the same player all the time, and a
    // root derived only from who-is-owed-what would collide on the second one.
    const first = await gems.commit([{ to: playerA.address, amount: 20 }])
    const second = await gems.commit([{ to: playerA.address, amount: 20 }])

    expect(second.root).not.toBe(first.root)
    expect(second.salt).not.toBe(first.salt)

    await playerA.claims.add(first.proofFor(playerA.address))
    await playerA.claims.add(second.proofFor(playerA.address))
    expect(await gems.balanceOf(playerA.address)).toBe(40)
  })

  test('a salt is not an entitlement — only recipients are counted', async () => {
    const drop = await gems.commit([{ to: playerA.address, amount: 7 }])
    expect(drop.count).toBe(1)
    expect(drop.total).toBe('7')
    expect(await node.commitInfo(drop.root)).toMatchObject({ count: 1, total: '7' })
  })

  test('a fixed salt reproduces a root exactly', async () => {
    const salt = 'A'.repeat(64)
    const { buildCommit } = await import('kei-transaction')
    const one = buildCommit({ asset: gems.id, decimals: 0, entries: [{ to: playerA.address, amount: 3 }], salt })
    const two = buildCommit({ asset: gems.id, decimals: 0, entries: [{ to: playerA.address, amount: 3 }], salt })
    expect(two.root).toBe(one.root)
  })

  test('each claim is written by a different account, on its own chain', async () => {
    const drop = await gems.commit([
      { to: playerA.address, amount: 1 },
      { to: playerB.address, amount: 2 },
    ])
    await playerA.claims.add(drop.proofFor(playerA.address))
    await playerB.claims.add(drop.proofFor(playerB.address))

    const infoA = await node.accountInfo(playerA.address)
    const infoB = await node.accountInfo(playerB.address)
    expect(infoA?.height).toBe(1)
    expect(infoB?.height).toBe(1)
    expect(infoA?.frontier).not.toBe(infoB?.frontier)
  })

  test('a claim is rejected twice — the index is keyed (account, root)', async () => {
    const drop = await gems.commit([{ to: playerA.address, amount: 500 }])
    const bundle = drop.proofFor(playerA.address)

    await playerA.claims.add(bundle)
    expect(await node.hasClaimed(playerA.address, drop.root)).toBe(true)
    await expect(playerA.claims.claim(bundle)).rejects.toThrow(/already claimed/)
    expect(await gems.balanceOf(playerA.address)).toBe(500)
  })

  test('a forged proof is rejected, and a forged amount is too', async () => {
    const drop = await gems.commit([
      { to: playerA.address, amount: 500 },
      { to: playerB.address, amount: 120 },
    ])
    const bundle = drop.proofFor(playerA.address)

    await expect(playerA.claims.claim({ ...bundle, amount: '999' })).rejects.toThrow(/does not put/)
    await expect(playerB.claims.claim({ ...bundle })).rejects.toThrow(/does not put/)
    expect(await gems.balanceOf(playerA.address)).toBe(0)
  })

  test('somebody not in the drop cannot be given a proof at all', async () => {
    const drop = await gems.commit([{ to: playerA.address, amount: 500 }])
    expect(() => drop.proofFor(playerB.address)).toThrow(/is not in this drop/)
  })

  test('two rewards for the same player in one batch merge into one leaf', async () => {
    const drop = await gems.commit([
      { to: playerA.address, amount: 500 },
      { to: playerA.address, amount: 250 },
    ])
    expect(drop.count).toBe(1)
    await playerA.claims.add(drop.proofFor(playerA.address))
    expect(await gems.balanceOf(playerA.address)).toBe(750)
  })

  test('a closed root accepts no further claims (SPEC §5.5)', async () => {
    const drop = await gems.commit([
      { to: playerA.address, amount: 5 },
      { to: playerB.address, amount: 5 },
    ])
    await playerA.claims.add(drop.proofFor(playerA.address))
    await gems.close(drop.root)

    await expect(playerB.claims.claim(drop.proofFor(playerB.address))).rejects.toThrow(
      /closed by its issuer/,
    )
    expect((await node.commitInfo(drop.root))?.closed).toBe(true)
  })

  test('pending() lists what a wallet holds a proof for, and drops dead bundles', async () => {
    const drop = await gems.commit([{ to: playerA.address, amount: 7 }])
    const held = await Kei.start({ node, seed: randomSeed(), autoClaim: false })
    const forHeld = await gems.commit([{ to: held.address, amount: 9 }])

    await held.claims.add(forHeld.proofFor(held.address))
    const pending = await held.claims.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.amount).toBe(9)
    expect(pending[0]?.symbol).toBe('GEM')

    await held.claims.claimAll()
    expect(await held.claims.pending()).toHaveLength(0)
    expect(await gems.balanceOf(held.address)).toBe(9)
    void drop
    held.close()
  })

  test('claiming is automatic: hand the SDK a proof and it lands', async () => {
    const drop = await gems.commit([{ to: playerA.address, amount: 42 }])
    // No claim() call anywhere — this is what a game hands its player.
    await playerA.claims.add(drop.proofFor(playerA.address))
    expect(await gems.balanceOf(playerA.address)).toBe(42)
  })

  test('a thousand players claim in parallel without touching the issuer (SPEC §14.4)', async () => {
    const players = await Promise.all(
      Array.from({ length: 1_000 }, () => Kei.start({ node, seed: randomSeed(), autoReceive: false })),
    )
    const heightBefore = (await node.accountInfo(game.address))?.height ?? 0

    const drop = await gems.commit(players.map((player) => ({ to: player.address, amount: 1 })))
    expect(drop.count).toBe(1_000)

    // One issuer block for the whole batch.
    expect((await node.accountInfo(game.address))?.height).toBe(heightBefore + 1)

    await Promise.all(players.map((player) => player.claims.add(drop.proofFor(player.address))))

    expect(await gems.supply()).toBe(1_000)
    expect((await node.accountInfo(game.address))?.height).toBe(heightBefore + 1)
    for (const player of players.slice(0, 5)) {
      expect(await gems.balanceOf(player.address)).toBe(1)
    }
    for (const player of players) player.close()
  }, 60_000)
})
