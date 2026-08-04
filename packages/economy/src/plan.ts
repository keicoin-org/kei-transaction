/**
 * The dry run.
 *
 * `plan()` reads the chain and writes nothing. It is the answer to the two
 * questions a game asks before it puts a button on screen — *can this player do
 * this*, and *who signs what* — and it answers them in that order, as data
 * rather than as an exception, because a UI needs to grey a button out without
 * catching a throw to find out.
 *
 * Every step carries the account that signs it. That is not decoration: a
 * private key signs only for its own account (SPEC §6.3), so a plan with an
 * issuer step in it is a plan the player *cannot* finish alone, and saying so
 * up front is the difference between an SDK and a server that holds balances.
 */

import type { AssetId, KeiClient, SwapOffer } from '@keicoin/core'
import { KEI_ASSET, assertAddress, fail } from '@keicoin/core'
import type { MarketApi, Offer } from '@keicoin/market'

import {
  format,
  isResolved,
  lockedRaw,
  resolveStack,
  spendableRaw,
  type ResolvedStack,
} from './assets.js'
import type { Recipe, RecipeStrategy } from './recipe.js'

/** What a step does, named after the block it becomes. */
export type PlanAction = 'mint' | 'send' | 'burn' | 'transfer' | 'offer' | 'accept'

export interface PlanStep {
  /** Which key signs this block. A plan never assumes it holds both. */
  signer: 'player' | 'issuer'
  /** The account that signs it, spelled out. */
  signedBy: string
  action: PlanAction
  stack: ResolvedStack
  /** Where the units land, when the action moves them somewhere. */
  to?: string
  /** One sentence, in the voice of the errors. */
  describe: string
}

/** Something that stops the plan, or something worth saying out loud. */
export interface Problem {
  code: string
  message: string
}

export interface Plan {
  recipe: Recipe
  strategy: RecipeStrategy
  /** The wallet this plan is for. */
  player: string
  /** The account backing the grants. Null only when nothing needs one. */
  issuer: string | null
  /**
   * True when one block settles every leg, so nobody can be left having paid
   * for something they did not receive. Only an exchange settles two parties in
   * one block; a grant or a sink of one asset is one block because it has one
   * leg to move.
   */
  atomic: boolean
  requires: readonly ResolvedStack[]
  costs: readonly ResolvedStack[]
  grants: readonly ResolvedStack[]
  steps: readonly PlanStep[]
  /** Blocking. Each is a sentence that states its own fix. */
  problems: readonly Problem[]
  /** Not blocking, and worth reading before you ship. */
  warnings: readonly Problem[]
  /** No problems. What a UI puts behind a disabled button. */
  ok: boolean
  /** The whole plan as copyable text — for a log, an agent, or a bug report. */
  explain(): string
}

export interface PlanOptions {
  /** The wallet the recipe runs for. Defaults to this one. */
  player?: string
  /** The account backing it. Defaults to the recipe's, then to this issuer. */
  issuer?: string
}

export interface PlanContext {
  client: KeiClient
  market: MarketApi
}

export async function buildPlan(
  context: PlanContext,
  recipe: Recipe,
  options: PlanOptions = {},
): Promise<Plan> {
  const { client } = context
  const player =
    options.player === undefined ? client.address : assertAddress(options.player, 'player address')
  const declaredIssuer =
    options.issuer !== undefined
      ? assertAddress(options.issuer, 'issuer address')
      : recipe.issuer !== undefined
        ? recipe.issuer
        : client.role === 'issuer'
          ? client.address
          : null

  const problems: Problem[] = []
  const warnings: Problem[] = []

  const resolveAll = async (stacks: readonly { asset: unknown; amount?: number | string }[], field: string) => {
    const out: ResolvedStack[] = []
    for (const [index, stack] of stacks.entries()) {
      const resolution = await resolveStack(
        client,
        stack as never,
        declaredIssuer,
        `${field}[${index}] of recipe "${recipe.id}"`,
      )
      if (isResolved(resolution)) out.push(resolution)
      else problems.push({ code: resolution.code, message: resolution.message })
    }
    return out
  }

  const requires = await resolveAll(recipe.requires, 'requires')
  const costs = await resolveAll(recipe.costs, 'costs')
  const grants = await resolveAll(recipe.grants, 'grants')

  // A recipe named entirely by asset id can still say who backs it: an asset
  // knows its own issuer, and for these three shapes that is who mints and
  // who offers.
  const issuer =
    declaredIssuer ?? grants[0]?.issuer ?? (recipe.sink === 'issuer' ? (costs[0]?.issuer ?? null) : null)

  const steps: PlanStep[] = []

  await checkRequirements(client, requires, player, recipe, problems)

  if (recipe.strategy === 'grant') {
    await planGrant(context, { recipe, grants, player, issuer }, steps, problems, warnings)
  } else if (recipe.strategy === 'sink') {
    await planSink(context, { recipe, costs, player, issuer }, steps, problems, warnings)
  } else {
    await planExchange(context, { recipe, costs, grants, player, issuer }, steps, problems, warnings)
  }

  // A plan with no steps settles nothing, so it is not atomic — it is stuck.
  // Saying "one block" of a plan that has no block is the one lie a disabled
  // button cannot afford.
  const atomic = steps.length > 0 && (recipe.strategy === 'exchange' || movingSteps(steps) <= 1)
  if (!atomic && steps.length > 1) {
    warnings.push({
      code: 'not-one-block',
      message: `Running "${recipe.id}" writes ${steps.length} blocks, not one, and the ledger has no way to group them — if the run stops halfway the earlier blocks stand. Keep multi-asset rewards and multi-asset sinks to things a player can be given twice or charged twice without harm, and use a one-in-one-out recipe when it has to be all or nothing.`,
    })
  }

  const plan: Plan = {
    recipe,
    strategy: recipe.strategy,
    player,
    issuer,
    atomic,
    requires,
    costs,
    grants,
    steps,
    problems,
    warnings,
    ok: problems.length === 0,
    explain: () => explain(plan),
  }
  return plan
}

// --------------------------------------------------------------- the shapes

interface GrantInput {
  recipe: Recipe
  grants: readonly ResolvedStack[]
  player: string
  issuer: string | null
}

async function planGrant(
  context: PlanContext,
  input: GrantInput,
  steps: PlanStep[],
  problems: Problem[],
  warnings: Problem[],
): Promise<void> {
  const { recipe, grants, player, issuer } = input
  if (issuer === null && grants.length > 0) {
    problems.push({
      code: 'no-issuer',
      message: `Recipe "${recipe.id}" grants assets, and only the account that issued them can mint them (SPEC §5.4). Run it from your Kei.server() instance, or say who backs it with defineRecipe({ issuer: gameAddress, ... }).`,
    })
    return
  }
  if (issuer === null) return

  for (const grant of grants) {
    if (grant.asset === KEI_ASSET) {
      // Nobody issues Kei, so a Kei reward is a payment out of the issuer's own
      // balance rather than a mint. Worth stating: it is real money leaving.
      const held = await spendableRaw(context.client, grant, issuer)
      if (held < grant.raw) {
        problems.push({
          code: 'insufficient-kei',
          message: `Recipe "${recipe.id}" pays ${grant.amount} Kei and ${issuer} holds ${format(held, grant)}. Fund that account first; on testnet call faucet().`,
        })
      }
      steps.push({
        signer: 'issuer',
        signedBy: issuer,
        action: 'send',
        stack: grant,
        to: player,
        describe: `${issuer} sends ${grant.amount} Kei to ${player}`,
      })
      continue
    }

    if (grant.issuer !== issuer) {
      problems.push({
        code: 'not-issuer',
        message: `Recipe "${recipe.id}" grants ${grant.symbol}, which is issued by ${String(grant.issuer)} — ${issuer} cannot mint it (SPEC §5.4). Plan it from the issuing account, or have that account transfer units to ${issuer} and grant them with sink-side stock instead.`,
      })
      continue
    }
    if (grant.maxSupplyRaw !== null && grant.circulatingRaw + grant.raw > grant.maxSupplyRaw) {
      const room = grant.maxSupplyRaw - grant.circulatingRaw
      problems.push({
        code: 'over-max-supply',
        message: `${grant.symbol} has a maximum supply of ${format(grant.maxSupplyRaw, grant)} with ${format(grant.circulatingRaw, grant)} in circulation, so only ${format(room, grant)} can still be created and "${recipe.id}" grants ${grant.amount}. Burning frees headroom (SPEC §5.6.6).`,
      })
    }
    steps.push({
      signer: 'issuer',
      signedBy: issuer,
      action: 'mint',
      stack: grant,
      to: player,
      describe: `${issuer} mints ${grant.amount} ${grant.symbol} to ${player}`,
    })
  }

  if (player === issuer && grants.length > 0) {
    warnings.push({
      code: 'granting-to-yourself',
      message: `"${recipe.id}" is planned with the issuer as the player, so it mints to ${issuer} itself and no player receives anything. If this is a reward, name who it is for: economy.run('${recipe.id}', { player: playerAddress }).`,
    })
  }

  if (grants.length > 8) {
    warnings.push({
      code: 'mint-per-player',
      message: `"${recipe.id}" mints ${grants.length} assets from one account, and every mint is a block on that account's chain — a reward handed to many players at once turns the issuer into a write lock. For a batch, publish one root with token.commit() and let each player claim it from their own chain (SPEC §5.5).`,
    })
  }
}

interface SinkInput {
  recipe: Recipe
  costs: readonly ResolvedStack[]
  player: string
  issuer: string | null
}

async function planSink(
  context: PlanContext,
  input: SinkInput,
  steps: PlanStep[],
  problems: Problem[],
  warnings: Problem[],
): Promise<void> {
  const { recipe, costs, player, issuer } = input
  const toIssuer = recipe.sink === 'issuer'
  if (toIssuer && issuer === null && costs.length > 0) {
    problems.push({
      code: 'no-issuer',
      message: `Recipe "${recipe.id}" sends its costs to the issuer, and nothing here says who that is. Add defineRecipe({ issuer: gameAddress, ... }), or use the default sink: 'burn' to destroy them instead.`,
    })
    return
  }

  for (const cost of costs) {
    await checkAffordable(context, cost, player, `"${recipe.id}" costs`, problems)

    if (!toIssuer) {
      if (cost.asset === KEI_ASSET) {
        problems.push({
          code: 'cannot-burn-kei',
          message: `Recipe "${recipe.id}" burns Kei, and a holder cannot burn Kei — there is no such block, because Kei's supply is fixed at genesis (SPEC §5.7). Use sink: 'issuer' to send it to the game's wallet, or charge in a token you issue, which you can burn.`,
        })
        continue
      }
      steps.push({
        signer: 'player',
        signedBy: player,
        action: 'burn',
        stack: cost,
        describe: `${player} burns ${cost.amount} ${cost.symbol}`,
      })
      continue
    }

    if (issuer === null) continue
    if (cost.asset !== KEI_ASSET) {
      checkTransferable(cost, player, issuer, `"${recipe.id}" sends ${cost.symbol} to the issuer`, problems)
    }
    steps.push({
      signer: 'player',
      signedBy: player,
      action: cost.asset === KEI_ASSET ? 'send' : 'transfer',
      stack: cost,
      to: issuer,
      describe: `${player} sends ${cost.amount} ${cost.symbol} to ${issuer}`,
    })
  }

  if (toIssuer) {
    warnings.push({
      code: 'issuer-holds-it',
      message: `"${recipe.id}" moves what it costs into ${String(issuer)} rather than destroying it, so those units stay in circulation and can be spent again. A sink that is meant to take supply out of the economy wants the default sink: 'burn'.`,
    })
  }
}

interface ExchangeInput {
  recipe: Recipe
  costs: readonly ResolvedStack[]
  grants: readonly ResolvedStack[]
  player: string
  issuer: string | null
}

async function planExchange(
  context: PlanContext,
  input: ExchangeInput,
  steps: PlanStep[],
  problems: Problem[],
  warnings: Problem[],
): Promise<void> {
  const { recipe, costs, grants, player, issuer } = input
  const cost = costs[0]
  const grant = grants[0]
  // Either failed to resolve, and said why already.
  if (!cost || !grant) return

  if (issuer === null) {
    problems.push({
      code: 'no-issuer',
      message: `Recipe "${recipe.id}" settles as a swap, and a swap has an author: somebody has to have written the offer that locks the ${grant.symbol}. Say who with defineRecipe({ issuer: gameAddress, ... }), or plan it from that account.`,
    })
    return
  }
  if (cost.asset === grant.asset) {
    problems.push({
      code: 'same-asset',
      message: `Recipe "${recipe.id}" takes ${cost.symbol} and gives ${grant.symbol}, which are the same asset — a swap of an asset for itself moves nothing and the ledger will not write one. Change one side.`,
    })
    return
  }
  if (player === issuer) {
    problems.push({
      code: 'self-swap',
      message: `The player and the issuer of "${recipe.id}" are both ${player}, and an account cannot accept its own offer (SPEC §9.2) — it would trade an asset with itself. Plan this for a player's address with plan({ player }).`,
    })
    return
  }

  checkSwappable(grant, issuer, player, 'offered', problems)
  checkSwappable(cost, issuer, player, 'wanted', problems)
  await checkAffordable(context, cost, player, `"${recipe.id}" asks for`, problems)

  if (recipe.requires.length > 0) {
    warnings.push({
      code: 'requires-not-enforced',
      message: `"${recipe.id}" settles as an open offer, and an open offer is open: consensus knows nothing about its requires, so anybody holding ${cost.amount} ${cost.symbol} can take it. Reserve the offer for one player — economy.stock('${recipe.id}', { to: playerAddress }) — if the gate has to hold.`,
    })
  }

  steps.push({
    signer: 'issuer',
    signedBy: issuer,
    action: 'offer',
    stack: grant,
    describe: `${issuer} locks ${grant.amount} ${grant.symbol} in an offer asking ${cost.amount} ${cost.symbol}`,
  })
  steps.push({
    signer: 'player',
    signedBy: player,
    action: 'accept',
    stack: cost,
    to: issuer,
    describe: `${player} pays ${cost.amount} ${cost.symbol} and receives ${grant.amount} ${grant.symbol} — one block, both legs or neither`,
  })

  // The two halves are checked from whichever side is asking, because that is
  // the side that can do something about the answer.
  if (context.client.role === 'issuer' && context.client.address === issuer) {
    const held = await spendableRaw(context.client, grant, issuer)
    if (held < grant.raw) {
      // A shop that pays out Kei locks Kei, and nobody issues Kei (SPEC §5.7),
      // so the mint that fixes a stock shortfall does not exist for this leg.
      problems.push(
        grant.asset === KEI_ASSET
          ? {
              code: 'insufficient-kei',
              message: `"${recipe.id}" pays out ${grant.amount} Kei and ${issuer} holds ${format(held, grant)}. Kei is not minted — its supply is fixed at genesis (SPEC §5.7) — so fund this account before stocking; on testnet call faucet().`,
            }
          : {
              code: 'no-stock',
              message: `${issuer} holds ${format(held, grant)} ${grant.symbol} and stocking "${recipe.id}" locks ${grant.amount}. Mint some to this account first, or pass { mint: true } to economy.stock() and it will mint the shortfall before it lists.`,
            },
      )
    }
  } else {
    const listings = await matchingOffers(context, { issuer, cost, grant })
    if (acceptableBy(listings, player).length === 0) {
      problems.push(
        listings.length === 0
          ? {
              code: 'no-listing',
              message: `${issuer} has no open offer on its chain giving ${grant.amount} ${grant.symbol} for ${cost.amount} ${cost.symbol}, so there is nothing for "${recipe.id}" to accept — an offer is a block, and only its author can write it (SPEC §9.2). The game's server stocks the shop with economy.stock('${recipe.id}'); until it does, this recipe has nothing behind it.`,
            }
          : {
              code: 'not-the-counterparty',
              message: `Every offer backing "${recipe.id}" on ${issuer}'s chain is reserved for somebody else, so the ledger would refuse ${player}'s accept block (SPEC §9.2). A reserved offer is how a gate actually holds — economy.stock('${recipe.id}', { to: playerAddress }) — so this is the shelf working as stocked, not an error. Stock an unreserved copy if anybody should be able to take it.`,
            },
      )
    }
  }
}

// -------------------------------------------------------------- the checks

async function checkRequirements(
  client: KeiClient,
  requires: readonly ResolvedStack[],
  player: string,
  recipe: Recipe,
  problems: Problem[],
): Promise<void> {
  for (const requirement of requires) {
    const held = await spendableRaw(client, requirement, player)
    if (held >= requirement.raw) continue
    problems.push({
      code: 'requirement-unmet',
      message: `"${recipe.id}" needs ${requirement.amount} ${requirement.symbol} and ${player} holds ${format(held, requirement)}. This one is kept, not spent — it is a gate, not a price.`,
    })
  }
}

async function checkAffordable(
  context: PlanContext,
  cost: ResolvedStack,
  player: string,
  why: string,
  problems: Problem[],
): Promise<void> {
  const held = await spendableRaw(context.client, cost, player)
  if (held >= cost.raw) return
  // Only now, because it is one more round trip and it only ever explains a
  // shortfall this wallet caused itself (SPEC §9.2).
  const locked =
    player === context.client.address ? await lockedRaw(context.client, cost.asset, player) : 0n
  const hint =
    locked > 0n
      ? ` ${format(locked, cost)} ${cost.symbol} is locked in your own open offers — market.cancel() frees it.`
      : ''
  problems.push({
    code: cost.asset === KEI_ASSET ? 'insufficient-kei' : 'insufficient-balance',
    message: `Not enough ${cost.symbol} — ${player} holds ${format(held, cost)}, and ${why} ${cost.amount}.${hint}`,
  })
}

function checkTransferable(
  stack: ResolvedStack,
  from: string,
  to: string,
  what: string,
  problems: Problem[],
): void {
  if (stack.transferPolicy === 'open') return
  if (stack.transferPolicy === 'issuer-only' && (from === stack.issuer || to === stack.issuer)) return
  problems.push({
    code: 'transfer-not-permitted',
    message:
      stack.transferPolicy === 'none'
        ? `${what}, and ${stack.symbol} is soulbound — it cannot be transferred at all, only burned (SPEC §5.4). Use the default sink: 'burn'.`
        : `${what}, and ${stack.symbol} is issuer-only: units may only move to or from ${String(stack.issuer)} (SPEC §5.4), which neither ${from} nor ${to} is.`,
  })
}

/**
 * Whether a swap leg could ever settle. Mirrors the ledger's own refusal
 * (SPEC §5.4), so the plan says no before an offer locks an asset that nothing
 * but a cancel could ever free.
 */
function checkSwappable(
  stack: ResolvedStack,
  offerer: string,
  counterparty: string,
  side: 'offered' | 'wanted',
  problems: Problem[],
): void {
  if (stack.asset === KEI_ASSET || stack.transferPolicy === 'open') return
  if (stack.transferPolicy === 'issuer-only' && (offerer === stack.issuer || counterparty === stack.issuer)) {
    return
  }
  problems.push({
    code: 'transfer-not-permitted',
    message:
      stack.transferPolicy === 'none'
        ? `${stack.symbol} is soulbound, so it can never be the ${side} side of a swap (SPEC §5.4) — the ledger refuses the offer rather than locking something only a cancel could free. Grant it with a reward recipe instead, which mints straight to the player.`
        : `${stack.symbol} is issuer-only, so a swap of it only settles when ${String(stack.issuer)} is one of the two parties (SPEC §5.4) — and here they are ${offerer} and ${counterparty}.`,
  })
}

// -------------------------------------------------------------- the listing

export interface MatchTerms {
  issuer: string
  cost: ResolvedStack
  grant: ResolvedStack
}

/**
 * The issuer's open offers whose terms are exactly this recipe's.
 *
 * "Exactly" is the whole point. A shop is a set of blocks on somebody else's
 * chain, and the player's protection is not that the shop is honest — it is
 * that the player's own copy of the recipe says what the terms must be, and
 * anything that does not match is not this recipe.
 *
 * Two reads of that chain, and not one per listing: the raw pass decides what
 * matches, and the market pass supplies the shape a caller can hand to
 * `accept()` and render. Both are bounded chain walks (SPEC §9.1).
 */
export async function matchingOffers(context: PlanContext, terms: MatchTerms): Promise<Offer[]> {
  const raws = await context.client.node.accountSwaps(terms.issuer, { state: 'open' })
  const exact = new Set(raws.filter((raw) => rawTermsMatch(raw, terms)).map((raw) => raw.hash))
  if (exact.size === 0) return []

  const offers = await context.market.offers({
    from: terms.issuer,
    asset: terms.grant.asset,
    want: terms.cost.asset,
    state: 'open',
  })
  return offers.filter((offer) => exact.has(offer.hash))
}

/**
 * The offers on a shelf this player could actually accept.
 *
 * A reserved offer (SPEC §9.2) is a real, open, exactly-matching listing that
 * this player cannot take: the ledger refuses their accept block. Splitting that
 * out is what stops one copy reserved for one player from making the whole shelf
 * unbuyable for everybody else, and it is what a shop view wants to render.
 */
export function acceptableBy(offers: readonly Offer[], player: string): Offer[] {
  return offers.filter((offer) => offer.to === null || offer.to === player)
}

/** Verify one named offer against a recipe's terms, re-reading its block. */
export async function termsMatch(
  context: PlanContext,
  offer: Offer | string,
  terms: MatchTerms,
): Promise<boolean> {
  const raw = await context.client.node.swapOffer(typeof offer === 'string' ? offer : offer.hash)
  return raw !== null && rawTermsMatch(raw, terms)
}

/**
 * Compare the raw amounts on the offer block itself, never the decimal numbers
 * the market renders for display — those round-trip through a JS number, and an
 * amount is a promise about money.
 */
function rawTermsMatch(raw: SwapOffer, terms: MatchTerms): boolean {
  return (
    raw.state === 'open' &&
    raw.from === terms.issuer &&
    sameAsset(raw.asset, terms.grant.asset) &&
    sameAsset(raw.wantAsset, terms.cost.asset) &&
    BigInt(raw.amount) === terms.grant.raw &&
    BigInt(raw.wantAmount) === terms.cost.raw
  )
}

function sameAsset(a: AssetId, b: AssetId): boolean {
  return String(a).toUpperCase() === String(b).toUpperCase()
}

/** Blocks that actually move something, which is what atomicity is about. */
function movingSteps(steps: readonly PlanStep[]): number {
  return steps.filter((step) => step.action !== 'offer').length
}

// ------------------------------------------------------------- the printout

function explain(plan: Plan): string {
  const lines: string[] = []
  const title = plan.recipe.name === plan.recipe.id ? plan.recipe.id : `${plan.recipe.id} — ${plan.recipe.name}`
  lines.push(`Recipe "${title}"`)
  if (plan.recipe.description !== undefined) lines.push(plan.recipe.description)
  lines.push(
    `${plan.strategy}, ${
      plan.steps.length === 0
        ? 'nothing to run — see the problems below'
        : plan.atomic
          ? 'settled by one block — nobody can be left having paid without receiving'
          : `settled by ${plan.steps.length} separate blocks`
    }`,
  )
  lines.push(`player ${plan.player}`)
  lines.push(`issuer ${plan.issuer ?? '(none — this recipe needs no issuer)'}`)

  if (plan.requires.length > 0) {
    lines.push('', 'Requires (kept, not spent):')
    for (const stack of plan.requires) lines.push(`  ${stack.amount} ${stack.symbol}  ${stack.name}`)
  }
  if (plan.costs.length > 0) {
    lines.push('', plan.recipe.sink === 'burn' ? 'Costs (burned):' : 'Costs (to the issuer):')
    for (const stack of plan.costs) lines.push(`  ${stack.amount} ${stack.symbol}  ${stack.name}`)
  }
  if (plan.grants.length > 0) {
    lines.push('', 'Grants:')
    for (const stack of plan.grants) lines.push(`  ${stack.amount} ${stack.symbol}  ${stack.name}`)
  }

  lines.push('', 'Steps:')
  if (plan.steps.length === 0) lines.push('  (none — see the problems below)')
  for (const [index, step] of plan.steps.entries()) {
    lines.push(`  ${index + 1}. [${step.signer} signs] ${step.action}: ${step.describe}`)
  }

  if (plan.problems.length > 0) {
    lines.push('', 'Problems — this plan will not run:')
    for (const problem of plan.problems) lines.push(`  - ${problem.code}: ${problem.message}`)
  }
  if (plan.warnings.length > 0) {
    lines.push('', 'Worth knowing:')
    for (const warning of plan.warnings) lines.push(`  - ${warning.code}: ${warning.message}`)
  }
  if (plan.ok && plan.warnings.length === 0) lines.push('', 'No problems.')
  return lines.join('\n')
}

/** Throw a plan's first problem, in the voice of every other error here. */
export function assertRunnable(plan: Plan): void {
  const first = plan.problems[0]
  if (first === undefined) return
  const rest =
    plan.problems.length > 1
      ? ` (${plan.problems.length - 1} more ${
          plan.problems.length === 2 ? 'problem' : 'problems'
        } — call plan.explain() to see all of them)`
      : ''
  fail(first.code, `${first.message}${rest}`)
}
