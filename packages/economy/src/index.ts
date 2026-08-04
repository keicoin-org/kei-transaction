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
 * Loot is the other half, and it is declared the same way:
 *
 *   export const dragonHoard = defineDropTable({
 *     id: 'dragon-hoard',
 *     drops: [
 *       { asset: { symbol: 'GOLD' }, amount: 50, weight: 60 },
 *       { asset: { symbol: 'SWORD' },             weight: 9 },
 *     ],
 *     nothing: 31,
 *     issuer: GAME_ADDRESS,
 *   })
 *
 * The server rolls it (`economy.drop('dragon-hoard', party)`) and publishes one
 * block for the whole party; each player claims from their own account, in
 * parallel. The table's digest is bound into that block, so the browser can
 * check the batch was published for the odds it was shown before it claims
 * anything (`economy.verifyDrop`).
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

export {
  assertAwardShape,
  checkDropBinding,
  defineDropTable,
  defineDropTables,
  dropNonce,
  dropSalt,
  foldProof,
  isDropTable,
  rollDropTable,
} from './drops.js'
export type {
  Drop,
  DropAward,
  DropSpec,
  DropTable,
  DropTableSpec,
  Odds,
  VerifiedDrop,
} from './drops.js'

export { publishDrop, verifyAward } from './batch.js'
export type {
  CloseOptions,
  DropOptions,
  DropOutcome,
  DropRoot,
  PublishedDrop,
} from './batch.js'
