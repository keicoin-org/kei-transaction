/**
 * `@keicoin/economy` — the systems every game economy needs, declared rather
 * than hand-wired.
 *
 *   import { defineRecipe } from '@keicoin/economy'
 *
 *   export const forgeSword = defineRecipe({
 *     id: 'forge-sword',
 *     costs:  [{ asset: { symbol: 'SCRAP' }, amount: 30 }],
 *     grants: [{ asset: { symbol: 'SWORD' } }],
 *     issuer: GAME_ADDRESS,
 *   })
 *
 * The server stocks it (`economy.stock('forge-sword', { count: 20 })`), the
 * browser runs it (`economy.run('forge-sword')`), and the scrap and the sword
 * change hands in one block or not at all. Nothing in between holds a balance.
 *
 * It is bundled into `kei-transaction`, so `kei.economy` is already there; this
 * package exists for people who care about bundle size (SPEC §10.1).
 */

export { defineRecipe, defineRecipes } from './recipe.js'
export type { AssetRef, Recipe, RecipeSpec, RecipeStrategy, SinkPolicy, Stack } from './recipe.js'

export { createEconomy } from './economy.js'
export type {
  EconomyApi,
  EconomyOptions,
  ListingOptions,
  RunBlock,
  RunOptions,
  RunResult,
  StockOptions,
} from './economy.js'

export { acceptableBy, assertRunnable, matchingOffers, termsMatch } from './plan.js'
export type {
  MatchTerms,
  Plan,
  PlanAction,
  PlanContext,
  PlanOptions,
  PlanStep,
  Problem,
} from './plan.js'

export { isResolved } from './assets.js'
export type { ResolvedStack } from './assets.js'
