/**
 * `kei-transaction` — the umbrella package, and the default install.
 *
 *   import { Kei } from 'kei-transaction'
 *
 *   const kei = await Kei.start()          // wallet created, persisted, funded
 *   await kei.send('kei_3abc...', 0.001)   // sub-cent, instant, feeless
 *
 * Sub-packages (`@keicoin/core`, `@keicoin/tokens`, `@keicoin/claims`, `@keicoin/market`,
 * `@keicoin/work`, `@keicoin/wallet`) exist for people who care about bundle size,
 * not as a puzzle everyone must solve (SPEC §10.1).
 */

export { Kei } from './kei.js'
export type {
  ItemsNamespace,
  PayOptions,
  Receipt,
  ServerOptions,
  ShopSetup,
  StartOptions,
  TokenNamespace,
  TopUpOptions,
} from './kei.js'
export {
  assertServerOnly,
  deploymentSignal,
  isServerRuntime,
  looksLikeBrowser,
  testnetAllowedInDeployment,
} from './environment.js'
export { defaultSeedStore, describeCustody, persistSeed, readSeed, seedStoreKey } from './storage.js'
export type {
  SeedCustody,
  SeedDurability,
  SeedOrigin,
  SeedSessionReason,
  SeedStore,
  SeedWriteResult,
} from './storage.js'

// Re-export the common surface, so an integration never has to reach past the
// umbrella for a type or a helper it can see in its own editor.
export {
  ADDRESS_PREFIX,
  HttpNode,
  issuanceBurn,
  KEI_ASSET,
  KEI_DECIMALS,
  KEI_TOTAL_SUPPLY,
  KeiClient,
  KeiError,
  MockNode,
  NULL_REPRESENTATIVE,
  addressFromPublicKey,
  isAddress,
  isSeed,
  keyPairFromSeed,
  mockRpcHandler,
  publicKeyFromAddress,
  randomSalt,
  randomSeed,
} from '@keicoin/core'
export type {
  AccountInfo,
  AssetId,
  AssetInfo,
  Block,
  ClientEvents,
  CommitInfo,
  Holding,
  KeiNode,
  KeyPair,
  MockRpcOptions,
  NetworkName,
  PaymentEvent,
  Receivable,
  RevealPolicy,
  Role,
  SwapOffer,
  SwapPolicy,
  SwapState,
  TransferPolicy,
  WorkTier,
} from '@keicoin/core'

export { buildCommit } from '@keicoin/claims'
export type { ClaimBundle, ClaimResult, ClaimsApi, CommitEntry, PendingClaim } from '@keicoin/claims'

export { MockIpfsUploader, itemSymbolFor, looksLikeItem } from '@keicoin/tokens'
export type {
  CreateItemOptions,
  ImageSource,
  IpfsUploader,
  IssueOptions,
  IssuerToken,
  Item,
  ItemCommitEntry,
  PlayerToken,
  PublishedCommit,
  TokenTransfer,
} from '@keicoin/tokens'

export {
  DEFAULT_DIRECTORY_LIMIT,
  assertMatches,
  bidPrice,
  classify,
  createDirectory,
  createMarket,
  durationMs,
  expectationFrom,
  isDirectory,
  isRace,
  priceIndex,
  readBook,
  reconcileOffers,
  resolveAccounts,
  settleable,
  toCandles,
  toSeries,
  verify,
} from '@keicoin/market'
export type {
  AcceptOptions,
  AccountDirectory,
  AccountSource,
  BidOptions,
  Book,
  BookOptions,
  Cancellation,
  Candle,
  CandleOptions,
  Change,
  Coverage,
  DirectoryOptions,
  Expectation,
  ListOptions,
  MarketApi,
  MarketOptions,
  MineOptions,
  MutableDirectory,
  Offer,
  OfferLeg,
  OfferLife,
  OfferOptions,
  OfferState,
  PriceSummary,
  PricePoint,
  Reconciliation,
  SellOptions,
  Series,
  SeriesOptions,
  Settlement,
  Trade,
  TradeOptions,
  Verification,
} from '@keicoin/market'

export {
  acceptableBy,
  assertAwardShape,
  assertRunnable,
  checkDropBinding,
  createEconomy,
  defineDropTable,
  defineDropTables,
  defineRecipe,
  defineRecipes,
  dropNonce,
  dropSalt,
  foldProof,
  isDropTable,
  isResolved,
  matchingOffers,
  publishDrop,
  rollDropTable,
  termsMatch,
  verifyAward,
} from '@keicoin/economy'
export type {
  AssetRef,
  CloseOptions,
  Drop,
  DropAward,
  DropOptions,
  DropOutcome,
  DropRoot,
  DropSpec,
  DropTable,
  DropTableSpec,
  EconomyApi,
  EconomyOptions,
  ListingOptions,
  MatchTerms,
  Odds,
  PublishedDrop,
  PlanContext,
  Plan,
  PlanAction,
  PlanOptions,
  PlanStep,
  Problem,
  Recipe,
  RecipeSpec,
  RecipeStrategy,
  ResolvedStack,
  RunBlock,
  RunOptions,
  RunResult,
  SinkPolicy,
  Stack,
  StockOptions,
  VerifiedDrop,
} from '@keicoin/economy'

export {
  canSpend,
  committedRaw,
  createCatalogue,
  createPlayerEconomy,
  movingRaw,
  toFunds,
} from '@keicoin/player-economy'
export type {
  BrowseOptions,
  BuyOptions,
  Catalogue,
  ChainFunds,
  Currency,
  Funds,
  Gift,
  GiftRequest,
  HistoryOptions,
  Listing,
  ListingRequest,
  Pending,
  PendingKind,
  PlayerEconomyApi,
  PlayerEconomyOptions,
  Purchase,
  Reconciled,
  Shelf,
  Shelves,
  ShopEvents,
  Ware,
  WareSpec,
} from '@keicoin/player-economy'

export { LocalWorkProvider, WorkServerProvider, createWorkProvider } from '@keicoin/work'
export { WalletPanel, createWallet } from '@keicoin/wallet'
export type {
  ItemHolding,
  TokenBalance,
  WalletApi,
  WalletPanelCustody,
  WalletPanelHandle,
  WalletPanelKei,
  WalletPanelOptions,
  WalletPanelSection,
  WalletPanelTheme,
  WalletPanelThemeVars,
  WalletSummary,
} from '@keicoin/wallet'
