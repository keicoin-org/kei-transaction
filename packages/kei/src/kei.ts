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
  fail,
  keyPairFromSeed,
  normalizeSeed,
  randomSeed,
} from '@keicoin/core'
import { createClaims, type ClaimsApi } from '@keicoin/claims'
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
  type PlayerItemsApi,
  type PlayerToken,
} from '@keicoin/tokens'
import { createWorkProvider } from '@keicoin/work'
import { createWallet, type WalletApi } from '@keicoin/wallet'

import { assertServerOnly } from './environment.js'
import { defaultSeedStore, environmentSeed, seedStoreKey, type SeedStore } from './storage.js'

const DEFAULT_TESTNET_NODE_URL = 'https://rpc.testnet.keicoin.org/rpc'

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
  /** A work server, so proof-of-work does not pause the game (SPEC §5.5). */
  workServer?: string
  storage?: SeedStore
  /** Where item images go. Defaults to a local stand-in until M4. */
  uploader?: IpfsUploader
}

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
  mint(item: AssetId, owner: string): Promise<{ id: AssetId; hash: string; owner: string }>
  commit(entries: readonly ItemCommitEntry[]): ReturnType<IssuerItemsApi['commit']>
  token(item: AssetId): Promise<IssuerToken>
}

export class Kei {
  readonly client: KeiClient
  readonly network: NetworkName
  readonly role: Role
  readonly token: TokenNamespace
  readonly items: ItemsNamespace
  readonly claims: ClaimsApi
  readonly wallet: WalletApi

  private constructor(client: KeiClient, options: { uploader?: IpfsUploader; autoClaim?: boolean }) {
    this.client = client
    this.network = client.node.network
    this.role = client.role

    this.claims = createClaims(client, options.autoClaim === false ? { autoClaim: false } : {})
    this.wallet = createWallet(client, { claims: this.claims })

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
    const keys = await resolvePlayerKeys(options, node.network)
    return Kei.assemble(node, keys, 'player', options)
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
    const keys = await keyPairFromSeed(normalizeSeed(options.seed, 'issuer seed'), options.index ?? 0)
    return Kei.assemble(node, keys, 'issuer', options)
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
    options: StartOptions,
  ): Promise<Kei> {
    const work: WorkProvider = createWorkProvider(node, options.workServer ? { workServer: options.workServer } : {})
    const client = new KeiClient({
      node,
      work,
      keys,
      role,
      ...(options.reveal === undefined ? {} : { reveal: options.reveal }),
    })
    const kei = new Kei(client, {
      ...(options.uploader === undefined ? {} : { uploader: options.uploader }),
      ...(options.autoClaim === undefined ? {} : { autoClaim: options.autoClaim }),
    })
    await client.start(options.autoReceive === false ? { autoReceive: false } : {})
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
      const units = floorTo(payment.amount * rate, token.decimals)
      if (units <= 0) return
      await token.mint(payment.from, units)
    })
  }

  close(): void {
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
function floorTo(value: number, decimals: number): number {
  const scale = 10 ** decimals
  return Math.floor(value * scale) / scale
}

async function resolveNode(options: StartOptions): Promise<KeiNode> {
  if (options.node && typeof options.node === 'object') return options.node
  if (typeof options.node === 'string') {
    return new HttpNode({ url: options.node, network: options.network ?? 'testnet' })
  }
  if (options.network === 'mainnet') {
    fail(
      'no-mainnet',
      'Kei mainnet does not exist yet. Use the default testnet, or pass node: <url> for a network you run.',
    )
  }
  // `mock` remains an explicit offline-development choice. The default is the
  // real M3 testnet, which is the transport swap this API was designed around.
  if (options.network === 'mock') return MockNode.create()
  return new HttpNode({ url: DEFAULT_TESTNET_NODE_URL, network: 'testnet' })
}

async function resolvePlayerKeys(options: StartOptions, network: NetworkName): Promise<KeyPair> {
  if (options.seed) return keyPairFromSeed(normalizeSeed(options.seed), options.index ?? 0)

  const store = options.storage ?? defaultSeedStore()
  const key = seedStoreKey(network)
  const existing = store.read(key) ?? environmentSeed()
  if (existing) return keyPairFromSeed(normalizeSeed(existing, 'stored seed'), options.index ?? 0)

  const seed = randomSeed()
  store.write(key, seed)
  return keyPairFromSeed(seed, options.index ?? 0)
}

export { KEI_DECIMALS }
