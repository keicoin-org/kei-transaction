import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  Kei,
  KeiError,
  MAX_CLAIM_PROOF_LENGTH,
  MAX_CLAIM_RECORD_BYTES,
  MAX_PENDING_CLAIMS,
  createBrowserClaimStore,
  createMemoryClaimStore,
  type Block,
  type ClaimStore,
  type ClaimStoreScope,
  type ClaimWebStorage,
  type IssuerToken,
  type MockNode,
} from 'kei-transaction'

const PLAYER_SEED = 'D'.repeat(64)
const OTHER_SEED = 'E'.repeat(64)

class MemoryWebStorage implements ClaimWebStorage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

class InspectableClaimStore implements ClaimStore {
  readonly durability = 'persistent' as const
  readonly records = new Map<string, Map<string, string>>()
  writeCount = 0
  dropWrites = false
  throwWrites = false
  listedRoots: readonly string[] | undefined

  private key(scope: ClaimStoreScope): string {
    return `${scope.network}:${scope.address}`
  }

  list(scope: ClaimStoreScope, limit: number): readonly string[] {
    const roots = this.listedRoots ?? [...(this.records.get(this.key(scope))?.keys() ?? [])]
    return roots.slice(0, limit)
  }

  read(scope: ClaimStoreScope, root: string): string | null {
    return this.records.get(this.key(scope))?.get(root) ?? null
  }

  write(scope: ClaimStoreScope, root: string, value: string): void {
    this.writeCount += 1
    if (this.throwWrites) throw new Error('quota details must not escape')
    if (this.dropWrites) return
    const key = this.key(scope)
    const records = this.records.get(key) ?? new Map<string, string>()
    records.set(root, value)
    this.records.set(key, records)
  }

  remove(scope: ClaimStoreScope, root: string): void {
    this.records.get(this.key(scope))?.delete(root)
  }

  inject(scope: ClaimStoreScope, root: string, value: string): void {
    const key = this.key(scope)
    const records = this.records.get(key) ?? new Map<string, string>()
    records.set(root, value)
    this.records.set(key, records)
  }
}

async function refused(promise: Promise<unknown>): Promise<KeiError> {
  const outcome = await promise.catch((error: unknown) => error)
  expect(outcome).toBeInstanceOf(KeiError)
  return outcome as KeiError
}

let node: MockNode
let game: Kei
let gems: IssuerToken
let opened: Kei[]

beforeEach(async () => {
  node = await Kei.mock()
  game = await Kei.server({ seed: 'C'.repeat(64), node })
  await game.faucet(5_000)
  gems = await game.token.issue({ name: 'Gems', symbol: 'GEM', decimals: 0 })
  opened = [game]
})

afterEach(() => {
  for (const kei of opened) kei.close()
})

function remember(kei: Kei): Kei {
  opened.push(kei)
  return kei
}

describe('durable claim bundles', () => {
  test('beforeReload=1, afterReload=1, claim works, and the claimed entry stays removed', async () => {
    const storage = new MemoryWebStorage()
    const first = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: createBrowserClaimStore(storage),
    }))
    const drop = await gems.commit([{ to: first.address, amount: 9 }])
    await first.claims.add(drop.proofFor(first.address))

    const beforeReload = (await first.claims.pending()).length
    first.close()
    const reloaded = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: createBrowserClaimStore(storage),
    }))
    const afterReload = (await reloaded.claims.pending()).length

    expect({ beforeReload, afterReload }).toEqual({ beforeReload: 1, afterReload: 1 })
    expect((await reloaded.claims.storageStatus()).durability).toBe('persistent')
    await reloaded.claims.claimAll()
    expect(await gems.balanceOf(reloaded.address)).toBe(9)

    reloaded.close()
    const afterClaimReload = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: createBrowserClaimStore(storage),
    }))
    expect(await afterClaimReload.claims.pending()).toHaveLength(0)
    expect(storage.length).toBe(0)
  })

  test('a transient automatic-claim failure survives recreation and retries once', async () => {
    const store = new InspectableClaimStore()
    const player = remember(await Kei.start({ node, seed: PLAYER_SEED, claimStore: store }))
    const drop = await gems.commit([{ to: player.address, amount: 17 }])
    const originalProcess = node.process.bind(node)
    let failClaimOnce = true
    node.process = async (block: Block) => {
      if (failClaimOnce && block.type === 'asset' && block.op.kind === 'claim') {
        failClaimOnce = false
        throw new KeiError('node-unreachable', 'The deterministic test node refused this claim once.')
      }
      return originalProcess(block)
    }

    await expect(player.claims.add(drop.proofFor(player.address))).rejects.toThrow(/refused this claim once/)
    expect((await store.list({ network: 'mock', address: player.address }, 2))).toHaveLength(1)
    player.close()

    const reloaded = remember(await Kei.start({ node, seed: PLAYER_SEED, claimStore: store }))
    expect(await gems.balanceOf(reloaded.address)).toBe(17)
    expect(await reloaded.claims.pending()).toHaveLength(0)
    expect((await store.list({ network: 'mock', address: reloaded.address }, 2))).toHaveLength(0)
  })

  test('already-claimed and closed roots reconcile away without signing', async () => {
    const store = new InspectableClaimStore()
    const first = remember(await Kei.start({ node, seed: PLAYER_SEED, autoClaim: false, claimStore: store }))
    const claimedDrop = await gems.commit([{ to: first.address, amount: 5 }])
    const closedDrop = await gems.commit([{ to: first.address, amount: 7 }])
    const claimedBundle = claimedDrop.proofFor(first.address)
    await first.claims.add([claimedBundle, closedDrop.proofFor(first.address)])
    first.close()

    const direct = remember(await Kei.start({ node, seed: PLAYER_SEED, autoClaim: false }))
    await direct.claims.claim(claimedBundle)
    direct.close()
    await gems.close(closedDrop.root)

    const originalProcess = node.process.bind(node)
    let submissions = 0
    node.process = async (block: Block) => {
      submissions += 1
      return originalProcess(block)
    }
    const reconciled = remember(await Kei.start({ node, seed: PLAYER_SEED, claimStore: store }))
    expect(await reconciled.claims.pending()).toHaveLength(0)
    expect(submissions).toBe(0)
    expect((await store.list({ network: 'mock', address: reconciled.address }, 3))).toHaveLength(0)
  })

  test('wallet and network namespaces do not leak records', async () => {
    const store = createMemoryClaimStore()
    const player = remember(await Kei.start({ node, seed: PLAYER_SEED, autoClaim: false, claimStore: store }))
    const other = remember(await Kei.start({ node, seed: OTHER_SEED, autoClaim: false, claimStore: store }))
    const drop = await gems.commit([{ to: player.address, amount: 3 }])
    await player.claims.add(drop.proofFor(player.address))

    expect(await other.claims.pending()).toHaveLength(0)
    const scope = (await player.claims.storageStatus()).namespace
    expect(await store.list({ ...scope, network: 'testnet' }, 10)).toHaveLength(0)
    expect(await store.list({ ...scope, address: other.address }, 10)).toHaveLength(0)
    expect(await store.list(scope, 10)).toEqual([drop.root])
  })

  test('corrupt, unsupported-version, and over-budget records diagnose and never sign', async () => {
    const store = new InspectableClaimStore()
    const scopePlayer = remember(await Kei.start({ node, seed: PLAYER_SEED, autoClaim: false }))
    const scope = { network: 'mock', address: scopePlayer.address }
    scopePlayer.close()
    const corruptRoot = 'A'.repeat(64)
    const versionRoot = 'B'.repeat(64)
    const largeRoot = 'C'.repeat(64)
    store.inject(scope, corruptRoot, '{not-json')
    store.inject(scope, versionRoot, JSON.stringify({ version: 2, bundle: {} }))
    store.inject(scope, largeRoot, 'X'.repeat(MAX_CLAIM_RECORD_BYTES + 1))

    const originalProcess = node.process.bind(node)
    let submissions = 0
    node.process = async (block: Block) => {
      submissions += 1
      return originalProcess(block)
    }
    const player = remember(await Kei.start({ node, seed: PLAYER_SEED, claimStore: store }))
    const status = await player.claims.storageStatus()
    expect(status.diagnostics.map(({ code }) => code)).toEqual([
      'claim-store-corrupt',
      'claim-store-version',
      'claim-store-corrupt',
    ])
    expect(await player.claims.pending()).toHaveLength(0)
    expect(submissions).toBe(0)
  })

  test('duplicate roots deduplicate, while count, proof, and byte budgets refuse before signing', async () => {
    const store = new InspectableClaimStore()
    const player = remember(await Kei.start({ node, seed: PLAYER_SEED, autoClaim: false, claimStore: store }))
    const drop = await gems.commit([{ to: player.address, amount: 4 }])
    const bundle = drop.proofFor(player.address)
    await player.claims.add([bundle, bundle])
    expect(store.writeCount).toBe(1)
    expect(await player.claims.pending()).toHaveLength(1)

    const tooMany = Array.from({ length: MAX_PENDING_CLAIMS }, (_, index) => ({
      root: index.toString(16).toUpperCase().padStart(64, '0'),
      asset: bundle.asset,
      amount: '1',
      proof: [] as string[],
    }))
    expect((await refused(player.claims.add(tooMany))).code).toBe('claim-store-overflow')
    expect((await refused(player.claims.add({
      ...bundle,
      root: 'F'.repeat(64),
      proof: Array.from({ length: MAX_CLAIM_PROOF_LENGTH + 1 }, () => 'A'.repeat(64)),
    }))).code).toBe('claim-proof-too-long')
    expect((await refused(player.claims.add({
      ...bundle,
      root: 'E'.repeat(64),
      amount: '9'.repeat(MAX_CLAIM_RECORD_BYTES),
      proof: [],
    }))).code).toBe('claim-record-too-large')
    expect(store.writeCount).toBe(1)
  })

  test('store overflow and persistence read-back mismatch are typed and fail closed', async () => {
    const overflow = new InspectableClaimStore()
    overflow.listedRoots = Array.from({ length: MAX_PENDING_CLAIMS + 1 }, (_, index) =>
      index.toString(16).toUpperCase().padStart(64, '0'))
    const overflowPlayer = remember(await Kei.start({ node, seed: PLAYER_SEED, claimStore: overflow }))
    expect((await overflowPlayer.claims.storageStatus()).diagnostics[0]?.code).toBe('claim-store-overflow')
    overflowPlayer.close()

    const mismatch = new InspectableClaimStore()
    mismatch.dropWrites = true
    const player = remember(await Kei.start({ node, seed: PLAYER_SEED, claimStore: mismatch }))
    const drop = await gems.commit([{ to: player.address, amount: 6 }])
    const originalProcess = node.process.bind(node)
    let claimSubmissions = 0
    node.process = async (block: Block) => {
      if (block.type === 'asset' && block.op.kind === 'claim') claimSubmissions += 1
      return originalProcess(block)
    }

    const error = await refused(player.claims.add(drop.proofFor(player.address)))
    expect(error.code).toBe('claim-store-readback-mismatch')
    expect(error.message).not.toContain('quota details')

    mismatch.dropWrites = false
    mismatch.throwWrites = true
    const refusedDrop = await gems.commit([{ to: player.address, amount: 8 }])
    const writeError = await refused(player.claims.add(refusedDrop.proofFor(player.address)))
    expect(writeError.code).toBe('claim-store-write-refused')
    expect(writeError.message).not.toContain('quota details')
    expect(claimSubmissions).toBe(0)
  })
})
