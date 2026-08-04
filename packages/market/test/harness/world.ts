/**
 * A deterministic market world over the mock ledger, built from `@keicoin/core`
 * alone — the market's own declared dependency — so the harness exercises
 * `createMarket` against the same node contract every runtime gets, without
 * importing the umbrella package this package must not depend on.
 *
 * Determinism, spelled out:
 *
 * - **Seeds are fixed**, derived from a per-world counter, so a failing run
 *   replays with the same addresses in the same roles.
 * - **The clock is injected.** `MockLedger` and `createMarket` both take a
 *   `now`, and consensus reads neither (the chain has no clock — SPEC §5.5),
 *   so a test moves time by assignment instead of sleeping.
 * - **Every scheduling decision is explicit.** Races go through `GateNode`
 *   (see `net.ts`); nothing here waits on a timer except the expiry-sweep
 *   suite, whose timers the market itself owns.
 */

import type {
  AssetId,
  KeiNode,
  SwapPolicy,
  TransferPolicy,
  WorkProvider,
} from '@keicoin/core'
import {
  KEI_ASSET,
  KEI_DECIMALS,
  KeiClient,
  MOCK_THRESHOLDS,
  MockNode,
  addressFromPublicKey,
  deriveAssetId,
  generateWork,
  issuanceBurn,
  keyPairFromSeed,
  publicKeyFromAddress,
  toRaw,
} from '@keicoin/core'
import { createMarket, type MarketApi, type MarketOptions } from '@keicoin/market'

/** Manual time. `tick()` moves it; nothing else does. */
export class Clock {
  at = 1_754_000_000_000
  readonly now = (): number => this.at
  tick(ms: number): number {
    this.at += ms
    return this.at
  }
}

const work: WorkProvider = {
  async generate(root, tier) {
    return generateWork(root, BigInt(MOCK_THRESHOLDS[tier]))
  },
}

/** One account with a market over whichever node shape the scenario needs. */
export interface Actor {
  name: string
  address: string
  client: KeiClient
  market: MarketApi
}

export interface ActorOptions {
  /** A wrapped node (counting, faulting, gated…). Defaults to the honest mock. */
  node?: KeiNode
  market?: MarketOptions
  /** Kei to fund with. Default 2,000; 0 skips the faucet. */
  kei?: number
}

export interface IssueOptions {
  symbol: string
  name?: string
  decimals?: number
  transfer?: TransferPolicy
  swap?: SwapPolicy
  maxSupply?: string | null
}

export class World {
  readonly clock = new Clock()
  node!: MockNode
  issuer!: Actor
  private readonly actors: Actor[] = []
  private seedCounter = 0

  static async create(): Promise<World> {
    const world = new World()
    world.node = await MockNode.create({ now: world.clock.now })
    world.issuer = await world.actor('issuer', { kei: 100_000 })
    return world
  }

  /**
   * A funded account whose market runs over `options.node` — the seam every
   * adversarial scenario plugs into. Markets default to `autoCancelExpired:
   * false` so no test has a background writer it did not ask for.
   */
  async actor(name: string, options: ActorOptions = {}): Promise<Actor> {
    const seed = (this.seedCounter++).toString(16).toUpperCase().padStart(2, '0').repeat(32)
    const keys = await keyPairFromSeed(seed, 0)
    const client = new KeiClient({
      node: options.node ?? this.node,
      work,
      keys,
      role: 'player',
    })
    const market = createMarket(client, {
      autoCancelExpired: false,
      now: this.clock.now,
      ...options.market,
    })
    const actor: Actor = { name, address: keys.address, client, market }
    this.actors.push(actor)
    const kei = options.kei ?? 2_000
    if (kei > 0) {
      await this.node.faucet(actor.address, toRaw(kei, KEI_DECIMALS).toString())
      await client.receiveAll()
    }
    return actor
  }

  /** Issue a 0-decimals open token from the issuer and return its id. */
  async issue(options: IssueOptions): Promise<AssetId> {
    const info = await this.node.accountInfo(this.issuer.address)
    const burn = issuanceBurn(info?.issuedCount ?? 0)
    await this.issuer.client.submitAsset(
      {
        kind: 'issue',
        name: options.name ?? options.symbol,
        symbol: options.symbol,
        decimals: options.decimals ?? 0,
        maxSupply: options.maxSupply ?? null,
        transfer: options.transfer ?? 'open',
        swap: options.swap ?? 'off',
      },
      -burn,
    )
    return deriveAssetId(publicKeyFromAddress(this.issuer.address), options.symbol)
  }

  /** Mint to an actor and collect it, so the units are spendable on return. */
  async mint(asset: AssetId, to: Actor, amount: number | string): Promise<void> {
    await this.issuer.client.submitAsset({
      kind: 'mint',
      asset,
      to: to.address,
      amount: String(amount),
    })
    await to.client.receiveAll()
  }

  /**
   * The conservation invariant, checked through public node reads only: for
   * each asset, everything ever minted is either held, in flight as a
   * receivable to somebody in the cast, or locked in an open offer — and
   * nothing else. Any interleaving of offers, accepts, cancels and sweeps
   * must leave this true, or the ledger lost or invented units.
   */
  async audit(assets: AssetId[]): Promise<{ ok: boolean; lines: string[] }> {
    const lines: string[] = []
    let ok = true
    const cast = this.actors.map((actor) => actor.address)

    for (const asset of assets) {
      const info = await this.node.assetInfo(asset)
      if (!info) {
        ok = false
        lines.push(JSON.stringify({ asset, error: 'no-such-asset' }))
        continue
      }
      let held = 0n
      for (const holder of await this.node.holders(asset)) held += BigInt(holder.balance)
      let receivable = 0n
      let locked = 0n
      for (const address of cast) {
        for (const entry of await this.node.receivables(address)) {
          if (entry.asset === asset) receivable += BigInt(entry.amount)
        }
        for (const offer of await this.node.accountSwaps(address, { state: 'open' })) {
          if (offer.asset === asset) locked += BigInt(offer.amount)
        }
      }
      const accounted = held + receivable + locked
      const circulating = BigInt(info.circulating)
      if (accounted !== circulating) ok = false
      lines.push(
        JSON.stringify({
          asset: info.symbol,
          circulating: circulating.toString(),
          held: held.toString(),
          receivable: receivable.toString(),
          locked: locked.toString(),
          conserved: accounted === circulating,
        }),
      )
    }
    return { ok, lines }
  }

  /** Kei raw balance by public read, for exact before/after comparisons. */
  async keiRaw(address: string): Promise<bigint> {
    const info = await this.node.accountInfo(address)
    return info ? BigInt(info.balance) : 0n
  }

  close(): void {
    for (const actor of this.actors) {
      actor.market.close()
      actor.client.close()
    }
  }
}

/**
 * A cheap valid address that owns no key — for directory-scale tests, where
 * deriving ten thousand ed25519 pairs would be all of the runtime for none of
 * the point. The checksum is real, so `isAddress` accepts it.
 */
export function syntheticAddress(index: number): string {
  return addressFromPublicKey(index.toString(16).toUpperCase().padStart(64, '0'))
}

/** Machine-readable context for an assertion message: one JSON line. */
export function evidence(label: string, data: unknown): string {
  return `${label} ${JSON.stringify(data)}`
}

/**
 * Wait for a condition the market's own (real) timers will bring about, with
 * a hard deadline. Used only by the expiry suite: the assertion is on the
 * eventual state, never on how long it took, so a slow CI box passes late
 * rather than failing flaky.
 */
export async function until(
  condition: () => Promise<boolean> | boolean,
  options: { timeout?: number; label?: string } = {},
): Promise<void> {
  const timeout = options.timeout ?? 2_000
  const start = Date.now()
  for (;;) {
    if (await condition()) return
    if (Date.now() - start > timeout) {
      throw new Error(`Timed out after ${timeout}ms waiting for: ${options.label ?? 'condition'}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export { KEI_ASSET }
