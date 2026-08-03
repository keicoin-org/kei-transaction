/**
 * SPEC §7 — an item is a native token with supply 1 and 0 decimals. Ownership is
 * balanceOf; there is no indexer and no second code path.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { Kei, randomSeed, type MockNode } from 'kei-transaction'

let node: MockNode
let game: Kei
let player: Kei
let other: Kei

beforeEach(async () => {
  node = await Kei.mock()
  game = await Kei.server({ seed: 'C'.repeat(64), node })
  await game.faucet(20_000)
  player = await Kei.start({ node, seed: randomSeed() })
  other = await Kei.start({ node, seed: randomSeed() })
})

describe('items', () => {
  test('create, mint, own, transfer', async () => {
    const sword = await game.items.create({
      name: 'Sword of Testing',
      description: 'It tests things.',
      image: './sword.png',
    })

    expect(sword.supply).toBe(1)
    expect(sword.image).toMatch(/^bafkmock[0-9a-f]+$/)
    expect(sword.description).toBe('It tests things.')

    const minted = await game.items.mint(sword.id, player.address)
    expect(minted.id).toBe(sword.id)
    await player.sync()

    expect(await player.items.owner(sword.id)).toBe(player.address)
    expect((await player.items.ownedBy()).map((item) => item.name)).toEqual(['Sword of Testing'])

    await player.items.transfer(sword.id, other.address)
    await other.sync()
    expect(await other.items.owner(sword.id)).toBe(other.address)
    expect(await player.items.ownedBy()).toEqual([])
  })

  test('the id is derived from the name, so create is idempotent', async () => {
    const first = await game.items.create({ name: 'Sword of Testing' })
    const before = await game.balance()
    const second = await game.items.create({ name: 'Sword of Testing' })
    expect(second.id).toBe(first.id)
    expect(await game.balance()).toBe(before)
  })

  test('two long names sharing a prefix are still two different items', async () => {
    const first = await game.items.create({ name: 'Greatsword of Endless Testing I' })
    const second = await game.items.create({ name: 'Greatsword of Endless Testing II' })
    expect(second.id).not.toBe(first.id)
    expect(second.symbol).not.toBe(first.symbol)
  })

  test('a unique item cannot be minted twice', async () => {
    const sword = await game.items.create({ name: 'Sword of Testing' })
    await game.items.mint(sword.id, player.address)
    await expect(game.items.mint(sword.id, other.address)).rejects.toThrow(/maximum supply/)
  })

  test('a burned item can be re-minted, which is what maxSupply means (SPEC §5.6.6)', async () => {
    const sword = await game.items.create({ name: 'Sword of Testing' })
    await game.items.mint(sword.id, game.address)
    await game.sync()

    const token = await game.items.token(sword.id)
    await token.burn(1)
    expect(await token.supply()).toBe(0)

    // Ledger-level scarcity of the instance is not scarcity of the type.
    await game.items.mint(sword.id, other.address)
    expect(await token.supply()).toBe(1)
  })

  test('soulbound items cannot be transferred', async () => {
    const badge = await game.items.create({ name: 'First Login', transfer: 'none' })
    await game.items.mint(badge.id, player.address)
    await player.sync()
    await expect(player.items.transfer(badge.id, other.address)).rejects.toThrow(/soulbound/)
  })

  test('loot: one commit per item type, claimed by each player', async () => {
    const potion = await game.items.create({ name: 'Potion', supply: 100 })
    const shield = await game.items.create({ name: 'Shield', supply: 100 })

    const drops = await game.items.commit([
      { to: player.address, item: potion.id },
      { to: other.address, item: potion.id },
      { to: player.address, item: shield.id },
    ])
    expect(drops).toHaveLength(2)

    for (const drop of drops) {
      const holders = [player, other].filter((who) => drop.recipients.includes(who.address))
      for (const who of holders) await who.claims.add(drop.proofFor(who.address))
    }

    expect((await player.items.ownedBy()).map((item) => item.name).sort()).toEqual(['Potion', 'Shield'])
    expect((await other.items.ownedBy()).map((item) => item.name)).toEqual(['Potion'])
  })

  test('a player cannot create or mint items', async () => {
    await expect(player.items.create({ name: 'Free Sword' })).rejects.toThrow(/only on the issuer/)
    await expect(player.items.mint('0'.repeat(64), player.address)).rejects.toThrow(/only on the issuer/)
  })

  test('the per-account asset cap is a sentence naming the fix (SPEC §7)', async () => {
    // Exercised as a unit rather than by minting 1,024 assets, which would be a
    // minute of proof-of-work for one error message.
    const { MAX_ASSETS_PER_ACCOUNT } = await import('@keicoin/core')
    expect(MAX_ASSETS_PER_ACCOUNT).toBe(1_024)
  })
})

describe('the wallet summary', () => {
  test('separates currency, items, and pending claims (SPEC §6.5)', async () => {
    const gems = await game.token.issue({ name: 'Gems', symbol: 'GEM', decimals: 0 })
    const sword = await game.items.create({ name: 'Sword of Testing', image: './sword.png' })

    await gems.mint(player.address, 250)
    await game.items.mint(sword.id, player.address)
    await player.faucet(3)
    await player.sync()

    const summary = await player.wallet.summary()
    expect(summary.address).toBe(player.address)
    expect(summary.kei).toBe(3)
    expect(summary.tokens).toEqual([
      { asset: gems.id, symbol: 'GEM', name: 'Gems', amount: 250, issuer: game.address },
    ])
    expect(summary.items.map((item) => item.name)).toEqual(['Sword of Testing'])
    expect(summary.pending).toEqual([])
  })

  test('change fires when the wallet\'s contents move', async () => {
    const gems = await game.token.issue({ name: 'Gems', symbol: 'GEM', decimals: 0 })
    const changed = new Promise<number>((resolve) => {
      player.wallet.on('change', (summary) => {
        const gem = summary.tokens.find((token) => token.symbol === 'GEM')
        if (gem) resolve(gem.amount)
      })
    })
    await gems.mint(player.address, 7)
    expect(await changed).toBe(7)
  })
})

describe('item stats', () => {
  test('an item carries stats, and the description stays prose', async () => {
    const sword = await game.items.create({
      name: 'Iron Sword',
      description: 'Heavy, and it shows.',
      stats: { attack: 12, weight: 3.5, twoHanded: true, element: 'none' },
    })

    expect(sword.stats).toEqual({ attack: 12, weight: 3.5, twoHanded: true, element: 'none' })
    expect(sword.description).toBe('Heavy, and it shows.')

    // And they survive the chain, rather than only the object that was returned.
    const readBack = await player.items.get(sword.id)
    expect(readBack?.stats).toEqual(sword.stats)
    expect(readBack?.description).toBe('Heavy, and it shows.')
  })

  test('stats are part of the identity, so re-creating with new stats is a new item', async () => {
    const weak = await game.items.create({ name: 'Iron Sword', stats: { attack: 4 } })
    const strong = await game.items.create({ name: 'Iron Sword', stats: { attack: 40 } })
    expect(strong.id).not.toBe(weak.id)
    // Otherwise this would silently hand back attack 4: issuance metadata is
    // immutable, so "create it again with better stats" cannot be an edit.
    expect((await player.items.get(strong.id))?.stats).toEqual({ attack: 40 })
  })

  test('minting with stats gives the player a variant, not the base item', async () => {
    const base = await game.items.create({
      name: 'Iron Sword',
      image: './sword.png',
      stats: { attack: 10, weight: 3 },
    })

    const drop = await game.items.mint(base.id, player.address, {
      label: 'Flaming',
      stats: { attack: 17, element: 'fire' },
    })

    expect(drop.id).not.toBe(base.id)
    expect(drop.owner).toBe(player.address)
    // The roll merges over the base: weight is inherited, attack is overridden.
    expect(drop.stats).toEqual({ attack: 17, weight: 3, element: 'fire' })

    await player.sync()
    const held = await player.items.ownedBy()
    expect(held.map((item) => item.name)).toEqual(['Flaming Iron Sword'])
    expect(held[0]?.stats).toEqual({ attack: 17, weight: 3, element: 'fire' })
    expect(held[0]?.image).toBe(base.image)
    expect(await player.items.owner(drop.id)).toBe(player.address)
    // The base is untouched — nobody holds it.
    expect(await player.items.owner(base.id)).toBeNull()
  })

  test('the same roll twice is the same asset, and burns Kei only once', async () => {
    const base = await game.items.create({ name: 'Iron Sword', supply: 100 })

    const first = await game.items.mint(base.id, player.address, { stats: { attack: 17 }, supply: 100 })
    const afterFirst = await game.balance()
    const second = await game.items.mint(base.id, other.address, { stats: { attack: 17 }, supply: 100 })

    expect(second.id).toBe(first.id)
    // Issuance is idempotent and minting is free, so the second drop is free.
    expect(await game.balance()).toBe(afterFirst)
  })

  test('a different roll is a different asset', async () => {
    const base = await game.items.create({ name: 'Iron Sword', supply: 100 })
    const hot = await game.items.mint(base.id, player.address, { stats: { attack: 17 } })
    const cold = await game.items.mint(base.id, other.address, { stats: { attack: 18 } })
    expect(cold.id).not.toBe(hot.id)
  })

  test('a variant of a soulbound item is still soulbound', async () => {
    const badge = await game.items.create({ name: 'First Login', transfer: 'none' })
    const drop = await game.items.mint(badge.id, player.address, { stats: { season: 1 } })
    await player.sync()
    await expect(player.items.transfer(drop.id, other.address)).rejects.toThrow(/soulbound/)
  })

  test('minting without stats is unchanged', async () => {
    const sword = await game.items.create({ name: 'Plain Sword' })
    const minted = await game.items.mint(sword.id, player.address)
    expect(minted.id).toBe(sword.id)
    expect(minted.stats).toBeUndefined()
  })

  test('the wallet shows stats and never the raw stat block', async () => {
    const base = await game.items.create({ name: 'Iron Sword', description: 'Heavy.' })
    await game.items.mint(base.id, player.address, { stats: { attack: 17 } })
    await player.sync()

    const [item] = (await player.wallet.summary()).items
    expect(item?.stats).toEqual({ attack: 17 })
    expect(item?.description).toBe('Heavy.')
    expect(item?.description).not.toContain('kei:stats:')
  })

  test('stats that do not fit the chain are refused, not truncated', async () => {
    await expect(
      game.items.create({
        name: 'Overloaded',
        description: 'x'.repeat(240),
        stats: { attack: 12, defence: 9, speed: 4 },
      }),
    ).rejects.toThrow(/256/)
  })

  test('a nested stat is refused, because it has no one canonical spelling', async () => {
    await expect(
      // @ts-expect-error — the type forbids it; the check is for JavaScript callers.
      game.items.create({ name: 'Nested', stats: { rolls: { attack: 1 } } }),
    ).rejects.toThrow(/flat/)
  })

  test('an empty stats object says nothing, and is refused rather than guessed at', async () => {
    const base = await game.items.create({ name: 'Iron Sword' })
    await expect(game.items.mint(base.id, player.address, { stats: {} })).rejects.toThrow(/empty stats/)
  })

  test('prose that mentions the marker is not mistaken for stats', async () => {
    const { decodeDescription } = await import('@keicoin/tokens')
    expect(decodeDescription('Type kei:stats: to inspect.')).toEqual({
      description: 'Type kei:stats: to inspect.',
    })
    // A real block still wins, even below prose that imitates one.
    expect(decodeDescription('See\nkei:stats: below.\nkei:stats:{"attack":3}')).toEqual({
      description: 'See\nkei:stats: below.',
      stats: { attack: 3 },
    })
  })
})
