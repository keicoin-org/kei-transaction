/**
 * `Kei` is the whole public API (SPEC §6.7). Naming is deliberately dull: every
 * method does one obvious thing, and nothing in here says "block", "frontier",
 * "representative", or "raw".
 *
 * Two entry points, because a private key can only sign for its own account
 * (SPEC §6.3): `Kei.start()` is the player in the browser, `Kei.server()` is the
 * game on a server. There is deliberately no `charge(someoneElse, ...)`.
 */

import type {
  AssetId,
  ClientEvents,
  KeiNode,
  KeyPair,
  NetworkName,
  PaymentEvent,
  RevealPolicy,
  Role,
  WorkProvider,
} from '@keicoin/core'
import {
  HttpNode,
  KEI_DECIMALS,
  KeiClient,
  MockNode,
  formatRaw,
  fail,
  keyPairFromSeed,
  normalizeSeed,
  randomSeed,
} from '@keicoin/core'
import { createClaims, type ClaimStore, type DurableClaimsApi } from '@keicoin/claims'
import {
  createIssuerItems,
  createPlayerItems,
  issueToken,
  readToken,
  type IpfsUploader,
  type IssueOptions,
  type IssuerItemsApi,
  type IssuerToken,
  type Item,
  type ItemCommitEntry,
  type MintedItem,
  type MintItemOptions,
  type PlayerItemsApi,
  type PlayerToken,
} from '@keicoin/tokens'
import { createMarket, type MarketApi } from '@keicoin/market'
import {
  createEconomy,
  type DropTable,
  type DropTableSpec,
  type EconomyApi,
  type Recipe,
  type RecipeSpec,
} from '@keicoin/economy'
import {
  createPlayerEconomy,
  type PlayerEconomyApi,
  type PlayerEconomyOptions,
} from '@keicoin/player-economy'
import { createWorkProvider, type WorkOptions } from '@keicoin/work'
import { createWallet, type WalletApi } from '@keicoin/wallet'

import { assertServerOnly, deploymentSignal, testnetAllowedInDeployment } from './environment.js'
import {
  defaultSeedStore,
  describeCustody,
  environmentSeed,
  persistSeed,
  readDurability,
  readSeed,
  seedStoreKey,
  type SeedCustody,
  type SeedStore,
} from './storage.js'

const DEFAULT_TESTNET_NODE_URL = 'https://testnet.keicoin.org/rpc'

export interface StartOptions {
  /**
   * `'mock'` is for a node URL serving `mockRpcHandler` — a mock is a real
   * network once it is served, and calling it 'testnet' would hide that
   * (decisions-m0 §11). Nothing here is checked against the node; M3 is where a
   * node gets asked what it is.
   */
  network?: NetworkName
  /** A node URL, or a `KeiNode` — pass the same `MockNode` to share one ledger. */
  node?: string | KeiNode
  /** Generated and persisted if absent. */
  seed?: string
  /** Which account in the seed. Defaults to 0. */
  index?: number
  /** Whether a player can see their own seed (SPEC §6.6). */
  reveal?: RevealPolicy
  /** Collect incoming Kei and assets automatically. Default true. */
  autoReceive?: boolean
  /** Claim entitlements in the background as proofs arrive. Default true. */
  autoClaim?: boolean
  /**
   * Where this wallet retains off-chain claim proofs. The default is memory,
   * preserving existing behaviour; inject a durable adapter for reload recovery.
   * The store receives public bundle metadata, never this wallet's seed or key.
   */
  claimStore?: ClaimStore
  /**
   * Cancel this wallet's own expired offers in the background (SPEC §9.3).
   * Default true — an expiry is advisory, so a cancel is the only thing that
   * frees the lock and takes the listing off the ledger.
   */
  autoCancelExpired?: boolean
  /**
   * A work server, so proof-of-work does not pause the game (SPEC §5.5). A URL
   * on its own is the usual form. If the server wants a token, use the object
   * form and put the token in a header rather than in the URL: the URL is what
   * an error message names, and a header is not.
   *
   * `{ url: 'https://work.example/', headers: { authorization: 'Bearer …' } }`
   */
  workServer?: string | { url: string; headers?: Record<string, string> }
  storage?: SeedStore
  /**
   * Refuse to start rather than hand back a wallet that a reload would lose
   * (SPEC §6.4). Default false, because a session-only wallet is still the
   * right thing for a demo, a test, or a player in private browsing — what is
   * never right is not saying so, which is what `kei.custody` is for.
   *
   * Turn it on where the wallet is meant to hold something: the error names the
   * reason and the fix, and it arrives before the address does rather than
   * after it has been funded.
   */
  requireDurableSeed?: boolean
  /** Where item images go. Defaults to a local stand-in until M4. */
  uploader?: IpfsUploader
  /**
   * The economy catalogue: rewards, sinks, shops and crafts, declared once in a
   * file both halves of the game import (SPEC §5.4, §9.2). Reaches
   * `kei.economy`, and more can be added later with `economy.define()`.
   */
  recipes?: Iterable<Recipe | RecipeSpec>
  /**
   * The loot tables, from the same shared file (SPEC §5.5). The server rolls
   * them and publishes one block per batch; the browser registers them so it can
   * check that a batch really was published for the odds it was shown, before it
   * claims anything.
   */
  tables?: Iterable<DropTable | DropTableSpec>
  /**
   * The player's own shop: what it prices in, what this world deals in, and
   * which chains to read when browsing (SPEC §9.1, §9.4). Reaches `kei.shop`.
   *
   * Everything about it is optional — a shop with no options prices in Kei and
   * reads only the accounts it has been told about.
   */
  shop?: ShopSetup
}

/** `PlayerEconomyOptions` minus the market, which `Kei` always supplies its own. */
export type ShopSetup = Omit<PlayerEconomyOptions, 'market'>

export interface ServerOptions extends StartOptions {
  /** Required. The game's issuer seed — server-side only, always (SPEC §6.3). */
  seed: string
}

export interface PayOptions {
  to: string
  amount: number | string
  memo?: string
}

export interface Receipt {
  hash: string
  to: string
  amount: number
  memo?: string
}

export interface TopUpOptions {
  token: IssuerToken
  /** Units per Kei. Issuer configuration; never written to the chain (SPEC §5.4). */
  rate: number
  /** Ignore payments below this many Kei. */
  minimum?: number
}

/**
 * Callable *and* a namespace, so both spec spellings work:
 * `game.token.issue({...})` and `await kei.token('GEM', issuerAddress)`.
 */
export type TokenNamespace = ((symbolOrId: string, issuer?: string) => Promise<PlayerToken>) & {
  issue(options: IssueOptions): Promise<IssuerToken>
  get(symbolOrId: string, issuer?: string): Promise<PlayerToken>
}

export type ItemsNamespace = PlayerItemsApi & {
  create(options: Parameters<IssuerItemsApi['create']>[0]): Promise<Item>
  mint(item: AssetId, owner: string, options?: MintItemOptions): Promise<MintedItem>
  commit(entries: readonly ItemCommitEntry[]): ReturnType<IssuerItemsApi['commit']>
  token(item: AssetId): Promise<IssuerToken>
}

export class Kei {
  readonly client: KeiClient
  readonly network: NetworkName
  readonly role: Role
  readonly token: TokenNamespace
  readonly items: ItemsNamespace
  readonly claims: DurableClaimsApi
  readonly wallet: WalletApi
  /** Offers, atomic settlement, and price history read from the chain (SPEC §9). */
  readonly market: MarketApi
  /**
   * Rewards, sinks, shops and crafts, declared as recipes and dry-run first —
   * and loot tables, rolled into one issuer block a whole party claims from.
   */
  readonly economy: EconomyApi
  /**
   * This wallet's own stall, and everybody else's: list, buy, cancel, gift.
   *
   * The counterpart to `economy`, and the difference is who signs. `economy` is
   * the game's catalogue, stocked from the game's account. `shop` is the
   * player's, and nothing in it can be moved by the world it is embedded in.
   */
  readonly shop: PlayerEconomyApi
  /**
   * Where this wallet's seed came from and whether it survives a reload
   * (SPEC §6.4). `durability: 'session'` means memory only — the wallet works,
   * but a reload cannot find it again unless its seed was backed up separately.
   *
   * `WalletPanel` reads this and warns the player; a game drawing its own UI
   * should do the same before it lets a wallet hold anything.
   */
  readonly custody: SeedCustody

  private constructor(
    client: KeiClient,
    custody: SeedCustody,
    options: {
      uploader?: IpfsUploader
      autoClaim?: boolean
      claimStore?: ClaimStore
      autoCancelExpired?: boolean
      recipes?: Iterable<Recipe | RecipeSpec>
      tables?: Iterable<DropTable | DropTableSpec>
      shop?: ShopSetup
    },
  ) {
    this.client = client
    this.network = client.node.network
    this.role = client.role
    this.custody = custody

    this.claims = createClaims(client, {
      ...(options.autoClaim === false ? { autoClaim: false } : {}),
      ...(options.claimStore === undefined ? {} : { store: options.claimStore }),
    })
    this.wallet = createWallet(client, { claims: this.claims })
    this.market = createMarket(
      client,
      options.autoCancelExpired === false ? { autoCancelExpired: false } : {},
    )
    // Shares this market rather than opening a second one, so a recipe's offers
    // are swept by the same background cancel as everything else (SPEC §9.3).
    this.economy = createEconomy(client, {
      market: this.market,
      ...(options.recipes === undefined ? {} : { recipes: options.recipes }),
      ...(options.tables === undefined ? {} : { tables: options.tables }),
    })
    // Same market again, for the same reason: one background expiry sweep, and
    // a listing this shop writes is swept by it like any other (SPEC §9.3).
    this.shop = createPlayerEconomy(client, { ...(options.shop ?? {}), market: this.market })

    const get = (symbolOrId: string, issuer?: string): Promise<PlayerToken> =>
      readToken(client, symbolOrId, issuer)
    const token = get as TokenNamespace
    token.get = get
    token.issue = (issueOptions: IssueOptions) => issueToken(client, issueOptions)
    this.token = token

    const player = createPlayerItems(client)
    if (client.role === 'issuer') {
      const issuer = createIssuerItems(client, options.uploader ? { uploader: options.uploader } : {})
      this.items = { ...player, ...issuer, ownedBy: (address?: string) => player.ownedBy(address) }
    } else {
      // Async, because these are declared to return promises: a player calling
      // them should get a rejection to catch, not a synchronous throw.
      this.items = {
        ...player,
        create: async () => issuerOnly('items.create'),
        mint: async () => issuerOnly('items.mint'),
        commit: async () => issuerOnly('items.commit'),
        token: async () => issuerOnly('items.token'),
      }
    }
  }

  // ------------------------------------------------------------ entry points

  /** The player, in the browser. Self-provisions with no signup (SPEC §6.2, §12). */
  static async start(options: StartOptions = {}): Promise<Kei> {
    const node = await resolveNode(options)
    const { keys, custody } = await resolvePlayerKeys(options, node.network)
    if (options.requireDurableSeed && custody.durability === 'session') {
      fail(
        'seed-not-durable',
        `Kei.start({ requireDurableSeed: true }) is refusing to hand back a wallet nothing can keep. ${custody.message}`,
      )
    }
    return Kei.assemble(node, keys, 'player', custody, options)
  }

  /** The game, on a server. Refuses to run in a browser (SPEC §6.3). */
  static async server(options: ServerOptions): Promise<Kei> {
    assertServerOnly()
    if (!options?.seed) {
      fail(
        'no-issuer-seed',
        'Kei.server() needs your game\'s seed: Kei.server({ seed: process.env.KEI_SEED }). Generate one with randomSeed(), keep it on the server, and never ship it to a browser.',
      )
    }
    const node = await resolveNode(options)
    assertNetworkFitsDeployment(node.network)
    const keys = await keyPairFromSeed(normalizeSeed(options.seed, 'issuer seed'), options.index ?? 0)
    // An issuer seed is always the caller's: `Kei.server()` requires one and
    // this SDK never writes it anywhere (SPEC §6.3).
    return Kei.assemble(node, keys, 'issuer', describeCustody('supplied'), options)
  }

  /**
   * A private in-process chain for tests and offline development; pass the same
   * node to several clients to have them share one ledger.
   */
  static async mock(options: { faucetAmount?: number } = {}): Promise<MockNode> {
    return MockNode.create(options)
  }

  private static async assemble(
    node: KeiNode,
    keys: KeyPair,
    role: Role,
    custody: SeedCustody,
    options: StartOptions,
  ): Promise<Kei> {
    const work: WorkProvider = createWorkProvider(node, workOptions(options.workServer))
    const client = new KeiClient({
      node,
      work,
      keys,
      role,
      ...(options.reveal === undefined ? {} : { reveal: options.reveal }),
    })
    const kei = new Kei(client, custody, {
      ...(options.uploader === undefined ? {} : { uploader: options.uploader }),
      ...(options.autoClaim === undefined ? {} : { autoClaim: options.autoClaim }),
      ...(options.claimStore === undefined ? {} : { claimStore: options.claimStore }),
      ...(options.autoCancelExpired === undefined ? {} : { autoCancelExpired: options.autoCancelExpired }),
      ...(options.recipes === undefined ? {} : { recipes: options.recipes }),
      ...(options.tables === undefined ? {} : { tables: options.tables }),
      ...(options.shop === undefined ? {} : { shop: options.shop }),
    })
    await client.start(options.autoReceive === false ? { autoReceive: false } : {})
    // Proofs are hydrated only after the client is ready to reconcile the
    // ledger. A transient retry failure is retained and reported by claims.
    await kei.claims.ready()
    return kei
  }

  // ----------------------------------------------------------------- wallet

  get address(): string {
    return this.client.address
  }

  /** Export for backup. Subject to the reveal policy; never logged (SPEC §6.6). */
  get seed(): string {
    return this.client.seed
  }

  async balance(): Promise<number> {
    return this.client.balance()
  }

  async send(to: string, amount: number | string): Promise<Receipt> {
    return this.client.send(to, amount)
  }

  /** Testnet only. Throws on mainnet (SPEC §6.7). */
  async faucet(amount?: number | string): Promise<{ hash: string }> {
    return this.client.faucet(amount)
  }

  /**
   * Collect anything waiting, now, instead of waiting for the background
   * collector. Nothing needs this in a game loop; a test or a server job that
   * wants a settled balance before it reads one does.
   */
  async sync(): Promise<number> {
    return this.client.receiveAll()
  }

  on<Key extends keyof ClientEvents & string>(
    event: Key,
    listener: (payload: ClientEvents[Key]) => void,
  ): () => void {
    return this.client.on(event, listener)
  }

  off<Key extends keyof ClientEvents & string>(
    event: Key,
    listener: (payload: ClientEvents[Key]) => void,
  ): void {
    this.client.off(event, listener)
  }

  // --------------------------------------------------------------- purchases

  /**
   * The player half of a purchase: one signed transaction, from the player.
   * The confirmation dialog lands with the wallet panel at M6 (SPEC §6.8).
   */
  async pay(options: PayOptions): Promise<Receipt> {
    if (!options || typeof options !== 'object') {
      fail('bad-payment', 'kei.pay() takes { to, amount, memo? }.')
    }
    return this.client.send(options.to, options.amount, options.memo)
  }

  /** The issuer half: react to an incoming payment and deliver (SPEC §6.7). */
  onPayment(handler: (payment: PaymentEvent) => void | Promise<void>): () => void {
    return this.client.onPayment(handler)
  }

  /**
   * The common fixed-rate case, wrapped: Kei in, tokens minted out.
   *
   * `rate` is issuer configuration and never touches the chain, so repricing is
   * an ordinary config change rather than a migration (SPEC §5.4).
   */
  acceptTopUps(options: TopUpOptions): () => void {
    if (this.role !== 'issuer') {
      fail(
        'not-issuer-context',
        'Only the issuer can accept top-ups, because only the issuer can mint. Call this on the Kei.server() instance.',
      )
    }
    const { token, rate } = options
    if (!token || typeof rate !== 'number' || !(rate > 0)) {
      fail('bad-rate', 'acceptTopUps needs { token, rate } with a rate above zero, for example { token: gems, rate: 100 }.')
    }
    if (token.swap === 'off') {
      fail(
        'swap-off',
        `${token.symbol} was issued with swap: 'off', which tells players it cannot be bought at all (SPEC §5.4). That is on-chain and immutable, so accepting top-ups for it would break the promise it makes. Issue a token with swap: 'one-way' instead.`,
      )
    }
    const minimum = options.minimum ?? 0

    return this.onPayment(async (payment) => {
      if (payment.amount < minimum || payment.amount <= 0) return
      const units = multiplyFloor(payment.amount, rate, token.decimals)
      if (units <= 0n) return
      await token.mint(payment.from, formatRaw(units, token.decimals))
    })
  }

  close(): void {
    this.shop.close()
    this.market.close()
    this.client.close()
  }
}

function issuerOnly(method: string): never {
  fail(
    'not-issuer-context',
    `${method}() exists only on the issuer. A game cannot sign for a player's wallet (SPEC §6.3) — call it on your Kei.server() instance.`,
  )
}

/** Round down to what the token can actually represent. */
function multiplyFloor(value: number, multiplier: number, decimals: number): bigint {
  const amount = toDecimal(value, 'Top-up payment')
  const rate = toDecimal(multiplier, 'Top-up rate')
  const numerator = amount.coefficient * rate.coefficient
  const scaleDelta = amount.decimals + rate.decimals - decimals

  if (scaleDelta <= 0) {
    return numerator * 10n ** BigInt(-scaleDelta)
  }
  return numerator / 10n ** BigInt(scaleDelta)
}

/** Parse a decimal number into integer digits plus the number of scaled places. */
function toDecimal(value: number, label: string): { coefficient: bigint; decimals: number } {
  if (!Number.isFinite(value)) {
    fail('bad-amount', `${label} must be a finite number - got ${String(value)}.`)
  }
  const text = decimalString(value)
  if (text.startsWith('-')) {
    fail('bad-amount', `${label} cannot be negative - got ${text}.`)
  }
  const match = /^\+?(\d*)(?:\.(\d*))?$/.exec(text)
  if (!match || (match[1] === '' && (match[2] ?? '') === '')) {
    fail('bad-amount', `${label} must be a decimal number like 1.5 - got "${text}".`)
  }
  const whole = match[1] === '' ? '0' : match[1]
  const fraction = match[2] ?? ''
  return { coefficient: BigInt(whole + fraction), decimals: fraction.length }
}

/** Expand a JS number into a plain decimal string, exponent notation included. */
function decimalString(value: number): string {
  const text = String(value)
  if (!text.includes('e') && !text.includes('E')) return text

  const [mantissa = '0', exponentText = '0'] = text.toLowerCase().split('e')
  const exponent = Number(exponentText)
  const negative = mantissa.startsWith('-')
  const digits = mantissa.replace(/^[-+]/, '')
  const [whole = '0', fraction = ''] = digits.split('.')
  const flat = whole + fraction
  const pointAt = whole.length + exponent

  let out: string
  if (pointAt <= 0) out = '0.' + '0'.repeat(-pointAt) + flat
  else if (pointAt >= flat.length) out = flat + '0'.repeat(pointAt - flat.length)
  else out = flat.slice(0, pointAt) + '.' + flat.slice(pointAt)

  return (negative ? '-' : '') + out
}
/**
 * Testnet is the right place to build and the wrong place to ship. Its Kei is
 * not worth anything and its chain can be reset without notice, so a game that
 * reaches real players on testnet is one whose economy disappears on a day
 * nobody chose — which is the thing SPEC §5.9 asks nobody be encouraged into.
 *
 * So a deploy is pushed back on rather than warned about: it fires at boot, on
 * the server half, where the fix is one word and nobody has earned anything yet.
 * A warning at this point in a logfile is a warning nobody is reading.
 */
function assertNetworkFitsDeployment(network: NetworkName): void {
  if (network !== 'testnet') return
  const signal = deploymentSignal()
  if (signal === undefined || testnetAllowedInDeployment()) return
  fail(
    'testnet-in-deployment',
    `This looks like a deployment (${signal}) and your game is pointed at testnet. Testnet Kei is not worth anything and that chain can be reset without notice, so anything your players earn goes with it — move to mainnet before real players arrive: network: 'mainnet'. Kei mainnet is not open yet (SPEC §15), so until it is, keep this in front of testers who know the money is play money. Set KEI_ALLOW_TESTNET=1 to deploy on testnet anyway.`,
  )
}

async function resolveNode(options: StartOptions): Promise<KeiNode> {
  if (options.node && typeof options.node === 'object') return options.node
  if (typeof options.node === 'string') {
    return new HttpNode({ url: options.node, network: options.network ?? 'testnet' })
  }
  if (options.network === 'mainnet') {
    fail(
      'no-mainnet',
      'Kei mainnet is not open yet (SPEC §15) — it opens when the validator set is distributed enough that value is safe on it. Until then, build on the default testnet, or pass node: <url> for a network you run.',
    )
  }
  // `mock` remains an explicit offline-development choice. The default is the
  // real M3 testnet, which is the transport swap this API was designed around.
  if (options.network === 'mock') return MockNode.create()
  return new HttpNode({ url: DEFAULT_TESTNET_NODE_URL, network: 'testnet' })
}

function workOptions(workServer: StartOptions['workServer']): WorkOptions {
  if (!workServer) return {}
  if (typeof workServer === 'string') return { workServer }
  return {
    workServer: workServer.url,
    ...(workServer.headers ? { headers: workServer.headers } : {}),
  }
}

/**
 * The seed, and an honest account of where it came from (SPEC §6.4).
 *
 * The order matters and is unchanged: an explicit seed, then the store, then
 * the environment, then a new one. What is new is that the last case reports
 * whether the write survived — a generated seed nothing kept is a wallet that a
 * reload loses, and the one thing this must never do is hand that back looking
 * exactly like a saved one.
 */
async function resolvePlayerKeys(
  options: StartOptions,
  network: NetworkName,
): Promise<{ keys: KeyPair; custody: SeedCustody }> {
  const index = options.index ?? 0
  if (options.seed) {
    return { keys: await keyPairFromSeed(normalizeSeed(options.seed), index), custody: describeCustody('supplied') }
  }

  const store = options.storage ?? defaultSeedStore()
  const key = seedStoreKey(network)
  const stored = readSeed(store, key)
  if (stored) {
    return {
      keys: await keyPairFromSeed(normalizeSeed(stored, 'stored seed'), index),
      custody: describeCustody('restored', readDurability(store)),
    }
  }
  const fromEnvironment = environmentSeed()
  if (fromEnvironment) {
    return {
      keys: await keyPairFromSeed(normalizeSeed(fromEnvironment, 'seed from KEI_PLAYER_SEED'), index),
      custody: describeCustody('environment'),
    }
  }

  const seed = randomSeed()
  const written = persistSeed(store, key, seed)
  return { keys: await keyPairFromSeed(seed, index), custody: describeCustody('generated', written) }
}

export { KEI_DECIMALS }

