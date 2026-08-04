/**
 * Running recipes.
 *
 * The two things worth proving here are the two things a server ledger would
 * quietly get wrong: that nobody ever signs for anybody else (SPEC §6.3), and
 * that an exchange either moves both legs or neither (SPEC §9.2). Everything
 * else is bookkeeping around those.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  Kei,
  KeiError,
  createEconomy,
  defineRecipe,
  matchingOffers,
  randomSeed,
  termsMatch,
  type IssuerToken,
  type MarketApi,
  type MockNode,
} from 'kei-transaction'

let node: MockNode
let game: Kei
let alice: Kei
let bob: Kei
let gem: IssuerToken
let scrap: IssuerToken
let badge: IssuerToken

const forge = () =>
  defineRecipe({
    id: 'forge',
    name: 'Forge a Gem',
    costs: [{ asset: { symbol: 'SCRAP' }, amount: 30 }],
    grants: [{ asset: { symbol: 'GEM' }, amount: 1 }],
    issuer: game.address,
  })

beforeEach(async () => {
  node = await Kei.mock()
  game = await Kei.server({ seed: 'C'.repeat(64), node })
  await game.faucet(20_000)

  alice = await Kei.start({ node, seed: randomSeed() })
  bob = await Kei.start({ node, seed: randomSeed() })
  await game.send(alice.address, 50)
  await game.send(bob.address, 50)
  await Promise.all([alice.sync(), bob.sync()])

  gem = await game.token.issue({ name: 'Gems', symbol: 'GEM', decimals: 0, maxSupply: 1_000 })
  scrap = await game.token.issue({ name: 'Scrap', symbol: 'SCRAP', decimals: 0 })
  badge = await game.token.issue({ name: 'Guild Badge', symbol: 'BADGE', decimals: 0, transfer: 'none' })

  await scrap.mint(alice.address, 100)
  await scrap.mint(bob.address, 100)
  await Promise.all([alice.sync(), bob.sync()])
})

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof KeiError) return error.code
    throw error
  }
  throw new Error('expected a KeiError, and nothing was thrown')
}

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof KeiError) return error.message
    throw error
  }
  throw new Error('expected a KeiError, and nothing was thrown')
}

describe('a reward is written by the issuer and nobody else', () => {
  test('run() mints, and the player has it once it lands', async () => {
    const daily = defineRecipe({ id: 'daily', grants: [{ asset: gem, amount: 50 }] })
    const result = await game.economy.run(daily, { player: alice.address })

    expect(result.strategy).toBe('grant')
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]).toMatchObject({ action: 'mint', symbol: 'GEM', amount: 50, to: alice.address })
    expect(result.blocks[0]?.hash).toMatch(/^[0-9A-F]{64}$/)

    await alice.sync()
    expect(await gem.balanceOf(alice.address)).toBe(50)
  })

  test('a Kei reward is a real payment out of the issuer, and lands as Kei', async () => {
    const bounty = defineRecipe({ id: 'bounty', grants: [{ asset: 'KEI', amount: 2.5 }] })
    const before = await alice.balance()
    const result = await game.economy.run(bounty, { player: alice.address })

    expect(result.blocks[0]?.action).toBe('send')
    await alice.sync()
    expect(await alice.balance()).toBe(before + 2.5)
  })

  test('a browser calling it is refused, and told which half runs where', async () => {
    const daily = defineRecipe({ id: 'daily', grants: [{ asset: gem, amount: 50 }], issuer: game.address })
    const message = await messageOf(() => alice.economy.run(daily, { player: alice.address }))
    expect(message).toContain('only that account can sign for it')
    expect(message).toContain("economy.run('daily'")
    expect(message).toContain('holding your issuer seed')
  })

  test('a second issuer cannot mint the first one\'s token either', async () => {
    const rival = await Kei.server({ seed: 'D'.repeat(64), node })
    await rival.faucet(100)
    const daily = defineRecipe({ id: 'daily', grants: [{ asset: gem, amount: 5 }], issuer: game.address })
    expect(await codeOf(() => rival.economy.run(daily, { player: alice.address }))).toBe('not-issuer-context')
    rival.close()
  })

  test('several grants write several blocks, all of them reported', async () => {
    const starter = defineRecipe({
      id: 'starter',
      grants: [{ asset: gem, amount: 10 }, { asset: scrap, amount: 20 }],
    })
    const result = await game.economy.run(starter, { player: bob.address })
    expect(result.blocks.map((block) => block.symbol)).toEqual(['GEM', 'SCRAP'])
    expect(result.plan.atomic).toBe(false)

    await bob.sync()
    expect(await gem.balanceOf(bob.address)).toBe(10)
    expect(await scrap.balanceOf(bob.address)).toBe(120)
  })
})

describe('a sink is written by whoever holds the units', () => {
  test('run() burns, and the supply actually falls', async () => {
    const repair = defineRecipe({ id: 'repair', costs: [{ asset: scrap, amount: 10 }] })
    const before = await scrap.supply()

    const result = await alice.economy.run(repair)
    expect(result.blocks[0]).toMatchObject({ action: 'burn', symbol: 'SCRAP', amount: 10 })
    expect(await scrap.balanceOf(alice.address)).toBe(90)
    expect(await scrap.supply()).toBe(before - 10)
  })

  test('burning frees headroom under a cap (SPEC §5.6.6)', async () => {
    await gem.mint(alice.address, 1_000)
    await alice.sync()
    const scrapGem = defineRecipe({ id: 'scrap-gem', costs: [{ asset: gem, amount: 100 }] })
    await alice.economy.run(scrapGem)
    // Nothing was mintable a moment ago; now a hundred are.
    await expect(gem.mint(bob.address, 100)).resolves.toMatchObject({ amount: 100 })
  })

  test('a soulbound token is burnable by its holder, which is the only thing it can do', async () => {
    await badge.mint(alice.address, 1)
    await alice.sync()
    const retire = defineRecipe({ id: 'retire', costs: [{ asset: badge }] })
    await alice.economy.run(retire)
    expect(await badge.balanceOf(alice.address)).toBe(0)
  })

  test("sink: 'issuer' moves the units to the game rather than destroying them", async () => {
    const fee = defineRecipe({
      id: 'fee',
      costs: [{ asset: scrap, amount: 25 }],
      sink: 'issuer',
      issuer: game.address,
    })
    const before = await scrap.supply()
    await alice.economy.run(fee)
    await game.sync()

    expect(await scrap.balanceOf(alice.address)).toBe(75)
    expect(await scrap.balanceOf(game.address)).toBe(25)
    expect(await scrap.supply()).toBe(before)
  })

  test('the game cannot spend a player\'s balance for them, and the refusal says why not', async () => {
    const repair = defineRecipe({ id: 'repair', costs: [{ asset: scrap, amount: 10 }] })
    const message = await messageOf(() => game.economy.run(repair, { player: alice.address }))
    expect(message).toContain('a key signs only for its own account')
    expect(message).toContain('there is no charge(someoneElse, ...)')
    expect(await scrap.balanceOf(alice.address)).toBe(100)
  })

  test('a player who cannot afford it is stopped by the dry run, before any block', async () => {
    const pricey = defineRecipe({ id: 'pricey', costs: [{ asset: scrap, amount: 500 }] })
    expect(await codeOf(() => alice.economy.run(pricey))).toBe('insufficient-balance')
    expect(await scrap.balanceOf(alice.address)).toBe(100)
  })
})

describe('an exchange settles in one block, or not at all', () => {
  test('the shop stocks it, the player runs it, and both sides move together', async () => {
    const recipe = forge()
    const [offer] = await game.economy.stock(recipe, { mint: true })
    expect(offer?.give).toMatchObject({ symbol: 'GEM', amount: 1 })
    expect(offer?.want).toMatchObject({ symbol: 'SCRAP', amount: 30 })

    const result = await alice.economy.run(recipe)
    expect(result.settlement?.received).toMatchObject({ symbol: 'GEM', amount: 1 })
    expect(result.settlement?.paid).toMatchObject({ symbol: 'SCRAP', amount: 30 })

    await Promise.all([alice.sync(), game.sync()])
    expect(await gem.balanceOf(alice.address)).toBe(1)
    expect(await scrap.balanceOf(alice.address)).toBe(70)
    expect(await scrap.balanceOf(game.address)).toBe(30)
    // And the listing is gone, because it settled.
    expect(await alice.economy.listings(recipe)).toHaveLength(0)
  })

  test('the offer block is the shop, so stocking twice is two shelves', async () => {
    const recipe = forge()
    const offers = await game.economy.stock(recipe, { count: 3, mint: true })
    expect(offers).toHaveLength(3)
    expect(await alice.economy.listings(recipe)).toHaveLength(3)

    await alice.economy.run(recipe)
    await bob.economy.run(recipe)
    expect(await alice.economy.listings(recipe)).toHaveLength(1)
  })

  test('losing the race for one offer moves to the next, because a race is normal', async () => {
    const recipe = forge()
    const offers = await game.economy.stock(recipe, { count: 2, mint: true })
    // Take the one this run would otherwise have picked out from under it.
    const taken = offers[0]
    if (taken) await bob.market.accept(taken)

    const result = await alice.economy.run(recipe)
    expect(result.settlement?.offer).not.toBe(taken?.hash)
    await alice.sync()
    expect(await gem.balanceOf(alice.address)).toBe(1)
  })

  test('an empty shelf is a sentence, not a hang', async () => {
    const message = await messageOf(() => alice.economy.run(forge()))
    expect(message).toContain('has no open offer')
    expect(message).toContain("economy.stock('forge')")
  })

  test('the player checks the terms against their own copy of the recipe, not the shop\'s word', async () => {
    const recipe = forge()
    await game.economy.stock(recipe, { mint: true })

    // The same two assets, a very different price. It is a real, open, valid
    // offer on the issuer's chain — it is simply not this recipe.
    await gem.mint(game.address, 1)
    await game.sync()
    await game.market.offer({
      give: { asset: gem, amount: 1 },
      want: { asset: scrap, amount: 99 },
    })

    expect(await alice.economy.listings(recipe)).toHaveLength(1)
    const result = await alice.economy.run(recipe)
    expect(result.settlement?.paid.amount).toBe(30)
  })

  test('a shop that relists everything at a worse price simply stops matching', async () => {
    const recipe = forge()
    await gem.mint(game.address, 1)
    await game.sync()
    await game.market.offer({ give: { asset: gem, amount: 1 }, want: { asset: scrap, amount: 90 } })

    expect(await alice.economy.listings(recipe)).toHaveLength(0)
    expect(await codeOf(() => alice.economy.run(recipe))).toBe('no-listing')
    expect(await scrap.balanceOf(alice.address)).toBe(100)
  })

  test('an offer reserved for one player is the way a gate actually holds', async () => {
    const recipe = forge()
    await game.economy.stock(recipe, { mint: true, to: alice.address })

    expect(await codeOf(() => bob.economy.run(recipe))).toBe('not-the-counterparty')
    await alice.economy.run(recipe)
    await alice.sync()
    expect(await gem.balanceOf(alice.address)).toBe(1)
  })

  test('the issuer cannot buy from its own shop', async () => {
    const recipe = forge()
    await game.economy.stock(recipe, { mint: true })
    expect(await codeOf(() => game.economy.run(recipe))).toBe('self-swap')
  })

  test('an eighteen-decimal price reaches the offer block unrounded', async () => {
    // Every digit of Kei's eighteen places, which is past what a JS number
    // carries. The offer block is what the player's own copy of the recipe is
    // compared against, raw unit for raw unit — so a price rounded on the way
    // out lists a real, open, valid offer that no player can ever see.
    const precise = defineRecipe({
      id: 'precise',
      costs: [{ asset: 'KEI', amount: '0.123456789012345678' }],
      grants: [{ asset: { symbol: 'GEM' }, amount: 1 }],
      issuer: game.address,
    })
    const [listed] = await game.economy.stock(precise, { mint: true })
    expect((await node.swapOffer(listed?.hash as string))?.wantAmount).toBe('123456789012345678')

    expect(await alice.economy.listings(precise)).toHaveLength(1)
    const result = await alice.economy.run(precise)
    expect(result.settlement?.received).toMatchObject({ symbol: 'GEM', amount: 1 })
  })

  test('a copy reserved for one player does not empty the shelf for everybody else', async () => {
    const recipe = forge()
    await game.economy.stock(recipe, { mint: true })
    await game.economy.stock(recipe, { mint: true, to: alice.address })

    // Offers read newest-first, so bob meets alice's reserved copy first and the
    // ledger would refuse his accept on it (SPEC §9.2). Stepping past it is what
    // keeps one reserved sword from making the whole shelf unbuyable.
    expect((await bob.economy.plan(recipe)).ok).toBe(true)
    expect((await bob.economy.run(recipe)).settlement?.received.symbol).toBe('GEM')

    // What is left is alice's, and only hers.
    expect(await codeOf(() => bob.economy.run(recipe))).toBe('not-the-counterparty')
    await alice.economy.run(recipe)
    await alice.sync()
    expect(await gem.balanceOf(alice.address)).toBe(1)
  })

  test('a shelf reserved end to end is a plan problem, so a button can be greyed out', async () => {
    const recipe = forge()
    await game.economy.stock(recipe, { count: 2, mint: true, to: alice.address })

    const plan = await bob.economy.plan(recipe)
    expect(plan.ok).toBe(false)
    const reserved = plan.problems.find((entry) => entry.code === 'not-the-counterparty')
    expect(reserved?.message).toContain('reserved for somebody else')
    expect(reserved?.message).toContain('{ to: playerAddress }')
    expect(await scrap.balanceOf(bob.address)).toBe(100)
  })

  test('a failed accept leaves the player exactly as they were', async () => {
    const recipe = forge()
    await game.economy.stock(recipe, { mint: true })
    const poor = await Kei.start({ node, seed: randomSeed() })

    expect(await codeOf(() => poor.economy.run(recipe))).toBe('insufficient-balance')
    expect(await gem.balanceOf(poor.address)).toBe(0)
    expect(await scrap.balanceOf(poor.address)).toBe(0)
    // And the shelf is untouched, so somebody who can pay still can.
    expect(await alice.economy.listings(recipe)).toHaveLength(1)
    poor.close()
  })
})

describe('stocking the shelf', () => {
  test('refuses without inventory, and the fix is one flag', async () => {
    const message = await messageOf(() => game.economy.stock(forge()))
    expect(message).toContain('holds 0 GEM')
    expect(message).toContain('{ mint: true }')
  })

  test('{ mint: true } mints exactly the shortfall and no more', async () => {
    await gem.mint(game.address, 1)
    await game.sync()
    await game.economy.stock(forge(), { count: 3, mint: true })
    // One held plus two minted, all three now locked in offers.
    expect(await gem.supply()).toBe(3)
    expect(await gem.balanceOf(game.address)).toBe(0)
  })

  test('a browser cannot stock a shop, because it cannot lock the issuer\'s goods', async () => {
    const message = await messageOf(() => alice.economy.stock(forge()))
    expect(message).toContain('Kei.server()')
    expect(message).toContain("economy.run('forge')")
  })

  test('an issuer cannot stock somebody else\'s recipe', async () => {
    const rival = await Kei.server({ seed: 'D'.repeat(64), node })
    await rival.faucet(100)
    expect(await codeOf(() => rival.economy.stock(forge(), { mint: true }))).toBe('wrong-issuer')
    rival.close()
  })

  test('{ mint: true } still cannot mint what this account does not issue', async () => {
    const rival = await Kei.server({ seed: 'D'.repeat(64), node })
    await rival.faucet(100)
    const rivalShop = defineRecipe({
      id: 'rival-shop',
      costs: [{ asset: scrap, amount: 5 }],
      grants: [{ asset: gem }],
      issuer: rival.address,
    })
    expect(await codeOf(() => rival.economy.stock(rivalShop, { mint: true }))).toBe('not-issuer')
    rival.close()
  })

  test('a shop that pays out Kei is funded, not minted, and says so', async () => {
    // A buyback — the game buys scrap back for Kei — locks Kei rather than
    // stock, and nobody issues Kei: the supply is fixed at genesis (SPEC §5.7).
    // "Mint the shortfall" is the one fix that cannot work here.
    const broke = await Kei.server({ seed: 'E'.repeat(64), node })
    const buyback = defineRecipe({
      id: 'buyback',
      costs: [{ asset: scrap, amount: 10 }],
      grants: [{ asset: 'KEI', amount: 5 }],
      issuer: broke.address,
    })

    const plan = await broke.economy.plan(buyback, { player: alice.address })
    expect(plan.ok).toBe(false)
    const shortfall = plan.problems.find((entry) => entry.code === 'insufficient-kei')
    expect(shortfall?.message).toContain('fixed at genesis')
    expect(shortfall?.message).toContain('faucet()')

    for (const options of [{}, { mint: true }]) {
      const message = await messageOf(() => broke.economy.stock(buyback, options))
      expect(message).toContain('Nobody issues Kei')
      expect(message).toContain('faucet()')
      expect(message).not.toContain('issued by null')
    }
    expect(await codeOf(() => broke.economy.stock(buyback, { mint: true }))).toBe('insufficient-kei')

    // Funded, it stocks and settles like any other exchange.
    await game.send(broke.address, 10)
    await broke.sync()
    const [offer] = await broke.economy.stock(buyback)
    expect(offer?.give).toMatchObject({ symbol: 'KEI', amount: 5 })

    const before = await alice.balance()
    await alice.economy.run(buyback)
    await alice.sync()
    expect(await alice.balance()).toBe(before + 5)
    expect(await scrap.balanceOf(alice.address)).toBe(90)
    broke.close()
  })

  test('a reward or a sink has no shelf, and stock() says which call it wants', async () => {
    const daily = defineRecipe({ id: 'daily', grants: [{ asset: gem, amount: 5 }] })
    const repair = defineRecipe({ id: 'repair', costs: [{ asset: scrap, amount: 5 }] })
    expect(await messageOf(() => game.economy.stock(daily))).toContain("economy.run('daily', { player })")
    expect(await messageOf(() => game.economy.stock(repair))).toContain("economy.run('repair')")
    expect(await codeOf(() => game.economy.listings(daily))).toBe('not-an-exchange')
  })

  test('count is a whole number of copies', async () => {
    expect(await codeOf(() => game.economy.stock(forge(), { count: 0 }))).toBe('bad-count')
    expect(await codeOf(() => game.economy.stock(forge(), { count: 1.5 }))).toBe('bad-count')
  })

  test('an expiry rides along, and the offer carries it', async () => {
    const timed = defineRecipe({
      id: 'flash-sale',
      costs: [{ asset: scrap, amount: 5 }],
      grants: [{ asset: gem }],
      issuer: game.address,
      expiresIn: '1h',
    })
    const [offer] = await game.economy.stock(timed, { mint: true })
    expect(offer?.expiresAt).toBeGreaterThan(Date.now())
    expect(offer?.expired).toBe(false)
  })

  test('listings need to know whose chain to read, because that is where offers live', async () => {
    const anonymous = defineRecipe({
      id: 'anon',
      costs: [{ asset: scrap.id, amount: 5 }],
      grants: [{ asset: gem.id }],
    })
    const message = await messageOf(() => alice.economy.listings(anonymous))
    expect(message).toContain('reads one account\'s chain')
    expect(message).toContain('{ issuer: gameAddress }')
    // Told whose, it reads it.
    expect(await alice.economy.listings(anonymous, { issuer: game.address })).toEqual([])
  })
})

describe('matching an offer to a recipe, on its own', () => {
  /** A plan's resolved legs are exactly the terms an offer has to restate. */
  async function termsOf(recipe: ReturnType<typeof forge>) {
    const plan = await alice.economy.plan(recipe)
    return {
      context: { client: alice.client, market: alice.market },
      terms: {
        issuer: plan.issuer as string,
        cost: plan.costs[0] as NonNullable<(typeof plan.costs)[number]>,
        grant: plan.grants[0] as NonNullable<(typeof plan.grants)[number]>,
      },
    }
  }

  test('matchingOffers and termsMatch are usable directly, and compare raw amounts', async () => {
    const recipe = forge()
    const [listed] = await game.economy.stock(recipe, { mint: true })
    const { context, terms } = await termsOf(recipe)

    expect((await matchingOffers(context, terms)).map((offer) => offer.hash)).toEqual([
      listed?.hash as string,
    ])
    expect(await termsMatch(context, listed?.hash as string, terms)).toBe(true)

    // One unit out on either leg, and it is a different recipe.
    const dearer = { ...terms, cost: { ...terms.cost, raw: terms.cost.raw + 1n } }
    const meaner = { ...terms, grant: { ...terms.grant, raw: terms.grant.raw + 1n } }
    expect(await termsMatch(context, listed?.hash as string, dearer)).toBe(false)
    expect(await termsMatch(context, listed?.hash as string, meaner)).toBe(false)
    expect(await matchingOffers(context, dearer)).toEqual([])
  })

  test('a settled offer stops matching, so nothing tries to accept it twice', async () => {
    const recipe = forge()
    const [listed] = await game.economy.stock(recipe, { mint: true })
    const { context, terms } = await termsOf(recipe)
    expect(await termsMatch(context, listed?.hash as string, terms)).toBe(true)

    await bob.economy.run(recipe)
    expect(await termsMatch(context, listed?.hash as string, terms)).toBe(false)
    expect(await matchingOffers(context, terms)).toEqual([])
  })

  test('an offer that never existed matches nothing rather than throwing', async () => {
    const { context, terms } = await termsOf(forge())
    expect(await termsMatch(context, 'A'.repeat(64), terms)).toBe(false)
  })
})

describe('the dry run is a check, not a gate on the ledger', () => {
  test('run() reports the first problem and how many more there are', async () => {
    const bad = defineRecipe({
      id: 'bad',
      costs: [{ asset: scrap, amount: 5_000 }, { asset: gem, amount: 5_000 }],
    })
    const message = await messageOf(() => alice.economy.run(bad))
    expect(message).toContain('Not enough SCRAP')
    expect(message).toContain('1 more problem')
    expect(message).toContain('plan.explain()')
  })

  test('force: true skips the dry run, and the ledger refuses for the same reason', async () => {
    const pricey = defineRecipe({ id: 'pricey', costs: [{ asset: scrap, amount: 500 }] })
    expect(await codeOf(() => alice.economy.run(pricey))).toBe('insufficient-balance')
    expect(await codeOf(() => alice.economy.run(pricey, { force: true }))).toBe('insufficient-balance')
    expect(await scrap.balanceOf(alice.address)).toBe(100)
  })

  test('a plan can be handed back to run(), and is rebuilt rather than replayed', async () => {
    const repair = defineRecipe({ id: 'repair', costs: [{ asset: scrap, amount: 10 }] })
    const plan = await alice.economy.plan(repair)
    expect(plan.ok).toBe(true)

    // The chain moves between the plan and the run: everything is spent.
    const drain = defineRecipe({ id: 'drain', costs: [{ asset: scrap, amount: 100 }] })
    await alice.economy.run(drain)

    expect(await codeOf(() => alice.economy.run(plan))).toBe('insufficient-balance')
  })

  test('a run that stops halfway names the blocks that already stood', async () => {
    // Two grants is two blocks, and one account keeps one chain with one block
    // per operation (SPEC §5.6.1) — there is nothing to group them into. The
    // plan warns about that up front as `not-one-block`; the failure has to say
    // which half landed, because nothing can take it back.
    const capped = await game.token.issue({ name: 'Capped', symbol: 'CAP', decimals: 0, maxSupply: 5 })
    await capped.mint(game.address, 4)
    const starter = defineRecipe({
      id: 'starter-pack',
      grants: [{ asset: gem, amount: 10 }, { asset: capped, amount: 3 }],
    })

    let thrown: KeiError | undefined
    try {
      await game.economy.run(starter, { player: alice.address, force: true })
    } catch (error) {
      thrown = error as KeiError
    }
    // The reason did not change, so neither does the code.
    expect(thrown?.code).toBe('over-max-supply')
    expect(thrown?.message).toContain('stopped after 1 of its blocks had already settled')
    expect(thrown?.message).toContain('mint 10 GEM')
    expect(thrown?.message).toMatch(/[0-9A-F]{64}/)
    expect(thrown?.message).toContain('maximum supply of 5')

    await alice.sync()
    expect(await gem.balanceOf(alice.address)).toBe(10)
  })

  test('stocking that stops halfway names the copies already on the shelf', async () => {
    // The only way one copy fails after an earlier one succeeded is the node
    // refusing partway through, so the market is stubbed to do exactly that.
    // Each copy is its own offer block: the ones already published are open and
    // holding stock locked, and counting them is the difference between
    // restocking a shelf and double-stocking it.
    let published = 0
    const flaky: MarketApi = {
      ...game.market,
      offer: (options) => {
        if (published++ === 2) throw new KeiError('node-unreachable', 'The node stopped answering.')
        return game.market.offer(options)
      },
    }
    await gem.mint(game.address, 4)
    await game.sync()
    const economy = createEconomy(game.client, { market: flaky })

    const message = await messageOf(() => economy.stock(forge(), { count: 4 }))
    expect(message).toContain('published 2 of 4 copies before it stopped')
    expect(message).toContain('Already on the shelf:')
    expect(message).toContain('The node stopped answering.')
    // Two blocks, two swords locked, and both still buyable by somebody.
    expect(await alice.economy.listings(forge())).toHaveLength(2)
  })

  test('run() returns the plan it checked, warnings included', async () => {
    const fee = defineRecipe({
      id: 'fee',
      costs: [{ asset: scrap, amount: 5 }],
      sink: 'issuer',
      issuer: game.address,
    })
    const result = await alice.economy.run(fee)
    expect(result.plan.warnings.map((w) => w.code)).toContain('issuer-holds-it')
    expect(result.plan.explain()).toContain('Worth knowing:')
  })
})
