/**
 * The dry run.
 *
 * `plan()` is what a game puts behind a disabled button, so it has to answer
 * "can this player do this" as data rather than as a throw, has to name who
 * signs each block (SPEC §6.3), and — the thing every test here re-checks —
 * has to write absolutely nothing while it works that out.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  Kei,
  KeiError,
  defineRecipe,
  randomSeed,
  type IssuerToken,
  type MockNode,
  type Plan,
} from 'kei-transaction'

let node: MockNode
let game: Kei
let rival: Kei
let alice: Kei
let gem: IssuerToken
let scrap: IssuerToken
let badge: IssuerToken
let bound: IssuerToken
let rivalGem: IssuerToken

beforeEach(async () => {
  node = await Kei.mock()
  game = await Kei.server({ seed: 'C'.repeat(64), node })
  rival = await Kei.server({ seed: 'D'.repeat(64), node })
  await game.faucet(20_000)
  await rival.faucet(20_000)

  alice = await Kei.start({ node, seed: randomSeed() })
  await game.send(alice.address, 50)
  await alice.sync()

  gem = await game.token.issue({ name: 'Gems', symbol: 'GEM', decimals: 0, maxSupply: 1_000 })
  scrap = await game.token.issue({ name: 'Scrap', symbol: 'SCRAP', decimals: 0 })
  badge = await game.token.issue({ name: 'Guild Badge', symbol: 'BADGE', decimals: 0, transfer: 'none' })
  bound = await game.token.issue({ name: 'Bound Coin', symbol: 'BOUND', decimals: 0, transfer: 'issuer-only' })
  rivalGem = await rival.token.issue({ name: 'Rival Gems', symbol: 'RGEM', decimals: 0 })

  await scrap.mint(alice.address, 100)
  await badge.mint(alice.address, 1)
  await alice.sync()
})

/** Nothing a plan does may reach the ledger. Checked around every plan below. */
async function withoutWriting<T>(run: () => Promise<T>): Promise<T> {
  const before = await Promise.all(
    [game.address, alice.address, rival.address].map((address) => node.accountInfo(address)),
  )
  const result = await run()
  const after = await Promise.all(
    [game.address, alice.address, rival.address].map((address) => node.accountInfo(address)),
  )
  expect(after.map((info) => info?.frontier)).toEqual(before.map((info) => info?.frontier))
  return result
}

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof KeiError) return error.code
    throw error
  }
  throw new Error('expected a KeiError, and nothing was thrown')
}

function problem(plan: Plan, code: string): string {
  const found = plan.problems.find((entry) => entry.code === code)
  if (!found) {
    throw new Error(`expected a "${code}" problem, got: ${plan.problems.map((p) => p.code).join(', ') || '(none)'}`)
  }
  return found.message
}

describe('a reward', () => {
  test('is one issuer-signed mint, and says so', async () => {
    const daily = defineRecipe({ id: 'daily', name: 'Daily Bonus', grants: [{ asset: gem, amount: 50 }] })
    const plan = await withoutWriting(() => game.economy.plan(daily, { player: alice.address }))

    expect(plan.ok).toBe(true)
    expect(plan.atomic).toBe(true)
    expect(plan.issuer).toBe(game.address)
    expect(plan.player).toBe(alice.address)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.signer).toBe('issuer')
    expect(plan.steps[0]?.signedBy).toBe(game.address)
    expect(plan.steps[0]?.action).toBe('mint')
    expect(plan.steps[0]?.to).toBe(alice.address)
    expect(plan.grants[0]).toMatchObject({ symbol: 'GEM', amount: 50, decimals: 0 })
  })

  test('cannot mint somebody else\'s token, and names who could', async () => {
    const wrong = defineRecipe({ id: 'wrong', grants: [{ asset: rivalGem, amount: 5 }] })
    const plan = await withoutWriting(() => game.economy.plan(wrong, { player: alice.address }))
    expect(plan.ok).toBe(false)
    expect(problem(plan, 'not-issuer')).toContain(rival.address)
  })

  test('sees a supply cap before it hits it, with the headroom in the sentence', async () => {
    await gem.mint(alice.address, 990)
    // Settle the arrival first: the background collector writing alice's
    // receive block mid-plan would look like the plan wrote it.
    await alice.sync()
    const big = defineRecipe({ id: 'big', grants: [{ asset: gem, amount: 50 }] })
    const plan = await withoutWriting(() => game.economy.plan(big, { player: alice.address }))
    expect(problem(plan, 'over-max-supply')).toContain('only 10')
  })

  test('paying in Kei is a send out of the issuer\'s own balance, not a mint', async () => {
    const bounty = defineRecipe({ id: 'bounty', grants: [{ asset: 'KEI', amount: 2 }] })
    const plan = await withoutWriting(() => game.economy.plan(bounty, { player: alice.address }))
    expect(plan.ok).toBe(true)
    expect(plan.steps[0]?.action).toBe('send')
    expect(plan.steps[0]?.stack.symbol).toBe('KEI')
  })

  test('a Kei reward the issuer cannot afford is a problem, not a surprise', async () => {
    const broke = await Kei.server({ seed: 'E'.repeat(64), node })
    const bounty = defineRecipe({ id: 'bounty', grants: [{ asset: 'KEI', amount: 5 }] })
    const plan = await withoutWriting(() => broke.economy.plan(bounty, { player: alice.address }))
    expect(problem(plan, 'insufficient-kei')).toContain('holds 0')
    broke.close()
  })

  test('a reward with no issuer anywhere says where an issuer comes from', async () => {
    const orphan = defineRecipe({ id: 'orphan', grants: [{ asset: { symbol: 'GEM' } }] })
    const plan = await withoutWriting(() => alice.economy.plan(orphan))
    expect(problem(plan, 'no-issuer')).toContain('defineRecipe({ issuer:')
  })

  test('planned with no player, it mints to the issuer, and says so rather than looking like a reward', async () => {
    const daily = defineRecipe({ id: 'daily', grants: [{ asset: gem, amount: 5 }] })
    const plan = await withoutWriting(() => game.economy.plan(daily))
    expect(plan.ok).toBe(true)
    expect(plan.warnings.find((w) => w.code === 'granting-to-yourself')?.message).toContain(
      "{ player: playerAddress }",
    )
  })

  test('a batch of mints from one account warns about the write lock it becomes', async () => {
    const pile = defineRecipe({
      id: 'pile',
      grants: Array.from({ length: 9 }, () => ({ asset: gem, amount: 1 })),
    })
    const plan = await withoutWriting(() => game.economy.plan(pile, { player: alice.address }))
    expect(plan.warnings.map((w) => w.code)).toContain('mint-per-player')
    expect(plan.warnings.find((w) => w.code === 'mint-per-player')?.message).toContain('token.commit()')
  })
})

describe('a sink', () => {
  test('is one player-signed burn', async () => {
    const repair = defineRecipe({ id: 'repair', costs: [{ asset: scrap, amount: 10 }] })
    const plan = await withoutWriting(() => alice.economy.plan(repair))

    expect(plan.ok).toBe(true)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.signer).toBe('player')
    expect(plan.steps[0]?.signedBy).toBe(alice.address)
    expect(plan.steps[0]?.action).toBe('burn')
    expect(plan.issuer).toBeNull()
  })

  test('states both numbers when the player is short', async () => {
    const expensive = defineRecipe({ id: 'expensive', costs: [{ asset: scrap, amount: 500 }] })
    const plan = await withoutWriting(() => alice.economy.plan(expensive))
    expect(problem(plan, 'insufficient-balance')).toContain('holds 100')
    expect(problem(plan, 'insufficient-balance')).toContain('500')
  })

  test('points at the offer holding the balance hostage, because that is the usual answer', async () => {
    await alice.market.sell({ asset: scrap, amount: 95, price: 1 })
    const expensive = defineRecipe({ id: 'expensive', costs: [{ asset: scrap, amount: 50 }] })
    const plan = await alice.economy.plan(expensive)
    expect(problem(plan, 'insufficient-balance')).toContain('locked in your own open offers')
  })

  test('cannot burn Kei, and says why nobody can', async () => {
    const toll = defineRecipe({ id: 'toll', costs: [{ asset: 'KEI', amount: 1 }] })
    const plan = await withoutWriting(() => alice.economy.plan(toll))
    expect(problem(plan, 'cannot-burn-kei')).toContain("sink: 'issuer'")
  })

  test("sink: 'issuer' moves it instead, and warns that it stays in circulation", async () => {
    const fee = defineRecipe({
      id: 'fee',
      costs: [{ asset: scrap, amount: 10 }],
      sink: 'issuer',
      issuer: game.address,
    })
    const plan = await withoutWriting(() => alice.economy.plan(fee))
    expect(plan.ok).toBe(true)
    expect(plan.steps[0]?.action).toBe('transfer')
    expect(plan.steps[0]?.to).toBe(game.address)
    expect(plan.warnings.map((w) => w.code)).toContain('issuer-holds-it')
  })

  test("sink: 'issuer' with nobody named cannot know where to send it", async () => {
    const fee = defineRecipe({ id: 'fee', costs: [{ asset: scrap.id, amount: 10 }], sink: 'issuer' })
    // Resolving by id still finds the asset's own issuer, so name a Kei cost —
    // Kei has no issuer to fall back to.
    const keiFee = defineRecipe({ id: 'kei-fee', costs: [{ asset: 'KEI', amount: 1 }], sink: 'issuer' })
    expect((await alice.economy.plan(fee)).issuer).toBe(game.address)
    expect(problem(await alice.economy.plan(keiFee), 'no-issuer')).toContain("sink: 'burn'")
  })

  test('a soulbound token can be burned but not sent, which is the whole of SPEC §5.4', async () => {
    const burnBadge = defineRecipe({ id: 'retire', costs: [{ asset: badge }] })
    expect((await alice.economy.plan(burnBadge)).ok).toBe(true)

    const sendBadge = defineRecipe({
      id: 'hand-in',
      costs: [{ asset: badge }],
      sink: 'issuer',
      issuer: game.address,
    })
    expect(problem(await alice.economy.plan(sendBadge), 'transfer-not-permitted')).toContain('soulbound')
  })

  test('two costs is two blocks, and the plan refuses to pretend otherwise', async () => {
    const both = defineRecipe({ id: 'both', costs: [{ asset: scrap, amount: 5 }, { asset: badge }] })
    const plan = await withoutWriting(() => alice.economy.plan(both))
    expect(plan.atomic).toBe(false)
    expect(plan.warnings.map((w) => w.code)).toContain('not-one-block')
  })
})

describe('requirements — a gate, not a price', () => {
  test('a held badge satisfies one, and is not spent', async () => {
    const guild = defineRecipe({
      id: 'guild-repair',
      requires: [{ asset: badge }],
      costs: [{ asset: scrap, amount: 5 }],
    })
    const plan = await withoutWriting(() => alice.economy.plan(guild))
    expect(plan.ok).toBe(true)
    expect(plan.requires[0]?.symbol).toBe('BADGE')
    // One step: the cost. The requirement moves nothing.
    expect(plan.steps).toHaveLength(1)
  })

  test('a missing one is a problem that says it is a gate', async () => {
    const bob = await Kei.start({ node, seed: randomSeed() })
    const guild = defineRecipe({ id: 'guild', requires: [{ asset: badge }], costs: [{ asset: scrap }] })
    const plan = await withoutWriting(() => bob.economy.plan(guild))
    expect(problem(plan, 'requirement-unmet')).toContain('a gate, not a price')
    bob.close()
  })

  test('on an exchange it is honest about not being enforced by consensus', async () => {
    const shop = defineRecipe({
      id: 'guild-shop',
      requires: [{ asset: badge }],
      costs: [{ asset: scrap, amount: 10 }],
      grants: [{ asset: gem, amount: 1 }],
      issuer: game.address,
    })
    const plan = await alice.economy.plan(shop)
    const warning = plan.warnings.find((w) => w.code === 'requires-not-enforced')
    expect(warning?.message).toContain('an open offer is open')
    expect(warning?.message).toContain('{ to: playerAddress }')
  })
})

describe('an exchange', () => {
  const forge = () =>
    defineRecipe({
      id: 'forge',
      costs: [{ asset: { symbol: 'SCRAP' }, amount: 30 }],
      grants: [{ asset: { symbol: 'GEM' }, amount: 1 }],
      issuer: game.address,
    })

  test('is two blocks with two different signers, and one of them settles both legs', async () => {
    const plan = await withoutWriting(() => alice.economy.plan(forge()))
    expect(plan.strategy).toBe('exchange')
    expect(plan.atomic).toBe(true)
    expect(plan.steps.map((step) => [step.signer, step.action])).toEqual([
      ['issuer', 'offer'],
      ['player', 'accept'],
    ])
    expect(plan.steps[1]?.describe).toContain('both legs or neither')
  })

  test('from the player, with an empty shelf, says who stocks it', async () => {
    const plan = await withoutWriting(() => alice.economy.plan(forge()))
    expect(problem(plan, 'no-listing')).toContain("economy.stock('forge')")
  })

  test('from the issuer, with no inventory, offers the one-flag fix', async () => {
    const plan = await withoutWriting(() => game.economy.plan(forge(), { player: alice.address }))
    expect(problem(plan, 'no-stock')).toContain('{ mint: true }')
  })

  test('an account cannot buy from itself', async () => {
    const plan = await withoutWriting(() => game.economy.plan(forge()))
    expect(problem(plan, 'self-swap')).toContain('plan({ player })')
  })

  test('the same asset on both sides moves nothing', async () => {
    const silly = defineRecipe({
      id: 'silly',
      costs: [{ asset: gem, amount: 2 }],
      grants: [{ asset: gem, amount: 1 }],
      issuer: game.address,
    })
    expect(problem(await alice.economy.plan(silly), 'same-asset')).toContain('moves nothing')
  })

  test('a soulbound reward can never be a swap leg, and the fix is a reward recipe', async () => {
    const shop = defineRecipe({
      id: 'buy-badge',
      costs: [{ asset: scrap, amount: 5 }],
      grants: [{ asset: badge }],
      issuer: game.address,
    })
    expect(problem(await alice.economy.plan(shop), 'transfer-not-permitted')).toContain('reward recipe')
  })

  test('an issuer-only asset settles when the issuer is one of the two parties', async () => {
    const shop = defineRecipe({
      id: 'buy-bound',
      costs: [{ asset: scrap, amount: 5 }],
      grants: [{ asset: bound }],
      issuer: game.address,
    })
    const plan = await alice.economy.plan(shop)
    expect(plan.problems.map((p) => p.code)).not.toContain('transfer-not-permitted')
  })

  test("an issuer-only asset somebody else issued cannot settle between these two", async () => {
    const rivalBound = await rival.token.issue({
      name: 'Rival Bound',
      symbol: 'RBOUND',
      decimals: 0,
      transfer: 'issuer-only',
    })
    await rivalBound.mint(alice.address, 5)
    await alice.sync()

    const shop = defineRecipe({
      id: 'launder',
      costs: [{ asset: rivalBound, amount: 5 }],
      grants: [{ asset: gem }],
      issuer: game.address,
    })
    expect(problem(await alice.economy.plan(shop), 'transfer-not-permitted')).toContain('issuer-only')
  })

  test('a player who cannot pay is told before an offer is ever written', async () => {
    const pricey = defineRecipe({
      id: 'pricey',
      costs: [{ asset: scrap, amount: 5_000 }],
      grants: [{ asset: gem }],
      issuer: game.address,
    })
    expect(problem(await alice.economy.plan(pricey), 'insufficient-balance')).toContain('holds 100')
  })
})

describe('resolving what a recipe names', () => {
  test('a token object, an id, and a symbol all reach the same asset', async () => {
    const byObject = await game.economy.plan(defineRecipe({ id: 'a', grants: [{ asset: gem }] }), {
      player: alice.address,
    })
    const byId = await game.economy.plan(defineRecipe({ id: 'b', grants: [{ asset: gem.id }] }), {
      player: alice.address,
    })
    const bySymbol = await game.economy.plan(
      defineRecipe({ id: 'c', grants: [{ asset: { symbol: 'GEM', issuer: game.address } }] }),
      { player: alice.address },
    )
    expect(byId.grants[0]?.asset).toBe(gem.id)
    expect(bySymbol.grants[0]?.asset).toBe(gem.id)
    expect(byObject.grants[0]?.asset).toBe(gem.id)
  })

  test('a symbol with no issuer says why a symbol alone is not an asset', async () => {
    const recipe = defineRecipe({ id: 'x', costs: [{ asset: { symbol: 'GEM' } }] })
    expect(problem(await alice.economy.plan(recipe), 'no-issuer')).toContain('two games may both call a token GEM')
  })

  test('a symbol that issuer never issued names both the symbol and the account', async () => {
    const recipe = defineRecipe({ id: 'x', costs: [{ asset: { symbol: 'NOPE', issuer: game.address } }] })
    expect(problem(await alice.economy.plan(recipe), 'no-such-asset')).toContain(game.address)
  })

  test('an id nobody issued is named in full', async () => {
    const recipe = defineRecipe({ id: 'x', costs: [{ asset: 'A'.repeat(64) }] })
    expect(problem(await alice.economy.plan(recipe), 'no-such-asset')).toContain('A'.repeat(64))
  })

  test('an amount with more decimals than the asset has is caught before it rounds', async () => {
    const recipe = defineRecipe({ id: 'x', costs: [{ asset: scrap, amount: 1.5 }] })
    expect(problem(await alice.economy.plan(recipe), 'too-precise')).toContain('0 decimal places')
  })

  test('Kei is spelled KEI or its all-zero id, and both mean the same asset', async () => {
    const bySymbol = await game.economy.plan(defineRecipe({ id: 'a', grants: [{ asset: 'KEI', amount: 1 }] }), {
      player: alice.address,
    })
    const byId = await game.economy.plan(defineRecipe({ id: 'b', grants: [{ asset: '0'.repeat(64), amount: 1 }] }), {
      player: alice.address,
    })
    expect(bySymbol.grants[0]?.asset).toBe(byId.grants[0]?.asset as string)
    expect(bySymbol.grants[0]?.decimals).toBe(18)
  })
})

describe('explain()', () => {
  test('reads as something you could paste into a bug report', async () => {
    const shop = defineRecipe({
      id: 'forge',
      name: 'Forge a Gem',
      description: 'Thirty scrap, one gem.',
      costs: [{ asset: scrap, amount: 30 }],
      grants: [{ asset: gem, amount: 1 }],
      issuer: game.address,
    })
    const text = (await alice.economy.plan(shop)).explain()

    expect(text).toContain('Recipe "forge — Forge a Gem"')
    expect(text).toContain('Thirty scrap, one gem.')
    expect(text).toContain('exchange, settled by one block')
    expect(text).toContain(`player ${alice.address}`)
    expect(text).toContain(`issuer ${game.address}`)
    expect(text).toContain('Costs (to the issuer):')
    expect(text).toContain('30 SCRAP')
    expect(text).toContain('Grants:')
    expect(text).toContain('[issuer signs] offer')
    expect(text).toContain('[player signs] accept')
    expect(text).toContain('Problems — this plan will not run:')
  })

  test('says so plainly when there is nothing wrong', async () => {
    const daily = defineRecipe({ id: 'daily', grants: [{ asset: gem, amount: 5 }] })
    expect((await game.economy.plan(daily, { player: alice.address })).explain()).toContain('No problems.')
  })

  test('names the burn for a sink, so a reader can see what leaves circulation', async () => {
    const repair = defineRecipe({ id: 'repair', costs: [{ asset: scrap, amount: 3 }] })
    expect((await alice.economy.plan(repair)).explain()).toContain('Costs (burned):')
  })
})

describe('the catalogue on a Kei instance', () => {
  test('recipes passed at start-up are there by id', async () => {
    const shop = await Kei.start({
      node,
      seed: randomSeed(),
      recipes: [{ id: 'daily', grants: [{ asset: gem.id, amount: 5 }] }],
    })
    expect(shop.economy.recipes.has('daily')).toBe(true)
    expect(shop.economy.get('daily').strategy).toBe('grant')
    shop.close()
  })

  test('an unknown id lists the ones it does know', async () => {
    alice.economy.define({ id: 'daily', grants: [{ asset: gem.id }] })
    expect(() => alice.economy.get('nope')).toThrow('It knows: daily')
  })

  test('an empty catalogue says how to fill one', async () => {
    const bare = await Kei.start({ node, seed: randomSeed() })
    expect(() => bare.economy.get('nope')).toThrow('Kei.start({ recipes:')
    bare.close()
  })

  test('planning a recipe object registers it, so run() can take the id after', async () => {
    const recipe = defineRecipe({ id: 'inline', costs: [{ asset: scrap, amount: 1 }] })
    await alice.economy.plan(recipe)
    expect(alice.economy.recipes.get('inline')).toBe(recipe)
  })

  test('an object that merely looks like a recipe is validated rather than trusted', async () => {
    // The identity above is the point of the fast path: the catalogue keeps the
    // frozen object the shared file exported, so "the server's copy and the
    // player's copy" means something. Anything else goes through defineRecipe(),
    // because a half-built recipe reaching the resolver is a TypeError deep in
    // the plan rather than a sentence at the call site.
    const handMade = Object.freeze({ id: 'hand-made', strategy: 'grant', grants: [{ asset: gem.id }] })
    const registered = alice.economy.define(handMade as never)

    expect(registered).not.toBe(handMade)
    expect(registered.requires).toEqual([])
    expect(registered.sink).toBe('burn')
    expect((await alice.economy.plan('hand-made')).strategy).toBe('grant')
  })

  test('a frozen catalogue with a hole in it is a sentence, not a TypeError', async () => {
    // The outward shape of a recipe is not enough: a catalogue that arrived as
    // JSON and was frozen on the way in has all the right fields and can still
    // carry a null where a stack belongs. Turning it down here is what sends it
    // through defineRecipe() and gets it a sentence at the call site.
    const fromJson = Object.freeze({
      id: 'from-json',
      name: 'from-json',
      strategy: 'sink',
      sink: 'burn',
      requires: [],
      costs: [null],
      grants: [],
    })
    expect(codeOf(() => alice.economy.define(fromJson as never))).toBe('bad-stack')

    const noAsset = Object.freeze({
      id: 'no-asset',
      name: 'no-asset',
      strategy: 'sink',
      sink: 'burn',
      requires: [],
      costs: [{ amount: 5 }],
      grants: [],
    })
    expect(codeOf(() => alice.economy.define(noAsset as never))).toBe('bad-asset')
  })
})

describe('a plan that cannot run says so rather than rounding up to one block', () => {
  test('no steps is not atomic, and explain() does not claim a block settles it', async () => {
    const orphan = defineRecipe({ id: 'orphan', grants: [{ asset: { symbol: 'GEM' } }] })
    const plan = await withoutWriting(() => alice.economy.plan(orphan))

    expect(plan.steps).toHaveLength(0)
    // "Settled by one block" of a plan with no block is the one lie a disabled
    // button cannot afford: `atomic` is what a UI reads to promise a player
    // nothing can go half-way.
    expect(plan.atomic).toBe(false)
    expect(plan.explain()).toContain('nothing to run — see the problems below')
    expect(problem(plan, 'no-issuer')).toContain('defineRecipe({ issuer:')
  })
})
