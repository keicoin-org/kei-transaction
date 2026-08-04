/**
 * Running a recipe.
 *
 * Everything here writes blocks from exactly one account — this one. There is
 * no step where the SDK signs for somebody else, no balance held anywhere but
 * the ledger, and no place a "pending" anything is stored. When a recipe needs
 * two signatures, `run()` writes the half it can sign and the error names the
 * other half and who has to write it, which is the honest shape of a purchase
 * on a chain where a key signs only for its own account (SPEC §6.3).
 *
 * The one thing worth reading twice is `run` on an exchange. The player does
 * not accept "the shop's offer" — they accept an offer whose terms have been
 * compared, raw unit for raw unit, against their own copy of the recipe. A shop
 * that relists a sword at ten times the price does not sell it to anybody
 * running this code; it just stops matching.
 */

import type { AssetId, KeiClient } from '@keicoin/core'
import { KEI_ASSET, KeiError, assertAddress, fail } from '@keicoin/core'
import type { Duration, MarketApi, Offer, Settlement } from '@keicoin/market'
import { createMarket } from '@keicoin/market'

import { format, isResolved, resolveStack, spendableRaw, type ResolvedStack } from './assets.js'
import {
  acceptableBy,
  assertRunnable,
  buildPlan,
  matchingOffers,
  type Plan,
  type PlanAction,
  type PlanContext,
  type PlanOptions,
  type PlanStep,
} from './plan.js'
import { defineRecipe, isRecipe, type Recipe, type RecipeSpec, type RecipeStrategy } from './recipe.js'

export interface RunOptions extends PlanOptions {
  /**
   * Run it even though the plan found problems. Nothing here bypasses the
   * ledger — the blocks are the same blocks and it will refuse them for the
   * same reasons. This only skips the dry run, for the case where the chain
   * moved between planning and running.
   */
  force?: boolean
}

export interface RunBlock {
  hash: string
  action: PlanAction
  asset: AssetId
  symbol: string
  amount: number
  to?: string
}

export interface RunResult {
  recipe: string
  strategy: RecipeStrategy
  player: string
  issuer: string | null
  /** The dry run this was checked against, problems and warnings included. */
  plan: Plan
  /** Every block this call wrote, in order. */
  blocks: readonly RunBlock[]
  /** Present on an exchange: the one block that moved both legs. */
  settlement?: Settlement
}

export interface StockOptions {
  /** The account that lists them. Defaults to the recipe's issuer, then to this one. */
  issuer?: string
  /** How many copies to put on the shelf. Each is one offer block. Default 1. */
  count?: number
  /** Reserve every offer for one buyer (SPEC §9.2). */
  to?: string
  /** Mint the shortfall to the issuer before listing. Default false. */
  mint?: boolean
  /** Overrides the recipe's own advisory expiry. */
  expiresIn?: Duration
}

export interface ListingOptions {
  /** Whose chain to read. Defaults to the recipe's issuer. */
  issuer?: string
}

export interface EconomyApi {
  /** The catalogue, by id. */
  readonly recipes: ReadonlyMap<string, Recipe>
  /** Register more. Returns the recipe, so it reads well inline. */
  define(recipe: Recipe | RecipeSpec): Recipe
  get(id: string): Recipe
  /** Read the chain, write nothing, and say whether this would work and who signs. */
  plan(recipe: string | Recipe, options?: PlanOptions): Promise<Plan>
  /** Write the half of the recipe this account can sign. */
  run(recipe: string | Recipe | Plan, options?: RunOptions): Promise<RunResult>
  /** Issuer, exchange recipes: put copies on the shelf. Each is one offer block. */
  stock(recipe: string | Recipe, options?: StockOptions): Promise<Offer[]>
  /** The open offers backing a recipe, with terms that match it exactly. */
  listings(recipe: string | Recipe, options?: ListingOptions): Promise<Offer[]>
}

export interface EconomyOptions {
  /** The catalogue this economy starts with. */
  recipes?: Iterable<Recipe | RecipeSpec>
  /**
   * The market to publish and accept through. One is created if absent.
   *
   * Pass your own when you need to close it: an economy has no `close()`, and
   * the market it makes for itself runs the background expiry sweep (SPEC §9.3)
   * with nobody holding the handle. `kei.economy` shares the instance's own
   * market for exactly this reason, so `kei.close()` stops one sweep, not two.
   */
  market?: MarketApi
}

export function createEconomy(client: KeiClient, options: EconomyOptions = {}): EconomyApi {
  const market = options.market ?? createMarket(client)
  const context: PlanContext = { client, market }
  const recipes = new Map<string, Recipe>()

  const define = (input: Recipe | RecipeSpec): Recipe => {
    const recipe = isRecipe(input) ? input : defineRecipe(input)
    recipes.set(recipe.id, recipe)
    return recipe
  }
  for (const recipe of options.recipes ?? []) define(recipe)

  const get = (id: string): Recipe => {
    const recipe = recipes.get(id)
    if (recipe) return recipe
    const known = [...recipes.keys()]
    fail(
      'no-such-recipe',
      known.length === 0
        ? `This economy has no recipe called "${id}", and no recipes at all. Register them at start-up: Kei.start({ recipes: [ ... ] }), or economy.define({ id: '${id}', ... }).`
        : `This economy has no recipe called "${id}". It knows: ${known.join(', ')}.`,
    )
  }

  const asRecipe = (input: string | Recipe): Recipe =>
    typeof input === 'string' ? get(input) : define(input)

  const plan = (input: string | Recipe, planOptions: PlanOptions = {}): Promise<Plan> =>
    buildPlan(context, asRecipe(input), planOptions)

  const run = async (input: string | Recipe | Plan, runOptions: RunOptions = {}): Promise<RunResult> => {
    const ready = isPlan(input)
      ? await buildPlan(context, input.recipe, planOptionsOf(input, runOptions))
      : await plan(input, runOptions)
    if (runOptions.force !== true) assertRunnable(ready)

    const blocks: RunBlock[] = []
    if (ready.strategy === 'exchange') {
      const settlement = await accept(context, ready)
      blocks.push({
        hash: settlement.hash,
        action: 'accept',
        asset: settlement.paid.asset,
        symbol: settlement.paid.symbol,
        amount: settlement.paid.amount,
        to: settlement.from,
      })
      return { ...summary(ready), plan: ready, blocks, settlement }
    }

    for (const step of ready.steps) {
      try {
        blocks.push(await write(client, ready, step))
      } catch (error) {
        throw stoppedPartway(ready.recipe.id, blocks, error)
      }
    }
    return { ...summary(ready), plan: ready, blocks }
  }

  const stock = async (input: string | Recipe, stockOptions: StockOptions = {}): Promise<Offer[]> => {
    const recipe = asRecipe(input)
    if (recipe.strategy !== 'exchange') {
      fail(
        'not-an-exchange',
        `economy.stock() puts copies of a shop or craft recipe on the shelf, and "${recipe.id}" is a ${recipe.strategy} recipe — there is no offer to publish. Run it with economy.run('${recipe.id}'${recipe.strategy === 'grant' ? ', { player })' : ')'}.`,
      )
    }
    if (client.role !== 'issuer') {
      fail(
        'not-issuer-context',
        `economy.stock() writes the offer that locks the ${recipe.id} reward, and only the account that holds it can lock it (SPEC §6.3). Call this on your Kei.server() instance; the browser half calls economy.run('${recipe.id}').`,
      )
    }
    const issuer = stockOptions.issuer ?? recipe.issuer ?? client.address
    if (issuer !== client.address) {
      fail(
        'wrong-issuer',
        `"${recipe.id}" is backed by ${issuer} and this wallet is ${client.address}. A key signs only for its own account (SPEC §6.3), so this account cannot write that offer.`,
      )
    }
    const { cost, grant } = await terms(context, recipe, issuer)
    const count = countOf(stockOptions.count, recipe.id)
    const needed = grant.raw * BigInt(count)

    const held = await spendableRaw(client, grant, issuer)
    if (held < needed) {
      if (stockOptions.mint !== true) {
        fail(
          'no-stock',
          `${issuer} holds ${format(held, grant)} ${grant.symbol} and stocking ${count} × "${recipe.id}" locks ${format(needed, grant)}. Mint them to this account first, or pass { mint: true } and stock() will mint the shortfall before it lists.`,
        )
      }
      if (grant.issuer !== issuer) {
        fail(
          'not-issuer',
          `stock({ mint: true }) would have to mint ${grant.symbol}, which is issued by ${String(grant.issuer)} rather than ${issuer} — only its issuer can mint it (SPEC §5.4). Have that account transfer ${format(needed - held, grant)} here instead.`,
        )
      }
      await client.submitAsset({
        kind: 'mint',
        asset: grant.asset,
        to: issuer,
        amount: (needed - held).toString(),
      })
      // The mint arrives as a receivable on this same account, and an offer can
      // only lock what has actually been collected (SPEC §5.6.3).
      await client.receiveAll()
    }

    const expiresIn = stockOptions.expiresIn ?? recipe.expiresIn
    const to = stockOptions.to === undefined ? undefined : assertAddress(stockOptions.to, 'reserved buyer address')
    const offers: Offer[] = []
    for (let i = 0; i < count; i++) {
      try {
        offers.push(
          await market.offer({
            // Exact decimal strings, from the raw amounts. The offer block is
            // what the player's copy of the recipe is compared against, raw unit
            // for raw unit, so a rounded price here is a listing nothing matches.
            give: { asset: grant.asset, amount: format(grant.raw, grant) },
            want: { asset: cost.asset, amount: format(cost.raw, cost) },
            ...(to === undefined ? {} : { to }),
            ...(expiresIn === undefined ? {} : { expiresIn }),
          }),
        )
      } catch (error) {
        // Each copy is its own block, so the ones already published are real,
        // open, and holding stock locked. Naming them is the difference between
        // restocking the shelf and double-stocking it.
        if (offers.length === 0) throw error
        const reason = error instanceof Error ? error.message : String(error)
        const published = `${offers.length} of ${count} ${offers.length === 1 ? 'copy' : 'copies'}`
        const shelf = offers.map((offer) => offer.hash).join(', ')
        fail(
          error instanceof KeiError ? error.code : 'stock-stopped-partway',
          `Stocking "${recipe.id}" published ${published} before it stopped, and each one is an open offer locking ${grant.amount} ${grant.symbol} on this chain (SPEC §9.2). Already on the shelf: ${shelf}. Count those before restocking, or free them with market.cancel(). It stopped because: ${reason}`,
        )
      }
    }
    return offers
  }

  const listings = async (input: string | Recipe, listOptions: ListingOptions = {}): Promise<Offer[]> => {
    const recipe = asRecipe(input)
    if (recipe.strategy !== 'exchange') {
      fail(
        'not-an-exchange',
        `Only an exchange recipe has listings — "${recipe.id}" is a ${recipe.strategy} recipe, and nothing about it lives on a shelf.`,
      )
    }
    const issuer =
      listOptions.issuer ?? recipe.issuer ?? (client.role === 'issuer' ? client.address : undefined)
    if (issuer === undefined) {
      fail(
        'no-issuer',
        `economy.listings('${recipe.id}') reads one account's chain, because that is where offers live (SPEC §9.1) — and nothing says whose. Give the recipe an issuer, or pass { issuer: gameAddress }.`,
      )
    }
    const { cost, grant } = await terms(context, recipe, assertAddress(issuer, 'issuer address'))
    return matchingOffers(context, { issuer, cost, grant })
  }

  return { recipes, define, get, plan, run, stock, listings }
}

// ------------------------------------------------------------------ writing

async function write(client: KeiClient, plan: Plan, step: PlanStep): Promise<RunBlock> {
  requireSigner(client, plan, step)
  const { stack } = step
  const recipient = (): string => {
    if (step.to !== undefined) return step.to
    fail(
      'not-runnable',
      `Step ${step.action} of "${plan.recipe.id}" moves ${stack.symbol} and names nowhere to move it to. This is an SDK bug — please report it with plan.explain().`,
    )
  }
  const common = {
    action: step.action,
    asset: stack.asset,
    symbol: stack.symbol,
    amount: stack.amount,
    ...(step.to === undefined ? {} : { to: step.to }),
  }

  switch (step.action) {
    case 'mint': {
      const { hash } = await client.submitAsset({
        kind: 'mint',
        asset: stack.asset,
        to: recipient(),
        amount: stack.raw.toString(),
      })
      return { hash, ...common }
    }
    case 'burn': {
      const { hash } = await client.submitAsset({
        kind: 'burn',
        asset: stack.asset,
        amount: stack.raw.toString(),
      })
      return { hash, ...common }
    }
    case 'transfer': {
      const { hash } = await client.submitAsset({
        kind: 'transfer',
        asset: stack.asset,
        to: recipient(),
        amount: stack.raw.toString(),
      })
      return { hash, ...common }
    }
    case 'send': {
      // The decimal string, not the number: a Kei amount goes to 18 places and
      // a JS number does not.
      const { hash } = await client.send(recipient(), format(stack.raw, stack))
      return { hash, ...common }
    }
    default:
      fail(
        'not-runnable',
        `Step "${step.action}" of "${plan.recipe.id}" is not something run() writes. An offer is published with economy.stock(); an accept is written by the player's own economy.run().`,
      )
  }
}

/**
 * The boundary, enforced rather than documented. Every refusal names the other
 * account and what it has to do, because "wrong signer" with no second half is
 * how people end up building a server that holds keys.
 */
function requireSigner(client: KeiClient, plan: Plan, step: PlanStep): void {
  if (step.signedBy === client.address) return
  if (step.signer === 'issuer') {
    fail(
      'not-issuer-context',
      `"${plan.recipe.id}" is granted by ${step.signedBy}, and only that account can sign for it (SPEC §6.3) — this wallet is ${client.address}. The game's server runs economy.run('${plan.recipe.id}', { player: '${plan.player}' }); a browser cannot, and a browser that could would be holding your issuer seed.`,
    )
  }
  fail(
    'not-the-player',
    `"${plan.recipe.id}" is spent by ${step.signedBy}, and a key signs only for its own account (SPEC §6.3) — this wallet is ${client.address}. The player's own SDK runs economy.run('${plan.recipe.id}'); there is no charge(someoneElse, ...) and there cannot be.`,
  )
}

/**
 * Accept whichever matching offer is still open.
 *
 * A shop with five swords on the shelf is five offer blocks, and losing the
 * race for one of them is an ordinary outcome (SPEC §9.2, conflict 4) — so it
 * moves to the next rather than surfacing a race as a failure. Running out is
 * a different sentence, and it gets one.
 */
async function accept(context: PlanContext, plan: Plan): Promise<Settlement> {
  const cost = plan.costs[0]
  const grant = plan.grants[0]
  const issuer = plan.issuer
  if (!cost || !grant || issuer === null) {
    fail('not-runnable', `"${plan.recipe.id}" has no resolved terms to accept. Call plan.explain() to see why.`)
  }
  if (plan.player !== context.client.address) {
    fail(
      'not-the-player',
      `economy.run('${plan.recipe.id}') writes the accept block, and only ${plan.player} can sign it (SPEC §6.3) — this wallet is ${context.client.address}. The issuer's half is economy.stock('${plan.recipe.id}').`,
    )
  }
  if (context.client.address === issuer) {
    fail(
      'self-accept',
      `This wallet is the issuer of "${plan.recipe.id}", and an account cannot accept its own offer (SPEC §9.2). The issuer stocks the shelf with economy.stock('${plan.recipe.id}'); a player's own SDK runs it.`,
    )
  }

  const matching = await matchingOffers(context, { issuer, cost, grant })
  if (matching.length === 0) {
    fail(
      'no-listing',
      `${issuer} has no open offer giving ${grant.amount} ${grant.symbol} for ${cost.amount} ${cost.symbol}, so "${plan.recipe.id}" has nothing to accept. The game's server stocks it with economy.stock('${plan.recipe.id}').`,
    )
  }
  // A copy reserved for another player is a matching offer this wallet cannot
  // take (SPEC §9.2). Skipping it rather than accepting it is the difference
  // between a shelf with one reserved sword on it and a shelf nobody can buy
  // from.
  const offers = acceptableBy(matching, plan.player)
  if (offers.length === 0) {
    fail(
      'not-the-counterparty',
      `All ${matching.length} ${matching.length === 1 ? 'offer' : 'offers'} backing "${plan.recipe.id}" are reserved for other accounts, so the ledger would refuse this wallet's accept block (SPEC §9.2). Reserving is how a gate holds; ask the game to stock an unreserved copy, or one reserved for ${plan.player}.`,
    )
  }

  let lastRace: KeiError | undefined
  for (const offer of offers) {
    try {
      return await context.market.accept(offer)
    } catch (error) {
      if (error instanceof KeiError && (error.code === 'offer-taken' || error.code === 'offer-cancelled')) {
        lastRace = error
        continue
      }
      throw error
    }
  }
  fail(
    'no-listing',
    `Every offer backing "${plan.recipe.id}" was taken or cancelled while this call was choosing one — that race is normal and expected (SPEC §9.2), and nothing of yours moved. Try again once the shop restocks. Last: ${String(lastRace?.message)}`,
  )
}

// ----------------------------------------------------------------- helpers

interface Terms {
  cost: ResolvedStack
  grant: ResolvedStack
}

/** The two legs of an exchange, resolved, or the sentence that says why not. */
async function terms(context: PlanContext, recipe: Recipe, issuer: string): Promise<Terms> {
  const cost = recipe.costs[0]
  const grant = recipe.grants[0]
  if (!cost || !grant) {
    fail('not-an-exchange', `"${recipe.id}" has no single cost and grant, so it has no swap terms.`)
  }
  const resolvedCost = await resolveStack(context.client, cost, issuer, `costs[0] of recipe "${recipe.id}"`)
  const resolvedGrant = await resolveStack(context.client, grant, issuer, `grants[0] of recipe "${recipe.id}"`)
  if (!isResolved(resolvedCost)) fail(resolvedCost.code, resolvedCost.message)
  if (!isResolved(resolvedGrant)) fail(resolvedGrant.code, resolvedGrant.message)
  if (resolvedGrant.asset === KEI_ASSET && resolvedCost.asset === KEI_ASSET) {
    fail('same-asset', `"${recipe.id}" trades Kei for Kei, which moves nothing.`)
  }
  return { cost: resolvedCost, grant: resolvedGrant }
}

/**
 * What a multi-block recipe owes the caller when it stops halfway.
 *
 * The ledger has no way to group blocks, so a grant of two assets is two blocks
 * and the first one stands whatever happens to the second (the plan warns about
 * exactly this as `not-one-block`). The original refusal is still the reason, so
 * it keeps its code; what it cannot know on its own is that something already
 * settled. Anybody reconciling this needs the hashes, and an error is the only
 * place left to put them.
 */
function stoppedPartway(id: string, written: readonly RunBlock[], error: unknown): unknown {
  if (written.length === 0) return error
  const done = written
    .map((block) => `${block.action} ${block.amount} ${block.symbol} (${block.hash})`)
    .join('; ')
  const reason = error instanceof Error ? error.message : String(error)
  return new KeiError(
    error instanceof KeiError ? error.code : 'run-stopped-partway',
    `"${id}" stopped after ${written.length} of its blocks had already settled, and a settled block cannot be taken back — one account keeps one chain and one block does one thing, so there is nothing to group two of them into (SPEC §5.6.1). Already written and standing: ${done}. It stopped because: ${reason}`,
  )
}

function countOf(count: number | undefined, id: string): number {
  if (count === undefined) return 1
  if (!Number.isInteger(count) || count < 1) {
    fail(
      'bad-count',
      `economy.stock('${id}', { count }) takes a whole number of copies, one or more — got ${String(count)}.`,
    )
  }
  return count
}

function summary(plan: Plan): Pick<RunResult, 'recipe' | 'strategy' | 'player' | 'issuer'> {
  return { recipe: plan.recipe.id, strategy: plan.strategy, player: plan.player, issuer: plan.issuer }
}

/**
 * A plan handed back to `run()` is rebuilt, not replayed. It was a photograph
 * of the chain at the moment it was taken, and the point of taking it again is
 * that the chain moved: an offer got accepted, a balance got spent.
 */
function planOptionsOf(plan: Plan, runOptions: RunOptions): PlanOptions {
  const issuer = runOptions.issuer ?? plan.issuer
  return {
    player: runOptions.player ?? plan.player,
    ...(issuer === null ? {} : { issuer }),
  }
}

function isPlan(input: string | Recipe | Plan): input is Plan {
  return typeof input === 'object' && input !== null && 'steps' in input && 'explain' in input
}
