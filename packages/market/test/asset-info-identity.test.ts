/**
 * Asset metadata is descriptive, never authoritative for identity.
 *
 * These probes put a real asset-B response behind an asset-A lookup. The mock
 * ledger stays honest; only the node boundary lies, which is the failure mode a
 * stale proxy or index can produce in practice.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { KeiError, type AssetId, type AssetInfo } from '@keicoin/core'
import { createMarket, isMarketError, type MarketApi } from '@keicoin/market'

import { CountingNode } from './harness/net.js'
import { World, type Actor } from './harness/world.js'

class ControlledAssetInfoNode extends CountingNode {
  readonly requests: AssetId[] = []
  mismatch = false

  private gate: Promise<void> | null = null
  private releaseGate: (() => void) | null = null
  private entered: Promise<void> | null = null
  private markEntered: (() => void) | null = null

  constructor(
    inner: ConstructorParameters<typeof CountingNode>[0],
    private readonly requested: AssetId,
    private readonly returned: AssetId,
  ) {
    super(inner)
  }

  resetEvidence(): void {
    super.reset()
    this.requests.length = 0
  }

  holdNextLookup(): void {
    this.entered = new Promise((resolve) => {
      this.markEntered = resolve
    })
    this.gate = new Promise((resolve) => {
      this.releaseGate = resolve
    })
  }

  async waitUntilHeld(): Promise<void> {
    const entered = this.entered
    if (!entered) throw new Error('No asset-info lookup was armed')
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      entered,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for asset_info')), 2_000)
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }

  release(): void {
    const release = this.releaseGate
    this.gate = null
    this.releaseGate = null
    this.entered = null
    this.markEntered = null
    release?.()
  }

  override async assetInfo(asset: AssetId): Promise<AssetInfo | null> {
    this.requests.push(asset)
    const gate = this.gate
    if (gate) {
      this.markEntered?.()
      await gate
    }
    const lookup = this.mismatch && asset === this.requested ? this.returned : asset
    return super.assetInfo(lookup)
  }
}

let world: World
let assetA: AssetId
let assetB: AssetId

beforeEach(async () => {
  world = await World.create()
  assetA = await world.issue({ symbol: 'ALPHA' })
  assetB = await world.issue({ symbol: 'BRAVO' })
})

afterEach(() => {
  world.close()
})

function expectMismatch(error: unknown): void {
  expect(error).toBeInstanceOf(KeiError)
  expect(isMarketError(error, 'asset-info-mismatch')).toBe(true)
  expect((error as Error).message).toContain(assetA)
  expect((error as Error).message).toContain(assetB)
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => new Error('operation unexpectedly resolved with mismatched metadata'),
    (error: unknown) => error,
  )
}

describe('the write boundary', () => {
  test('sell, bid, and longhand offer stop before balance, signing, or submission', async () => {
    const node = new ControlledAssetInfoNode(world.node, assetA, assetB)
    const writer = await world.actor('writer', { node })
    await world.mint(assetA, writer, 3)
    await world.mint(assetB, writer, 50)

    node.mismatch = true
    node.resetEvidence()
    const submit = spyOn(writer.client, 'submitAsset')
    const keiBefore = await world.keiRaw(writer.address)
    const alphaBefore = await world.node.holderBalance(assetA, writer.address)
    const bravoBefore = await world.node.holderBalance(assetB, writer.address)

    const attempts = [
      writer.market.sell({ asset: assetA, amount: 1, price: 2 }),
      writer.market.bid({ asset: assetA, amount: 1, price: 2 }),
      writer.market.offer({
        give: { asset: assetA, amount: 1 },
        want: { asset: assetB, amount: 2 },
      }),
    ]
    for (const attempt of attempts) expectMismatch(await rejection(attempt))

    // The three simultaneous write shapes share one in-flight lookup, but all
    // three stop at that same boundary.
    expect(node.requests).toEqual([assetA])
    expect(node.calls.holderBalance).toBe(0)
    expect(node.calls.process).toBe(0)
    expect(submit).toHaveBeenCalledTimes(0)
    expect(await world.keiRaw(writer.address)).toBe(keiBefore)
    expect(await world.node.holderBalance(assetA, writer.address)).toBe(alphaBefore)
    expect(await world.node.holderBalance(assetB, writer.address)).toBe(bravoBefore)
    submit.mockRestore()
  })
})

describe('the read boundary', () => {
  test('every raw-offer view refuses the foreign metadata instead of relabelling a leg', async () => {
    const node = new ControlledAssetInfoNode(world.node, assetA, assetB)
    const owner = await world.actor('owner', { node })
    const buyer = await world.actor('buyer')
    await world.mint(assetA, owner, 4)

    const open = await owner.market.sell({ asset: assetA, amount: 1, price: 2 })
    const settled = await owner.market.sell({ asset: assetA, amount: 1, price: 3 })
    await buyer.market.accept(settled)

    node.mismatch = true
    node.resetEvidence()
    const submit = spyOn(owner.client, 'submitAsset')
    const market = createMarket(owner.client, { autoCancelExpired: false, now: world.clock.now })

    const views: Array<Promise<unknown>> = [
      market.get(open.hash),
      market.offers({ from: [owner.address], state: 'open' }),
      market.mine({ state: 'open' }),
      market.book({ from: [owner.address], asset: assetA }),
      market.trades({ from: [owner.address] }),
      market.series({ from: [owner.address], asset: assetA }),
      market.candles({ from: [owner.address], asset: assetA, every: '1m' }),
      market.prices({ from: [owner.address] }),
    ]
    for (const view of views) expectMismatch(await rejection(view))

    // Reconciliation is deliberately best-effort. A bad metadata response is
    // reported as a failed row, but it must never become a relabelled offer.
    const report = await market.reconcile([open.hash])
    expect(report.live).toEqual([])
    expect(report.stale).toEqual([])
    expect(report.gone).toEqual([])
    expect(report.changed).toEqual([])
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.reason).toContain(assetA)
    expect(report.failed[0]?.reason).toContain(assetB)

    // Eight simultaneous views collapse into two in-flight lookup waves (open
    // listings and settled trades); the later reconciliation retries once.
    expect(node.requests).toEqual(Array<AssetId>(3).fill(assetA))
    expect(node.calls.holderBalance).toBe(0)
    expect(node.calls.process).toBe(0)
    expect(submit).toHaveBeenCalledTimes(0)
    submit.mockRestore()
    market.close()
  })
})

describe('cache and in-flight behavior', () => {
  let owner: Actor
  let node: ControlledAssetInfoNode
  let offerHash: string
  let market: MarketApi

  beforeEach(async () => {
    node = new ControlledAssetInfoNode(world.node, assetA, assetB)
    owner = await world.actor('owner', { node })
    await world.mint(assetA, owner, 2)
    offerHash = (await owner.market.sell({ asset: assetA, amount: 1, price: 2 })).hash
    node.resetEvidence()
    market = createMarket(owner.client, { autoCancelExpired: false, now: world.clock.now })
  })

  test('concurrent callers share a mismatched lookup, cache nothing, and recover on retry', async () => {
    node.mismatch = true
    node.holdNextLookup()
    const callers = [market.get(offerHash), market.get(offerHash), market.get(offerHash)]

    await node.waitUntilHeld()
    expect(node.requests).toEqual([assetA])
    node.release()

    const failures = await Promise.all(callers.map((caller) => rejection(caller)))
    for (const failure of failures) expectMismatch(failure)
    expect(node.requests).toEqual([assetA])

    node.mismatch = false
    const recovered = await market.get(offerHash)
    expect(recovered?.give.asset).toBe(assetA)
    expect(recovered?.give.symbol).toBe('ALPHA')
    expect(node.requests).toEqual([assetA, assetA])

    // The recovered metadata is cached, and each public offer gets its own leg
    // object: caller mutation cannot poison the cache or a later render.
    if (!recovered) throw new Error('offer disappeared during recovery probe')
    recovered.give.symbol = 'POISONED'
    const cached = await market.get(offerHash)
    expect(cached?.give.symbol).toBe('ALPHA')
    expect(node.requests).toEqual([assetA, assetA])
  })
})
