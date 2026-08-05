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

  /**
   * A root that fit when it was committed and does not fit when it is claimed.
   *
   * `assertCommitHeadroom` refuses a batch that is over supply on its own, and
   * cannot do more than that: unclaimed entitlements are not circulating supply,
   * so minting between the commit and the claim is what re-opens the gap. That is
   * the only way to reach `unpayable()`, and it is not hypothetical — it is what a
   * capped currency does all day.
   */
  describe('a claim with no headroom says who can actually free some', () => {
    let capped: IssuerToken

    beforeEach(async () => {
      capped = await game.token.issue({ name: 'Coins', symbol: 'COIN', decimals: 0, maxSupply: 1_000 })
    })

    test('a claimant holding units is told to burn their own, not to wait on the issuer', async () => {
      // Both roots are committed while nothing is circulating, so both fit on
      // their own — the advisory check cannot see the other one's entitlements.
      const drop = await capped.commit([{ to: playerA.address, amount: 600 }])
      const earlier = await capped.commit([{ to: playerA.address, amount: 500 }])

      // Claiming the earlier root is a self-mint: it lands on the claimant's own
      // chain, so it is a balance rather than a receivable. Circulating supply
      // passes the point where the second root still fits, and the claimant is
      // now one of the holders — the case the message used to deny outright.
      await playerA.claims.claim(earlier.proofFor(playerA.address))
      expect(await capped.balanceOf(playerA.address)).toBe(500)

      const failure = await playerA.claims.claim(drop.proofFor(playerA.address)).catch((error: unknown) => error)
      const message = (failure as Error).message
      expect((failure as { code?: string }).code).toBe('drop-unpayable')
      // 500 + 600 - 1000 = 100 raw units of room, and this account holds 500.
      expect(message).toContain('you hold 500 Coins and burning 100 of it frees exactly the room')
      expect(message).toContain(`Burning is your own block, not the issuer's`)
      expect(message).not.toContain('you hold none of it')
    })

    test('a claimant holding none of it is pointed at the issuer', async () => {
      const drop = await capped.commit([{ to: playerA.address, amount: 600 }])
      const other = await capped.commit([{ to: playerB.address, amount: 500 }])

      // Somebody else fills the supply, so the shortfall is identical and the
      // only thing that differs is whose balance it is.
      await playerB.claims.claim(other.proofFor(playerB.address))
      expect(await capped.balanceOf(playerA.address)).toBe(0)

      const failure = await playerA.claims.claim(drop.proofFor(playerA.address)).catch((error: unknown) => error)
      const message = (failure as Error).message
      expect((failure as { code?: string }).code).toBe('drop-unpayable')
      expect(message).toContain('you hold none of it')
      expect(message).toContain('has to come from whoever issued it')
      expect(message).not.toContain('burning')
    })

    test('a balance too small to cover the shortfall says how far it goes', async () => {
      const drop = await capped.commit([{ to: playerA.address, amount: 900 }])
      const mine = await capped.commit([{ to: playerA.address, amount: 200 }])
      const theirs = await capped.commit([{ to: playerB.address, amount: 500 }])
      await playerA.claims.claim(mine.proofFor(playerA.address))
      await playerB.claims.claim(theirs.proofFor(playerB.address))

      const failure = await playerA.claims.claim(drop.proofFor(playerA.address)).catch((error: unknown) => error)
      const message = (failure as Error).message
      expect((failure as { code?: string }).code).toBe('drop-unpayable')
      // 700 + 900 - 1000 = 600 needed, and this account holds only 200 of it.
      expect(message).toContain('You hold 200 Coins')
      expect(message).toContain('frees that much of the 600 this claim needs')
      expect(message).toContain('the remainder has to come from other holders or from whoever issued it')
    })

    test('the proof is kept either way, so it claims itself once there is room', async () => {
      const held = await Kei.start({ node, seed: randomSeed(), autoClaim: false })
      const drop = await capped.commit([{ to: held.address, amount: 600 }])
      const earlier = await capped.commit([{ to: held.address, amount: 500 }])
      await held.claims.claim(earlier.proofFor(held.address))
      await held.claims.add(drop.proofFor(held.address))

      await expect(held.claims.claimAll()).rejects.toThrow(/cannot pay it/)
      expect(await held.claims.pending()).toHaveLength(1)

      // The holder frees the room themselves, exactly as the refusal said.
      const mine = await held.token.get(capped.id)
      await mine.burn(100)
      await held.claims.claimAll()
      expect(await held.claims.pending()).toHaveLength(0)
      expect(await capped.balanceOf(held.address)).toBe(1_000)
      held.close()
    })
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
  }, 180_000)
})
