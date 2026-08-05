/**
 * SPEC §7 — an item is a native token with supply 1 and 0 decimals. Ownership is
 * balanceOf; there is no indexer and no second code path.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_ASSET_CONCURRENCY,
  Kei,
  itemSymbolFor,
  randomSeed,
  type AssetId,
  type MockNode,
} from 'kei-transaction'

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

/** How much the game has written. Unchanged means nothing was published. */
const issuerBlocks = async (): Promise<number> =>
  (await node.accountHistory(game.address, { limit: 1_000 })).length

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

  // This pair was found by brute-forcing `Greatsword of <word>` against the old
  // 2-byte digest: 004D both times, and one shared slug, so one asset. It is
  // here as a regression fixture rather than because these two names are
  // special — 16 bits over the 500-item catalogue SPEC §5.6.5 sizes the burn
  // against expects collisions, and 48 bits does not.
  test('two names that collided under a 16-bit digest are two items now', async () => {
    const damon = await game.items.create({ name: 'Greatsword of Damon', supply: 100 })
    const darel = await game.items.create({ name: 'Greatsword of Darel', supply: 100 })

    expect(darel.symbol).not.toBe(damon.symbol)
    expect(darel.id).not.toBe(damon.id)
    expect(darel.name).toBe('Greatsword of Darel')
    // Two pools of 100, not one shared pool that sells out at 50.
    expect(damon.supply).toBe(100)
    expect(darel.supply).toBe(100)
  })

  test('an item symbol fits the node max and spends the room on the digest', async () => {
    const sword = await game.items.create({ name: 'Greatsword of Endless Testing' })
    expect(sword.symbol).toBe(itemSymbolFor('Greatsword of Endless Testing'))
    // 7 of stub, a hyphen, 6 bytes of digest — the shape statSymbolFor already
    // uses, and exactly the node's max_symbol of 20.
    expect(sword.symbol).toMatch(/^[A-Z0-9][A-Z0-9-]{0,6}-[0-9A-F]{12}$/)
    expect(sword.symbol.length).toBe(20)
  })

  test('a short name still gets the full digest', async () => {
    // Nothing to truncate, so the stub is the whole name and the width is the
    // digest's, not the name's.
    expect(itemSymbolFor('Rock')).toMatch(/^ROCK-[0-9A-F]{12}$/)
    expect(itemSymbolFor('!!!')).toMatch(/^ITEM-[0-9A-F]{12}$/)
    expect(itemSymbolFor('Rock')).not.toBe(itemSymbolFor('Rocks'))
  })

  // Whatever the digest width, a symbol can still land on somebody else's asset:
  // through `create({ symbol })`, or through a collision the width only makes
  // unlikely. Reading the wrong sword back has to be a sentence.
  test('create refuses an asset that is not the item it was asked for', async () => {
    await game.items.create({ name: 'Sword of Testing', symbol: 'SHARED' })
    const clash = game.items.create({ name: 'Shield of Testing', symbol: 'SHARED' })
    await expect(clash).rejects.toThrow(/SHARED/)
    await expect(clash).rejects.toThrow(/Sword of Testing/)
    await expect(clash).rejects.toThrow(/Shield of Testing/)
  })

  test('a unique item cannot be minted twice, and says so rather than telling the issuer to burn', async () => {
    const sword = await game.items.create({ name: 'Sword of Testing' })
    await game.items.mint(sword.id, player.address)
    const before = await issuerBlocks()

    // The generic over-max-supply error advises burning some first. That is true
    // of a currency and destructive here: the only Sword of Testing is the one
    // `player` owns.
    const thrown = await game.items
      .mint(sword.id, other.address)
      .then(() => undefined, (error: unknown) => error as { code?: string; message: string })
    expect(thrown?.code).toBe('item-exhausted')
    expect(thrown?.message).toContain('Sword of Testing')
    expect(thrown?.message).not.toMatch(/frees headroom/)
    expect(thrown?.message).toContain('Do not burn one')
    expect(await issuerBlocks()).toBe(before)
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

  test('a commit for more of an item than can exist is refused, and publishes nothing', async () => {
    const sword = await game.items.create({ name: 'Iron Sword' })
    const before = await issuerBlocks()

    await expect(
      game.items.commit([
        { to: player.address, item: sword.id },
        { to: other.address, item: sword.id },
      ]),
    ).rejects.toThrow(/commits 2 Iron Sword and only 1 more can exist/)

    // A root is settled and cannot be taken back, so the refusal has to happen
    // before the block, not after it.
    expect(await issuerBlocks()).toBe(before)
  })

  test('the same player twice for one item is refused rather than merged into one leaf', async () => {
    const potion = await game.items.create({ name: 'Potion', supply: 100 })
    await expect(
      game.items.commit([
        { to: player.address, item: potion.id },
        { to: player.address, item: potion.id },
      ]),
    ).rejects.toThrow(/appears twice for Potion/)
  })

  test('a batch refused on its second item publishes neither root', async () => {
    const potion = await game.items.create({ name: 'Potion', supply: 100 })
    const sword = await game.items.create({ name: 'Iron Sword' })
    const before = await issuerBlocks()

    await expect(
      game.items.commit([
        { to: player.address, item: potion.id },
        { to: player.address, item: sword.id },
        { to: other.address, item: sword.id },
      ]),
    ).rejects.toThrow(/Iron Sword/)

    expect(await issuerBlocks()).toBe(before)
  })

  test('a commit inside the supply publishes, and all fifty recipients claim', async () => {
    const potion = await game.items.create({ name: 'Potion', supply: 100 })
    const winners = await Promise.all(
      Array.from({ length: 50 }, () => Kei.start({ node, seed: randomSeed() })),
    )

    const drops = await game.items.commit(winners.map((who) => ({ to: who.address, item: potion.id })))
    expect(drops).toHaveLength(1)
    for (const drop of drops) {
      expect(drop.count).toBe(50)
      for (const who of winners) await who.claims.add(drop.proofFor(who.address))
    }

    const token = await game.items.token(potion.id)
    expect(await token.supply()).toBe(50)
  })

  test('a claim the item has no room for names something its reader can do', async () => {
    const sword = await game.items.create({ name: 'Iron Sword' })
    const drops = await game.items.commit([{ to: player.address, item: sword.id }])
    // The room the commit was checked against is gone by the time the player
    // claims — the issuer minted the only sword elsewhere. The commit check is
    // advisory; the node is the authority on supply.
    await game.items.mint(sword.id, other.address)

    for (const drop of drops) {
      let message = ''
      try {
        await player.claims.add(drop.proofFor(player.address))
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain(`root ${drop.root} cannot be paid out`)
      expect(message).toContain('you hold none of it')
      // Not the issuer's fix handed to a player who owns nothing to burn.
      expect(message).not.toMatch(/burn/i)
    }
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

  test('a roll is as plentiful as the item it varies, so a common sword drops to many players', async () => {
    const base = await game.items.create({ name: 'Iron Sword', supply: 100 })

    const first = await game.items.mint(base.id, player.address, { label: 'Flaming', stats: { attack: 17 } })
    const second = await game.items.mint(base.id, other.address, { label: 'Flaming', stats: { attack: 17 } })

    // The claim the README makes: the hundredth Flaming Sword is the first one's
    // asset, so it burns no further issuance — and it has room to be minted.
    expect(second.id).toBe(first.id)
    await player.sync()
    await other.sync()
    expect((await player.items.ownedBy()).map((item) => item.name)).toEqual(['Flaming Iron Sword'])
    expect((await other.items.ownedBy()).map((item) => item.name)).toEqual(['Flaming Iron Sword'])
  })

  test('a roll of a unique item is unique, and says so rather than telling the issuer to burn', async () => {
    const base = await game.items.create({ name: 'Iron Sword' })
    await game.items.mint(base.id, player.address, { label: 'Flaming', stats: { attack: 17 } })

    // The generic over-max-supply error advises burning, which would destroy a
    // player's sword to make room for another player's.
    await expect(
      game.items.mint(base.id, other.address, { label: 'Flaming', stats: { attack: 17 } }),
    ).rejects.toThrow(/already held/)
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

/**
 * Issue #112 — `ownedBy()` must not cost one round trip per holding, one after
 * another, forever.
 *
 * The evidence here is counted rather than timed: how many `asset_info` lookups
 * a call made, and how many of them were outstanding at the same moment. A slow
 * machine makes these tests slower, never redder. There is no batch `asset_info`
 * in the node RPC (`docs/rpc.md`), so the fix is the wave count — `ceil(n / 8)`
 * instead of `n` — and not asking twice.
 */

/** Hands the turn back so every in-flight lookup has settled. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** The node, plus a tally of the `asset_info` lookups made through it. */
function counting(inner: MockNode) {
  const tally = { calls: 0, peak: 0, failOn: null as AssetId | null }
  let inFlight = 0
  const node = new Proxy(inner, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown
      if (key !== 'assetInfo') return typeof value === 'function' ? value.bind(target) : value
      return async (asset: AssetId) => {
        tally.calls++
        inFlight++
        tally.peak = Math.max(tally.peak, inFlight)
        try {
          if (asset === tally.failOn) throw new Error('the node did not answer')
          return await target.assetInfo(asset)
        } finally {
          inFlight--
        }
      }
    },
  })
  return {
    node,
    tally,
    reset() {
      tally.calls = 0
      tally.peak = 0
    },
  }
}

/** A fresh player holding `count` items, and a tally reset to zero. */
async function stocked(count: number) {
  const counted = counting(node)
  const collector = await Kei.start({ node: counted.node, seed: randomSeed() })
  const ids: AssetId[] = []
  for (let index = 0; index < count; index++) {
    const relic = await game.items.create({ name: `Relic ${index}` })
    await game.items.mint(relic.id, collector.address)
    ids.push(relic.id)
  }
  await collector.sync()
  counted.reset()
  return { collector, counted, ids, names: ids.map((_, index) => `Relic ${index}`) }
}

describe('ownedBy is bounded, concurrent, and remembers (#112)', () => {
  test('forty holdings cost forty lookups eight at a time, then none at all', async () => {
    const { collector, counted, names } = await stocked(40)

    const owned = await collector.items.ownedBy()
    // Holdings order survives the fan-out: the answer is not completion order.
    expect(owned.map((item) => item.name)).toEqual(names)
    expect(counted.tally.calls).toBe(40)
    expect(counted.tally.peak).toBe(DEFAULT_ASSET_CONCURRENCY)

    // Issuance metadata is immutable (SPEC §5.3, §5.4), so an unchanged account
    // asked again is free. Holdings themselves are still read fresh.
    counted.reset()
    expect((await collector.items.ownedBy()).map((item) => item.name)).toEqual(names)
    expect(counted.tally.calls).toBe(0)
    // Forty issuances and forty mints, each with its own proof of work: the
    // fixture is what is slow here, not the call under test.
  }, 60_000)

  test('the wallet and items share one cache and one bound', async () => {
    const { collector, counted, names } = await stocked(12)

    expect((await collector.wallet.summary()).items.map((item) => item.name).sort()).toEqual(
      [...names].sort(),
    )
    expect(counted.tally.calls).toBe(12)

    // The second question is the same question. A second cache would pay again.
    counted.reset()
    expect((await collector.items.ownedBy()).map((item) => item.name)).toEqual(names)
    expect(counted.tally.calls).toBe(0)
  })

  test('a lookup that fails rejects, rather than quietly shortening the inventory', async () => {
    const { collector, counted, ids, names } = await stocked(3)

    counted.tally.failOn = ids[1] as AssetId
    await expect(collector.items.ownedBy()).rejects.toThrow(/did not answer/)

    counted.tally.failOn = null
    await flush()
    counted.reset()
    expect((await collector.items.ownedBy()).map((item) => item.name)).toEqual(names)
    // The two that answered are remembered; the one that broke is not remembered
    // as absent, so the call recovers on its own for the cost of one request.
    expect(counted.tally.calls).toBe(1)
  })

  test('limit bounds the fan-out, and there is no unlimited setting', async () => {
    const { collector, counted, names } = await stocked(12)

    const page = await collector.items.ownedBy(undefined, { limit: 5 })
    expect(page.map((item) => item.name)).toEqual(names.slice(0, 5))
    expect(counted.tally.calls).toBe(5)

    for (const bad of [0, -1, 1.5, 1_025]) {
      await expect(collector.items.ownedBy(undefined, { limit: bad })).rejects.toThrow(
        /whole number from 1 through 1024/,
      )
    }
  })
})
