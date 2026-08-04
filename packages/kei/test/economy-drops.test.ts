/**
 * Drop tables (SPEC §5.5).
 *
 * Two halves, tested apart because they fail apart. `defineDropTable()` reads no
 * chain, so everything it can catch it catches at import. `economy.drop()` reads
 * one, writes one block per asset however big the party is, and the players
 * write the rest themselves.
 *
 * The tests worth reading twice are the last group: they are the ones that say
 * what a player can actually check, and — just as important — what they cannot.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  Kei,
  KeiError,
  buildCommit,
  checkDropBinding,
  defineDropTable,
  isDropTable,
  randomSeed,
  rollDropTable,
  type DropAward,
  type DropTable,
  type MockNode,
} from 'kei-transaction'

const GAME = 'kei_3t8myo6xnh84mqegoxp383b7mmdgbt6aqwmbfz6y6tfj45by5q6gsi6mgiu3'

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof KeiError) return error.code
    throw error
  }
  throw new Error('expected a KeiError, and nothing was thrown')
}

async function asyncCodeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof KeiError) return error.code
    throw error
  }
  throw new Error('expected a KeiError, and nothing was thrown')
}

/** Deal these values out of the "random" source, one per roll. */
function dealing(values: readonly number[]): () => number {
  let index = 0
  return () => values[index++] as number
}

describe('a table is a declaration, and hashes to one thing', () => {
  test('two identical declarations agree, and a changed weight does not', () => {
    const spec = {
      id: 'hoard',
      drops: [
        { asset: { symbol: 'GOLD', issuer: GAME }, amount: 50, weight: 60 },
        { asset: { symbol: 'SWORD', issuer: GAME }, weight: 1 },
      ],
      nothing: 39,
    } as const

    expect(defineDropTable(spec).digest).toBe(defineDropTable(spec).digest)
    expect(defineDropTable({ ...spec, nothing: 38 }).digest).not.toBe(defineDropTable(spec).digest)
    expect(
      defineDropTable({ ...spec, drops: [{ ...spec.drops[0], weight: 61 }, spec.drops[1]] }).digest,
    ).not.toBe(defineDropTable(spec).digest)
  })

  test('one spelling per amount, so two honest copies cannot disagree', () => {
    const of = (amount: number | string): string =>
      defineDropTable({ id: 'hoard', drops: [{ asset: 'GOLD', amount }] }).digest

    expect(of('0.50')).toBe(of(0.5))
    expect(of('.5')).toBe(of(0.5))
    expect(of('+0.5000')).toBe(of(0.5))
    expect(of('007')).toBe(of(7))
    expect(of(0.5)).not.toBe(of(5))
  })

  test('the name is not hashed, because it is not a promise about payouts', () => {
    const drops = [{ asset: 'GOLD', amount: 1 }]
    expect(defineDropTable({ id: 'hoard', name: 'Hoard', drops }).digest).toBe(
      defineDropTable({ id: 'hoard', name: 'Pile', drops }).digest,
    )
  })

  test('odds are published, and include the miss rate', () => {
    const table = defineDropTable({
      id: 'hoard',
      drops: [
        { asset: 'GOLD', amount: 50, weight: 60 },
        { asset: 'SWORD', weight: 10 },
      ],
      nothing: 30,
    })
    expect(table.odds.map((entry) => entry.chance)).toEqual([0.6, 0.1, 0.3])
    expect(table.odds[2]?.drop).toBeNull()
    expect(table.odds.reduce((sum, entry) => sum + entry.chance, 0)).toBeCloseTo(1, 12)
  })

  test('a table with no rows, or no weight anywhere, could never pay out', () => {
    expect(codeOf(() => defineDropTable({ id: 'hoard', drops: [] }))).toBe('empty-drop-table')
    expect(
      codeOf(() => defineDropTable({ id: 'hoard', drops: [{ asset: 'GOLD', weight: 0 }] })),
    ).toBe('no-weight')
  })

  test('weights are whole and not negative; amounts are positive', () => {
    expect(codeOf(() => defineDropTable({ id: 'h', drops: [{ asset: 'G', weight: 1.5 }] }))).toBe('bad-weight')
    expect(codeOf(() => defineDropTable({ id: 'h', drops: [{ asset: 'G', weight: -1 }] }))).toBe('bad-weight')
    expect(codeOf(() => defineDropTable({ id: 'h', drops: [{ asset: 'G', amount: 0 }] }))).toBe('bad-amount')
    expect(codeOf(() => defineDropTable({ id: 'h', drops: [{ asset: '' }] }))).toBe('bad-asset')
  })

  test('an exponent is refused rather than mangled into a ledger amount', () => {
    const thrown = codeOf(() => defineDropTable({ id: 'h', drops: [{ asset: 'G', amount: 1e-7 }] }))
    expect(thrown).toBe('bad-amount')
  })

  test('isDropTable recomputes the digest rather than believing the field', () => {
    const table = defineDropTable({ id: 'hoard', drops: [{ asset: 'GOLD', weight: 1 }] })
    expect(isDropTable(table)).toBe(true)
    // The shape of a table, carrying a digest it does not hash to.
    const forged = Object.freeze({ ...table, drops: Object.freeze([{ asset: 'CROWN', amount: '1', weight: 1 }]) })
    expect(isDropTable(forged as DropTable)).toBe(false)
  })
})

describe('the roll', () => {
  const table = defineDropTable({
    id: 'hoard',
    drops: [
      { asset: 'GOLD', amount: 50, weight: 60 },
      { asset: 'SWORD', weight: 10 },
    ],
    nothing: 30,
  })

  test('weights partition [0, 1) in declaration order, with the miss last', () => {
    expect(rollDropTable(table, () => 0)?.asset).toBe('GOLD')
    expect(rollDropTable(table, () => 0.599)?.asset).toBe('GOLD')
    expect(rollDropTable(table, () => 0.6)?.asset).toBe('SWORD')
    expect(rollDropTable(table, () => 0.699)?.asset).toBe('SWORD')
    expect(rollDropTable(table, () => 0.7)).toBeNull()
    expect(rollDropTable(table, () => 0.999)).toBeNull()
  })

  test('a source outside [0, 1) is a sentence, not a silently wrong drop', () => {
    expect(codeOf(() => rollDropTable(table, () => 1))).toBe('bad-random')
    expect(codeOf(() => rollDropTable(table, () => -0.1))).toBe('bad-random')
  })
})

describe('publishing a batch', () => {
  let node: MockNode
  let game: Kei
  let alice: Kei
  let bob: Kei
  let hoard: DropTable

  beforeEach(async () => {
    node = await Kei.mock()
    game = await Kei.server({ seed: 'C'.repeat(64), node })
    await game.faucet(20_000)
    alice = await Kei.start({ node, seed: randomSeed() })
    bob = await Kei.start({ node, seed: randomSeed() })

    await game.token.issue({ name: 'Gold', symbol: 'GOLD', decimals: 0, transfer: 'open' })
    const sword = await game.items.create({ name: 'Sword of Testing', supply: 100 })

    hoard = defineDropTable({
      id: 'dragon-hoard',
      drops: [
        { asset: { symbol: 'GOLD' }, amount: 50, weight: 60 },
        { asset: { id: sword.id }, weight: 10 },
      ],
      nothing: 30,
      issuer: game.address,
    })
  })

  test('one block per asset, however many players rolled it', async () => {
    const carol = await Kei.start({ node, seed: randomSeed() })
    const drop = await game.economy.drop(hoard, [alice.address, bob.address, carol.address], {
      // gold, gold, miss
      random: dealing([0.1, 0.2, 0.9]),
    })

    expect(drop.roots).toHaveLength(1)
    expect(drop.roots[0]?.symbol).toBe('GOLD')
    expect(drop.roots[0]?.count).toBe(2)
    expect(drop.awarded).toBe(2)
    expect(drop.awardFor(carol.address)).toBeNull()

    for (const who of [alice, bob]) {
      const award = drop.awardFor(who.address) as DropAward
      expect(award.symbol).toBe('GOLD')
      expect(award.quantity).toBe(50)
      await who.claims.add(award)
    }

    const gold = await alice.token('GOLD', game.address)
    expect(await gold.balanceOf(alice.address)).toBe(50)
    expect(await gold.balanceOf(bob.address)).toBe(50)
    expect(await gold.balanceOf(carol.address)).toBe(0)
  })

  test('two assets in one party is two roots, and each player claims their own', async () => {
    const drop = await game.economy.drop(hoard, [alice.address, bob.address], {
      random: dealing([0.1, 0.65]), // gold, sword
    })
    expect(drop.roots).toHaveLength(2)

    await alice.claims.add(drop.awardFor(alice.address) as DropAward)
    await bob.claims.add(drop.awardFor(bob.address) as DropAward)

    expect((await bob.items.ownedBy()).map((item) => item.name)).toEqual(['Sword of Testing'])
    expect(await (await alice.token('GOLD', game.address)).balance()).toBe(50)
  })

  test('a second claim from the same account against one root is refused by the ledger', async () => {
    const drop = await game.economy.drop(hoard, [alice.address], { random: () => 0.1 })
    const award = drop.awardFor(alice.address) as DropAward
    await alice.claims.add(award)
    expect(await asyncCodeOf(() => alice.claims.claim(award))).toBe('already-claimed')
  })

  test('one roll per address, because a root holds one leaf per account', async () => {
    expect(
      await asyncCodeOf(() => game.economy.drop(hoard, [alice.address, alice.address])),
    ).toBe('duplicate-player')
    expect(await asyncCodeOf(() => game.economy.drop(hoard, []))).toBe('no-players')
  })

  test('a browser cannot publish a batch, and is told which half can', async () => {
    expect(await asyncCodeOf(() => alice.economy.drop(hoard, [bob.address]))).toBe('not-issuer-context')
  })

  test('an unissued asset is a sentence at publish time, not a broken proof later', async () => {
    const ghost = defineDropTable({
      id: 'ghost',
      drops: [{ asset: { symbol: 'NOSUCHTHING' } }],
      issuer: game.address,
    })
    expect(await asyncCodeOf(() => game.economy.drop(ghost, [alice.address]))).toBe('no-such-asset')
  })

  test('a batch the supply cannot honour is refused whole, not one player at a time', async () => {
    const crown = await game.token.issue({ name: 'Crown', symbol: 'CROWN', decimals: 0, maxSupply: 1 })
    const crowns = defineDropTable({
      id: 'crowns',
      drops: [{ asset: { symbol: 'CROWN' } }],
      issuer: game.address,
    })
    const carol = await Kei.start({ node, seed: randomSeed() })
    const thrown = await asyncCodeOf(() =>
      game.economy.drop(crowns, [alice.address, bob.address, carol.address]),
    )
    expect(thrown).toBe('no-headroom')
    // Nothing was published, so nobody holds a proof against a root that would
    // have paid out two of them and refused the third.
    expect(await crown.supply()).toBe(0)
  })

  test('closing a root refuses while somebody still has loot in it', async () => {
    const drop = await game.economy.drop(hoard, [alice.address, bob.address], {
      random: dealing([0.1, 0.2]),
    })
    expect(await asyncCodeOf(() => drop.close())).toBe('unclaimed-drop')

    await alice.claims.add(drop.awardFor(alice.address) as DropAward)
    await bob.claims.add(drop.awardFor(bob.address) as DropAward)

    const closed = await drop.close()
    expect(closed.closed).toEqual(drop.roots.map((root) => root.root))
    expect(closed.unclaimed).toEqual([])
    expect((await node.commitInfo(drop.roots[0]?.root as string))?.closed).toBe(true)
  })

  test('a forced close is the issuer taking unclaimed loot back, and says so', async () => {
    const drop = await game.economy.drop(hoard, [alice.address], { random: () => 0.1 })
    const closed = await drop.close({ force: true })
    expect(closed.unclaimed).toEqual([alice.address])
    expect(await asyncCodeOf(() => alice.claims.claim(drop.awardFor(alice.address) as DropAward))).toBe(
      'root-closed',
    )
  })
})

describe('what a player can check before claiming', () => {
  let node: MockNode
  let game: Kei
  let alice: Kei
  let bob: Kei
  let hoard: DropTable

  beforeEach(async () => {
    node = await Kei.mock()
    game = await Kei.server({ seed: 'C'.repeat(64), node })
    await game.faucet(20_000)
    await game.token.issue({ name: 'Gold', symbol: 'GOLD', decimals: 0, transfer: 'open' })

    hoard = defineDropTable({
      id: 'dragon-hoard',
      drops: [{ asset: { symbol: 'GOLD' }, amount: 50, weight: 60 }],
      nothing: 40,
      issuer: game.address,
    })
    // Both halves register the same table, from the same shared file.
    alice = await Kei.start({ node, seed: randomSeed(), tables: [hoard] })
    bob = await Kei.start({ node, seed: randomSeed(), tables: [hoard] })
  })

  test('a real award verifies, and reports the odds it was drawn against', async () => {
    const drop = await game.economy.drop(hoard, [alice.address], { random: () => 0.1 })
    const award = drop.awardFor(alice.address) as DropAward

    const verified = await alice.economy.verifyDrop(award)
    expect(verified.symbol).toBe('GOLD')
    expect(verified.quantity).toBe(50)
    expect(verified.chance).toBe(0.6)
    expect(verified.table.id).toBe('dragon-hoard')
  })

  test('a table edited after the batch no longer matches the root it was published for', async () => {
    const drop = await game.economy.drop(hoard, [alice.address], { random: () => 0.1 })
    const award = drop.awardFor(alice.address) as DropAward

    const sweetened = defineDropTable({
      id: 'dragon-hoard',
      drops: [{ asset: { symbol: 'GOLD' }, amount: 50, weight: 99 }],
      nothing: 1,
      issuer: game.address,
    })
    expect(await asyncCodeOf(() => alice.economy.verifyDrop(award, sweetened))).toBe('table-changed')
  })

  test('a root not published for this table is caught before anything is claimed', async () => {
    // An ordinary commit: a real root, a real proof, and a salt that has nothing
    // to do with any table.
    const gold = await game.token.get('GOLD', game.address)
    const published = await (await game.items.token(gold.id)).commit([{ to: alice.address, amount: 50 }])

    const dressed: DropAward = {
      ...published.proofFor(alice.address),
      table: hoard.id,
      digest: hoard.digest,
      nonce: 'A'.repeat(64),
      saltProof: published.saltProof,
      symbol: 'GOLD',
      itemName: 'Gold',
      quantity: 50,
    }
    expect(await asyncCodeOf(() => alice.economy.verifyDrop(dressed))).toBe('unbound-drop')
  })

  test('an award is bound to the account it was drawn for', async () => {
    const drop = await game.economy.drop(hoard, [alice.address], { random: () => 0.1 })
    const award = drop.awardFor(alice.address) as DropAward
    expect(await asyncCodeOf(() => bob.economy.verifyDrop(award))).toBe('not-in-drop')
  })

  test('a root nobody published is a sentence, not a claim that fails later', async () => {
    const drop = await game.economy.drop(hoard, [alice.address], { random: () => 0.1 })
    const award = { ...(drop.awardFor(alice.address) as DropAward), root: 'B'.repeat(64) }
    expect(await asyncCodeOf(() => alice.economy.verifyDrop(award))).toBe('no-such-root')
  })

  test('an amount the table never listed is caught even inside a bound root', async () => {
    // The game publishes a batch bound to the table and pays out 500 rather than
    // the 50 the table declares. Both proofs fold to the root; the table does not
    // agree with either of them.
    const gold = await game.token.get('GOLD', game.address)
    const { dropSalt, dropNonce } = await import('@keicoin/economy')
    const nonce = dropNonce()
    const built = buildCommit({
      asset: gold.id,
      decimals: 0,
      entries: [{ to: alice.address, amount: 500 }],
      salt: dropSalt(hoard.digest, nonce),
    })
    await game.client.submitAsset({
      kind: 'commit',
      root: built.root,
      asset: gold.id,
      count: built.count,
      total: built.total,
    })

    const overpaid: DropAward = {
      ...built.proofFor(alice.address),
      table: hoard.id,
      digest: hoard.digest,
      nonce,
      saltProof: built.saltProof,
      symbol: 'GOLD',
      itemName: 'Gold',
      quantity: 500,
    }
    expect(await asyncCodeOf(() => alice.economy.verifyDrop(overpaid))).toBe('undeclared-drop')
  })

  test('a closed batch is refused with the reason, rather than as a bad proof', async () => {
    const drop = await game.economy.drop(hoard, [alice.address], { random: () => 0.1 })
    const award = drop.awardFor(alice.address) as DropAward
    await drop.close({ force: true })
    expect(await asyncCodeOf(() => alice.economy.verifyDrop(award))).toBe('root-closed')
  })

  test('a malformed award is a sentence, not a TypeError out of BigInt', async () => {
    const drop = await game.economy.drop(hoard, [alice.address], { random: () => 0.1 })
    const award = drop.awardFor(alice.address) as DropAward
    for (const broken of [
      { ...award, amount: 'fifty' },
      { ...award, proof: 'not-an-array' as unknown as string[] },
      { ...award, asset: 'GOLD' },
    ]) {
      expect(await asyncCodeOf(() => alice.economy.verifyDrop(broken))).toBe('bad-award')
    }
  })

  test('an unregistered table is named, rather than producing a null somewhere later', async () => {
    const stranger = await Kei.start({ node, seed: randomSeed() })
    const drop = await game.economy.drop(hoard, [alice.address], { random: () => 0.1 })
    expect(
      await asyncCodeOf(() => stranger.economy.verifyDrop(drop.awardFor(alice.address) as DropAward)),
    ).toBe('no-such-drop-table')
  })

  /**
   * The batch below is honestly built and every proof in it folds. What makes it
   * worthless is the one thing proofs cannot say: which account's GOLD it pays.
   * A table that does not name its issuer leaves that to whoever published the
   * root, and the attacker is exactly the party who published it.
   */
  test('a table that names no issuer cannot be verified against a symbol, however well its proofs fold', async () => {
    const attacker = await Kei.server({ seed: 'D'.repeat(64), node })
    await attacker.faucet(20_000)
    await attacker.token.issue({ name: 'Gold', symbol: 'GOLD', decimals: 0, transfer: 'open' })

    const unanchored = defineDropTable({
      id: 'unanchored-hoard',
      drops: [{ asset: { symbol: 'GOLD' }, amount: 50, weight: 60 }],
      nothing: 40,
    })
    // Published by the attacker, from the attacker's own lookalike GOLD.
    const drop = await attacker.economy.drop(unanchored, [alice.address], { random: () => 0.1 })
    const award = drop.awardFor(alice.address) as DropAward

    // The binding itself is intact — this is not a forged proof.
    expect(() => checkDropBinding(award, unanchored, alice.address)).not.toThrow()
    expect(await asyncCodeOf(() => alice.economy.verifyDrop(award, unanchored))).toBe(
      'unanchored-table',
    )
  })

  test('naming the assets by id needs no issuer, because an id already is one', async () => {
    const gold = await game.token('GOLD', game.address)
    const byId = defineDropTable({
      id: 'hoard-by-id',
      drops: [{ asset: { id: gold.id }, amount: 50, weight: 60 }],
      nothing: 40,
    })
    const drop = await game.economy.drop(byId, [alice.address], { random: () => 0.1 })
    const verified = await alice.economy.verifyDrop(drop.awardFor(alice.address) as DropAward, byId)
    expect(verified.symbol).toBe('GOLD')
    expect(verified.quantity).toBe(50)
  })
})
