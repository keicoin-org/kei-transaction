/**
 * A recipe is a declaration, not a transaction.
 *
 * `defineRecipe()` is pure and synchronous: it reads no chain, signs nothing,
 * and is meant to live in a file both halves of a game import — the server that
 * backs the recipe and the browser that runs it. That shared file is the point.
 * When the player's SDK checks an on-chain offer against the same recipe object
 * the server published it from, "is this shop selling me what it said it would"
 * stops being a matter of trust (plan.ts, `verify`).
 *
 * What a recipe may say is deliberately narrow, because what the ledger can do
 * is narrow. Three shapes come out of `costs` and `grants`, and nothing else
 * does:
 *
 * - **grant** — costs nothing, grants something. A reward, a daily bonus, a
 *   quest payout. The issuer mints it; only the issuer can.
 * - **sink** — costs something, grants nothing. A repair fee, a re-roll, an
 *   entry ticket. The holder burns it, or sends it to the issuer, and signs
 *   that themselves.
 * - **exchange** — one asset in, one asset out. A shop sale, a craft, an
 *   upgrade, a trade-in. It compiles to a swap: the issuer writes the offer,
 *   the player writes the accept, and one block moves both legs or neither
 *   (SPEC §9.2). This is the only shape where nobody has to be trusted for the
 *   other half.
 *
 * One asset each way is not an omission. A `swap_offer` locks one asset and
 * names one it wants, so "three iron and two wood for a sword" has no single
 * block that could settle it — and the alternatives all end with somebody
 * having paid for something they did not get. `defineRecipe` refuses that
 * shape rather than quietly picking which player to expose.
 */

import type { AssetId } from '@keicoin/core'
import { assertAddress, fail } from '@keicoin/core'
import type { Duration } from '@keicoin/market'

/**
 * How a recipe names an asset.
 *
 * A bare string is an asset id, or `'KEI'` for Kei itself. `{ id }` accepts a
 * token or item object as it comes back from `token.issue()` / `items.create()`.
 * `{ symbol, issuer }` is the one a shared recipe file wants: it survives being
 * written before the asset exists, and resolves against the chain at plan time.
 */
export type AssetRef =
  | string
  | { readonly id: AssetId }
  | { readonly symbol: string; readonly issuer?: string }

/** An asset and how much of it. Amount defaults to 1, which is the item case. */
export interface Stack {
  asset: AssetRef
  amount?: number | string
}

/** What `costs` and `grants` produce. Derived, never declared. */
export type RecipeStrategy = 'grant' | 'sink' | 'exchange'

/** Where a recipe's costs end up. */
export type SinkPolicy = 'burn' | 'issuer'

export interface RecipeSpec {
  /** Stable id. It is how both halves of the game refer to this recipe. */
  id: string
  /** Shown to players. Defaults to the id. */
  name?: string
  description?: string
  /**
   * What the player must already hold and keeps — a level token, a quest badge,
   * a membership.
   *
   * Read the honest limit before leaning on it: consensus has no notion of a
   * precondition, so this is checked when the plan is built and again by the
   * issuer before it signs. That is real for a `grant`, where the issuer signs
   * the only block that matters. It is *not* enforced on an `exchange`, because
   * an open offer is open — anybody who can pay can take it. Reserve the offer
   * for one player (`plan({ to })`) if the gate has to hold.
   */
  requires?: readonly Stack[]
  /** What the player gives up. */
  costs?: readonly Stack[]
  /** What the player receives. */
  grants?: readonly Stack[]
  /**
   * Where the costs go. `'burn'` destroys them, which is the sink a currency
   * needs; `'issuer'` sends them to the issuer's wallet.
   *
   * Defaults to `'burn'` when the recipe grants nothing. An `exchange` is
   * always `'issuer'` — the costs are the other leg of a swap, so they land in
   * the offerer's wallet by definition, and the issuer burns them afterwards if
   * it wants to (`token.burn()`).
   */
  sink?: SinkPolicy
  /**
   * The account that backs this recipe: it mints the grants, and writes the
   * offer an exchange settles against. Defaults to the issuer planning it.
   */
  issuer?: string
  /** Advisory expiry stamped on offers this recipe publishes (SPEC §9.3). */
  expiresIn?: Duration
}

export interface Recipe {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly strategy: RecipeStrategy
  readonly requires: readonly Stack[]
  readonly costs: readonly Stack[]
  readonly grants: readonly Stack[]
  readonly sink: SinkPolicy
  readonly issuer?: string
  readonly expiresIn?: Duration
}

/**
 * Validate a recipe and freeze it. Everything checkable without a chain is
 * checked here, so a malformed recipe fails at import rather than in front of a
 * player.
 */
export function defineRecipe(spec: RecipeSpec): Recipe {
  if (!spec || typeof spec !== 'object') {
    fail(
      'bad-recipe',
      "defineRecipe() takes { id, costs?, grants? } — for example defineRecipe({ id: 'daily-bonus', grants: [{ asset: gems, amount: 50 }] }).",
    )
  }
  const id = String(spec.id ?? '').trim()
  if (id === '') {
    fail(
      'bad-recipe',
      "A recipe needs an id: it is how the server and the browser name the same recipe. Try { id: 'forge-sword' }.",
    )
  }

  const requires = stacks(spec.requires, id, 'requires')
  const costs = stacks(spec.costs, id, 'costs')
  const grants = stacks(spec.grants, id, 'grants')
  const strategy = strategyFor(id, costs, grants)
  const sink = sinkFor(id, spec.sink, costs, grants)

  return Object.freeze({
    id,
    name: spec.name === undefined ? id : String(spec.name),
    ...(spec.description === undefined ? {} : { description: String(spec.description) }),
    strategy,
    requires,
    costs,
    grants,
    sink,
    ...(spec.issuer === undefined ? {} : { issuer: assertAddress(spec.issuer, 'recipe issuer address') }),
    ...(spec.expiresIn === undefined ? {} : { expiresIn: spec.expiresIn }),
  })
}

/**
 * Whether this is something `defineRecipe()` produced, rather than an object
 * that merely has a `strategy` on it.
 *
 * `define()` skips revalidation for a real recipe so the catalogue keeps the
 * frozen object the shared file exported — identity is what makes "the server's
 * copy and the player's copy" a meaningful sentence. Everything else goes
 * through `defineRecipe()`, because a half-built recipe reaching `plan()` is a
 * `TypeError` deep in the resolver rather than a sentence at the call site.
 */
export function isRecipe(value: Recipe | RecipeSpec): value is Recipe {
  if (!Object.isFrozen(value)) return false
  const candidate = value as Partial<Recipe>
  return (
    typeof candidate.id === 'string' &&
    candidate.id !== '' &&
    typeof candidate.name === 'string' &&
    (candidate.strategy === 'grant' || candidate.strategy === 'sink' || candidate.strategy === 'exchange') &&
    (candidate.sink === 'burn' || candidate.sink === 'issuer') &&
    Array.isArray(candidate.requires) &&
    Array.isArray(candidate.costs) &&
    Array.isArray(candidate.grants)
  )
}

/** The common case: a whole catalogue at once, keyed by id. */
export function defineRecipes(specs: readonly RecipeSpec[]): Map<string, Recipe> {
  if (!Array.isArray(specs)) {
    fail('bad-recipe', 'defineRecipes() takes an array of recipes. Pass one recipe to defineRecipe() instead.')
  }
  const out = new Map<string, Recipe>()
  for (const spec of specs) {
    const recipe = defineRecipe(spec)
    if (out.has(recipe.id)) {
      fail(
        'duplicate-recipe',
        `Two recipes in this catalogue are both called "${recipe.id}", and an id is how the server and the browser agree on which one they mean. Rename one of them.`,
      )
    }
    out.set(recipe.id, recipe)
  }
  return out
}

function strategyFor(
  id: string,
  costs: readonly Stack[],
  grants: readonly Stack[],
): RecipeStrategy {
  if (costs.length === 0 && grants.length === 0) {
    fail(
      'empty-recipe',
      `Recipe "${id}" costs nothing and grants nothing, so running it would write no blocks. Give it costs (a sink), grants (a reward), or one of each (a shop or a craft).`,
    )
  }
  if (costs.length === 0) return 'grant'
  if (grants.length === 0) return 'sink'
  if (costs.length === 1 && grants.length === 1) return 'exchange'

  fail(
    'not-one-block',
    `Recipe "${id}" takes ${costs.length} ${plural(costs.length, 'asset')} and gives ${grants.length}, and a swap moves exactly one asset each way (SPEC §9.2) — so no single block can settle it, and every way of splitting it leaves somebody who paid and did not receive. Two ways round it: price the recipe in one currency, so the player spends 30 SCRAP rather than 3 IRON and 2 WOOD; or split it into a sink recipe the player runs and a reward recipe your server runs, and be explicit with players that those are two separate steps.`,
  )
}

function sinkFor(
  id: string,
  sink: SinkPolicy | undefined,
  costs: readonly Stack[],
  grants: readonly Stack[],
): SinkPolicy {
  if (sink !== undefined && sink !== 'burn' && sink !== 'issuer') {
    fail(
      'bad-sink',
      `sink is 'burn' or 'issuer' — got "${String(sink)}". 'burn' destroys what the recipe costs, which is the sink a currency needs; 'issuer' sends it to the issuer's wallet.`,
    )
  }
  // A recipe that costs nothing has nothing to sink, so the field says 'burn'
  // and means nothing rather than claiming the issuer receives something.
  if (costs.length === 0 || grants.length === 0) return sink ?? 'burn'
  if (sink === 'burn') {
    fail(
      'bad-sink',
      `Recipe "${id}" grants something, so it settles as a swap and its costs are the other leg — they land in the issuer's wallet, and no block can burn them on the way (SPEC §9.2). Drop sink: 'burn' here, and burn them from the issuer afterwards with token.burn().`,
    )
  }
  return 'issuer'
}

function stacks(input: readonly Stack[] | undefined, id: string, field: string): readonly Stack[] {
  if (input === undefined) return Object.freeze([])
  if (!Array.isArray(input)) {
    fail(
      'bad-recipe',
      `Recipe "${id}" has a ${field} that is not an array. It looks like ${field}: [{ asset: gems, amount: 50 }].`,
    )
  }
  return Object.freeze(input.map((stack, index) => normalizeStack(stack, id, field, index)))
}

function normalizeStack(stack: Stack, id: string, field: string, index: number): Stack {
  const where = `${field}[${index}] of recipe "${id}"`
  if (!stack || typeof stack !== 'object') {
    fail('bad-stack', `${where} is not an object. Each entry looks like { asset: gems, amount: 50 }.`)
  }
  assertRef(stack.asset, where)
  if (stack.amount === undefined) return Object.freeze({ asset: stack.asset, amount: 1 })

  // Amounts are checked against the asset's own decimals at plan time, once the
  // chain has said how many it has. This is only the shape.
  const amount = stack.amount
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount) || amount <= 0) {
      fail('bad-amount', `The amount in ${where} must be a positive number — got ${String(amount)}.`)
    }
  } else if (typeof amount === 'string') {
    // At least one digit, or `'.'` and `'+'` are decimals: they match the shape
    // and `Number()` answers NaN, which is not `<= 0`.
    const text = amount.trim()
    if (!/^\+?\d*(?:\.\d*)?$/.test(text) || !/\d/.test(text) || Number(text) <= 0) {
      fail('bad-amount', `The amount in ${where} must be a positive decimal like '1.5' — got "${amount}".`)
    }
  } else {
    fail('bad-amount', `The amount in ${where} is a number or a decimal string — got ${typeof amount}.`)
  }
  return Object.freeze({ asset: stack.asset, amount })
}

function assertRef(asset: AssetRef | undefined, where: string): void {
  if (typeof asset === 'string') {
    if (asset.trim() === '') {
      fail('bad-asset', `${where} names an empty asset. Use 'KEI', an asset id, or the token object itself.`)
    }
    return
  }
  if (asset && typeof asset === 'object') {
    if ('id' in asset && typeof asset.id === 'string' && asset.id !== '') return
    if ('symbol' in asset && typeof asset.symbol === 'string' && asset.symbol.trim() !== '') return
  }
  fail(
    'bad-asset',
    `${where} does not name an asset. Pass the token or item object, an asset id, 'KEI', or { symbol: 'GEM', issuer: gameAddress } for a recipe written before the token exists.`,
  )
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`
}
