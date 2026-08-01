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
export { defaultSeedStore, seedStoreKey } from './storage.js'
export type { SeedStore } from './storage.js'

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

export { createMarket, durationMs } from '@keicoin/market'
export type {
  BidOptions,
  Cancellation,
  ListOptions,
  MarketApi,
  MarketOptions,
  MineOptions,
  Offer,
  OfferLeg,
  OfferOptions,
  OfferState,
  PriceSummary,
  SellOptions,
  Settlement,
  Trade,
  TradeOptions,
} from '@keicoin/market'

export { LocalWorkProvider, WorkServerProvider, createWorkProvider } from '@keicoin/work'
export { createWallet } from '@keicoin/wallet'
export type { ItemHolding, TokenBalance, WalletApi, WalletSummary } from '@keicoin/wallet'
