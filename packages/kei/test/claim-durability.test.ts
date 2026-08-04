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
  type ClaimWebLockManager,
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

class SerializedClaimLockManager implements ClaimWebLockManager {
  private readonly tails = new Map<string, Promise<void>>()

  request<T>(name: string, callback: () => T | PromiseLike<T>): Promise<T> {
    const previous = this.tails.get(name) ?? Promise.resolve()
    let release = (): void => {}
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this.tails.set(name, tail)
    return previous.then(callback).finally(() => {
      release()
      if (this.tails.get(name) === tail) this.tails.delete(name)
    })
  }
}

class RefusingClaimLockManager implements ClaimWebLockManager {
  request<T>(): Promise<T> {
    return Promise.reject(new Error('lock internals must not escape'))
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
    const lockManager = new SerializedClaimLockManager()
    const first = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: createBrowserClaimStore(storage, { lockManager }),
    }))
    const drop = await gems.commit([{ to: first.address, amount: 9 }])
    await first.claims.add(drop.proofFor(first.address))

    const beforeReload = (await first.claims.pending()).length
    first.close()
    const originalHasClaimed = node.hasClaimed.bind(node)
    const originalCommitInfo = node.commitInfo.bind(node)
    const originalProcess = node.process.bind(node)
    let reconciledReads = 0
    let claimSubmissions = 0
    node.hasClaimed = async (address, root) => {
      reconciledReads += 1
      return originalHasClaimed(address, root)
    }
    node.commitInfo = async (root) => {
      reconciledReads += 1
      return originalCommitInfo(root)
    }
    node.process = async (block: Block) => {
      if (block.type === 'asset' && block.op.kind === 'claim') claimSubmissions += 1
      return originalProcess(block)
    }
    const reloaded = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: createBrowserClaimStore(storage, { lockManager }),
    }))
    expect(reconciledReads).toBe(2)
    expect(claimSubmissions).toBe(0)
    expect(storage.length).toBe(1)
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
      claimStore: createBrowserClaimStore(storage, { lockManager }),
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
    const reconciled = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: store,
    }))
    expect((await store.list({ network: 'mock', address: reconciled.address }, 3))).toHaveLength(0)
    expect(submissions).toBe(0)
    expect(await reconciled.claims.pending()).toHaveLength(0)
  })

  test('browser locks admit at most one concurrent 128th proof and preserve the acknowledged write', async () => {
    const storage = new MemoryWebStorage()
    const lockManager = new SerializedClaimLockManager()
    const firstStore = createBrowserClaimStore(storage, { lockManager })
    const secondStore = createBrowserClaimStore(storage, { lockManager })
    const scoped = remember(await Kei.start({ node, seed: PLAYER_SEED, autoClaim: false }))
    const scope = { network: 'mock', address: scoped.address }
    scoped.close()
    const roots = Array.from({ length: MAX_PENDING_CLAIMS + 3 }, (_, index) =>
      index.toString(16).toUpperCase().padStart(64, '0'))
    const envelope = (root: string): string => JSON.stringify({
      version: 1,
      bundle: { root, asset: gems.id, amount: '1', proof: [] },
    })
    for (const root of roots.slice(0, MAX_PENDING_CLAIMS - 1)) {
      await firstStore.write(scope, root, envelope(root))
    }

    node.hasClaimed = async () => false
    node.commitInfo = async (root) => ({
      root,
      issuer: game.address,
      asset: gems.id,
      count: 1,
      total: '1',
      closed: false,
    })
    const first = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: firstStore,
    }))
    const second = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: secondStore,
    }))
    const candidates = roots.slice(MAX_PENDING_CLAIMS - 1, MAX_PENDING_CLAIMS + 1)
      .map((root) => ({ root, asset: gems.id, amount: '1', proof: [] as string[] }))
    const outcomes = await Promise.allSettled([
      first.claims.add(candidates[0] as (typeof candidates)[number]),
      second.claims.add(candidates[1] as (typeof candidates)[number]),
    ])
    const fulfilled = outcomes.flatMap((outcome, index) =>
      outcome.status === 'fulfilled' ? [candidates[index]?.root as string] : [])
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toBeInstanceOf(KeiError)
    expect((rejected[0]?.reason as KeiError).code).toBe('claim-store-overflow')
    expect((rejected[0]?.reason as KeiError).message).toContain('wallet tab')

    const futureStore = createBrowserClaimStore(storage, { lockManager })
    const persisted = await futureStore.list(scope, MAX_PENDING_CLAIMS + 1)
    expect(persisted).toHaveLength(MAX_PENDING_CLAIMS)
    expect(persisted).toContain(fulfilled[0] as string)
    expect(await Promise.all(persisted.map((root) => futureStore.read(scope, root))))
      .not.toContain(null)

    const later = { root: roots[MAX_PENDING_CLAIMS + 1] as string, asset: gems.id, amount: '1', proof: [] }
    const staleError = await refused(second.claims.add(later))
    expect(staleError.code).toBe('claim-store-overflow')
    expect(await futureStore.read(scope, fulfilled[0] as string)).not.toBeNull()

    first.close()
    second.close()
    let submissions = 0
    const originalProcess = node.process.bind(node)
    node.process = async (block: Block) => {
      if (block.type === 'asset' && block.op.kind === 'claim') submissions += 1
      return originalProcess(block)
    }
    const reopened = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: futureStore,
    }))
    expect((await reopened.claims.pending()).map(({ root }) => root)).toContain(fulfilled[0] as string)
    expect((await reopened.claims.storageStatus()).diagnostics).toEqual([])
    expect(submissions).toBe(0)
  })

  test('browser storage fails closed when Web Locks are unavailable or refuse a request', async () => {
    const storage = new MemoryWebStorage()
    const workingLocks = new SerializedClaimLockManager()
    const retained = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: createBrowserClaimStore(storage, { lockManager: workingLocks }),
    }))
    const drop = await gems.commit([{ to: retained.address, amount: 2 }])
    await retained.claims.add(drop.proofFor(retained.address))
    retained.close()

    for (const lockManager of [null, new RefusingClaimLockManager()] as const) {
      let submissions = 0
      const originalProcess = node.process.bind(node)
      node.process = async (block: Block) => {
        if (block.type === 'asset' && block.op.kind === 'claim') submissions += 1
        return originalProcess(block)
      }
      const player = remember(await Kei.start({
        node,
        seed: PLAYER_SEED,
        autoClaim: false,
        claimStore: createBrowserClaimStore(storage, { lockManager }),
      }))
      expect((await player.claims.storageStatus()).diagnostics.map(({ code }) => code))
        .toContain('claim-store-unreadable')
      expect(await player.claims.pending()).toEqual([])
      expect(submissions).toBe(0)
      player.close()
    }
    expect(storage.length).toBe(1)
  })

  test('a corrupt browser namespace remains fail-closed behind the lock', async () => {
    const storage = new MemoryWebStorage()
    const lockManager = new SerializedClaimLockManager()
    const scoped = remember(await Kei.start({ node, seed: PLAYER_SEED, autoClaim: false }))
    const key = `kei:claim-store:v1:mock:${encodeURIComponent(scoped.address)}`
    scoped.close()
    storage.setItem(key, '{not-json')
    let submissions = 0
    const originalProcess = node.process.bind(node)
    node.process = async (block: Block) => {
      if (block.type === 'asset' && block.op.kind === 'claim') submissions += 1
      return originalProcess(block)
    }

    const player = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: createBrowserClaimStore(storage, { lockManager }),
    }))
    expect((await player.claims.storageStatus()).diagnostics.map(({ code }) => code))
      .toContain('claim-store-unreadable')
    expect(await player.claims.pending()).toEqual([])
    expect(submissions).toBe(0)
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
