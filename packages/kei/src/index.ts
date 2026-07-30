/**
 * `kei-transaction` — the umbrella package, and the default install.
 *
 *   import { Kei } from 'kei-transaction'
 *
 *   const kei = await Kei.start()          // wallet created, persisted, funded
 *   await kei.send('kei_3abc...', 0.001)   // sub-cent, instant, feeless
 *
 * Sub-packages (`@kei/core`, `@kei/tokens`, `@kei/claims`, `@kei/work`,
 * `@kei/wallet`) exist for people who care about bundle size, not as a puzzle
 * everyone must solve (SPEC §10.1).
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
export { assertServerOnly, isServerRuntime, looksLikeBrowser } from './environment.js'
export { defaultSeedStore, seedStoreKey } from './storage.js'
export type { SeedStore } from './storage.js'

// Re-export the common surface, so an integration never has to reach past the
// umbrella for a type or a helper it can see in its own editor.
export {
  ADDRESS_PREFIX,
  HttpNode,
  ISSUANCE_BURN,
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
} from '@kei/core'
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
  SwapPolicy,
  TransferPolicy,
  WorkTier,
} from '@kei/core'

export { buildCommit } from '@kei/claims'
export type { ClaimBundle, ClaimResult, ClaimsApi, CommitEntry, PendingClaim } from '@kei/claims'

export { MockIpfsUploader, itemSymbolFor, looksLikeItem } from '@kei/tokens'
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
} from '@kei/tokens'

export { LocalWorkProvider, WorkServerProvider, createWorkProvider } from '@kei/work'
export { createWallet } from '@kei/wallet'
export type { ItemHolding, TokenBalance, WalletApi, WalletSummary } from '@kei/wallet'
