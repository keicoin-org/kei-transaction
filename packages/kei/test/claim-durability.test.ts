import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { blake2b, bytesToHex, utf8 } from '@keicoin/core'
import {
  Kei,
  KeiError,
  MAX_CLAIM_AMOUNT_DIGITS,
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
const CLAIM_ENVELOPE_DOMAIN = 'kei-claim-envelope-v3\n'

function claimEnvelope(
  bundle: { root: string; asset: string; amount: string; proof: string[] },
  state: 'candidate' | 'admitted' = 'admitted',
): string {
  const integrity = bytesToHex(
    blake2b(utf8(`${CLAIM_ENVELOPE_DOMAIN}${state}\n${JSON.stringify(bundle)}`), 32),
  )
  return JSON.stringify({ version: 3, state, bundle, integrity })
}

function claimEnvelopeV2(bundle: { root: string; asset: string; amount: string; proof: string[] }): string {
  const integrity = bytesToHex(
    blake2b(utf8(`kei-claim-envelope-v2\n${JSON.stringify(bundle)}`), 32),
  )
  return JSON.stringify({ version: 2, bundle, integrity })
}

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
  readonly admissions = new Map<string, Set<string>>()
  writeCount = 0
  removeCount = 0
  dropWrites = false
  throwWrites = false
  alterWrites = false
  rewriteWrite: ((value: string) => string) | undefined
  dropRemoves = false
  dropAdmissions = false
  lieAdmissions = false
  throwRemoves = false
  beforeAdmittedRead: ((scope: ClaimStoreScope, root: string) => void) | undefined
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

  readAdmitted(scope: ClaimStoreScope, root: string): string | null {
    const beforeRead = this.beforeAdmittedRead
    this.beforeAdmittedRead = undefined
    beforeRead?.(scope, root)
    const key = this.key(scope)
    if (!this.admissions.get(key)?.has(root)) return null
    return this.records.get(key)?.get(root) ?? null
  }

  write(scope: ClaimStoreScope, root: string, value: string): void {
    this.writeCount += 1
    if (this.throwWrites) throw new Error('quota details must not escape')
    if (this.dropWrites) return
    const parsed = JSON.parse(value) as {
      bundle?: { amount: string }
    }
    if (this.alterWrites) {
      if (parsed.bundle) parsed.bundle.amount = String(BigInt(parsed.bundle.amount) + 1n)
      value = JSON.stringify(parsed)
    }
    if (this.rewriteWrite) value = this.rewriteWrite(value)
    const key = this.key(scope)
    const records = this.records.get(key) ?? new Map<string, string>()
    records.set(root, value)
    this.records.set(key, records)
    this.admissions.get(key)?.delete(root)
  }

  admit(scope: ClaimStoreScope, root: string, value: string): boolean {
    const key = this.key(scope)
    const expected = value
    if (this.admissions.get(key)?.has(root)) {
      return this.records.get(key)?.get(root) === value
    }
    this.writeCount += 1
    if (this.throwWrites) throw new Error('quota details must not escape')
    if (this.dropWrites) return false
    const parsed = JSON.parse(value) as { bundle?: { amount: string } }
    if (this.alterWrites && parsed.bundle) {
      parsed.bundle.amount = String(BigInt(parsed.bundle.amount) + 1n)
      value = JSON.stringify(parsed)
    }
    if (this.rewriteWrite) value = this.rewriteWrite(value)
    const records = this.records.get(key) ?? new Map<string, string>()
    records.set(root, value)
    this.records.set(key, records)
    this.admissions.get(key)?.delete(root)
    if (this.dropAdmissions) return false
    if (this.lieAdmissions) return true
    if (value !== expected) return false
    const admitted = this.admissions.get(key) ?? new Set<string>()
    admitted.add(root)
    this.admissions.set(key, admitted)
    return true
  }

  remove(scope: ClaimStoreScope, root: string): void {
    this.removeCount += 1
    if (this.throwRemoves) throw new Error('remove details must not escape')
    if (this.dropRemoves) return
    const key = this.key(scope)
    this.records.get(key)?.delete(root)
    this.admissions.get(key)?.delete(root)
  }

  inject(scope: ClaimStoreScope, root: string, value: string, admitted = false): void {
    const key = this.key(scope)
    const records = this.records.get(key) ?? new Map<string, string>()
    records.set(root, value)
    this.records.set(key, records)
    const admissions = this.admissions.get(key) ?? new Set<string>()
    if (admitted) admissions.add(root)
    else admissions.delete(root)
    this.admissions.set(key, admissions)
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

  test('browser namespace v1 records migrate only after the original bundle is re-admitted', async () => {
    const storage = new MemoryWebStorage()
    const lockManager = new SerializedClaimLockManager()
    const setup = remember(await Kei.start({ node, seed: PLAYER_SEED, autoClaim: false }))
    const drop = await gems.commit([{ to: setup.address, amount: 15 }])
    const bundle = drop.proofFor(setup.address)
    const namespaceKey = `kei:claim-store:v1:mock:${encodeURIComponent(setup.address)}`
    storage.setItem(namespaceKey, JSON.stringify({
      version: 1,
      records: [[bundle.root, claimEnvelope(bundle)]],
    }))
    setup.close()

    let claimSubmissions = 0
    const originalProcess = node.process.bind(node)
    node.process = async (block: Block) => {
      if (block.type === 'asset' && block.op.kind === 'claim') claimSubmissions += 1
      return originalProcess(block)
    }
    const migrated = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: createBrowserClaimStore(storage, { lockManager }),
    }))
    expect(await migrated.claims.pending()).toHaveLength(0)
    expect((await migrated.claims.storageStatus()).diagnostics.map(({ code }) => code))
      .toEqual(['claim-store-quarantined'])
    expect(claimSubmissions).toBe(0)

    await migrated.claims.add(bundle)
    expect(await migrated.claims.pending()).toHaveLength(1)
    expect(JSON.parse(storage.getItem(namespaceKey) as string).version).toBe(2)
    migrated.close()

    const reopened = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: createBrowserClaimStore(storage, { lockManager }),
    }))
    expect(await reopened.claims.pending()).toHaveLength(1)
    expect(claimSubmissions).toBe(0)
  })

  test('legacy v1 and v2 envelopes remain non-signable pending explicit re-add', async () => {
    const store = new InspectableClaimStore()
    const setup = remember(await Kei.start({ node, seed: PLAYER_SEED, autoClaim: false }))
    const first = await gems.commit([{ to: setup.address, amount: 5 }])
    const second = await gems.commit([{ to: setup.address, amount: 7 }])
    const firstBundle = first.proofFor(setup.address)
    const secondBundle = second.proofFor(setup.address)
    const scope = { network: 'mock', address: setup.address }
    store.inject(scope, firstBundle.root, JSON.stringify({ version: 1, bundle: firstBundle }), true)
    store.inject(scope, secondBundle.root, claimEnvelopeV2(secondBundle), true)
    setup.close()

    let claimSubmissions = 0
    const originalProcess = node.process.bind(node)
    node.process = async (block: Block) => {
      if (block.type === 'asset' && block.op.kind === 'claim') claimSubmissions += 1
      return originalProcess(block)
    }
    const reopened = remember(await Kei.start({ node, seed: PLAYER_SEED, claimStore: store }))
    expect(claimSubmissions).toBe(0)
    expect((await reopened.claims.storageStatus()).diagnostics.map(({ code }) => code))
      .toEqual(['claim-store-version', 'claim-store-version'])
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

  test('a direct claim is retained before signing and survives a transient submission failure', async () => {
    const store = new InspectableClaimStore()
    const player = remember(await Kei.start({ node, seed: PLAYER_SEED, claimStore: store }))
    const drop = await gems.commit([{ to: player.address, amount: 19 }])
    const bundle = drop.proofFor(player.address)
    const scope = { network: 'mock', address: player.address }
    const originalProcess = node.process.bind(node)
    let claimSubmissions = 0
    node.process = async (block: Block) => {
      if (block.type === 'asset' && block.op.kind === 'claim') {
        claimSubmissions += 1
        if (claimSubmissions === 1) {
          throw new KeiError('node-unreachable', 'The deterministic test node refused this direct claim once.')
        }
      }
      return originalProcess(block)
    }

    await expect(player.claims.claim(bundle)).rejects.toThrow(/refused this direct claim once/)
    expect(store.writeCount).toBe(1)
    expect(store.removeCount).toBe(0)
    expect(await store.list(scope, 2)).toEqual([bundle.root])
    expect(await gems.balanceOf(player.address)).toBe(0)
    player.close()

    const reloaded = remember(await Kei.start({ node, seed: PLAYER_SEED, claimStore: store }))
    expect(claimSubmissions).toBe(2)
    expect(store.writeCount).toBe(1)
    expect(store.removeCount).toBe(1)
    expect(await store.list(scope, 2)).toEqual([])
    expect(await gems.balanceOf(reloaded.address)).toBe(19)
  })

  test('a direct claim reuses an exact retained record without another write', async () => {
    const store = new InspectableClaimStore()
    const player = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: store,
    }))
    const drop = await gems.commit([{ to: player.address, amount: 11 }])
    const bundle = drop.proofFor(player.address)
    let claimSubmissions = 0
    const originalProcess = node.process.bind(node)
    node.process = async (block: Block) => {
      if (block.type === 'asset' && block.op.kind === 'claim') claimSubmissions += 1
      return originalProcess(block)
    }

    await player.claims.add(bundle)
    expect(store.writeCount).toBe(1)
    await player.claims.claim(bundle)

    expect(claimSubmissions).toBe(1)
    expect(store.writeCount).toBe(1)
    expect(store.removeCount).toBe(1)
    expect(await gems.balanceOf(player.address)).toBe(11)
  })

  test('a refusing store blocks direct claims before submission or balance change', async () => {
    const store = new InspectableClaimStore()
    store.throwWrites = true
    const player = remember(await Kei.start({ node, seed: PLAYER_SEED, claimStore: store }))
    const drop = await gems.commit([{ to: player.address, amount: 23 }])
    let claimSubmissions = 0
    const originalProcess = node.process.bind(node)
    node.process = async (block: Block) => {
      if (block.type === 'asset' && block.op.kind === 'claim') claimSubmissions += 1
      return originalProcess(block)
    }

    const error = await refused(player.claims.claim(drop.proofFor(player.address)))
    expect(error.code).toBe('claim-store-write-refused')
    expect(error.message).not.toContain('quota details')
    expect(store.writeCount).toBe(1)
    expect(store.removeCount).toBe(0)
    expect(claimSubmissions).toBe(0)
    expect(await gems.balanceOf(player.address)).toBe(0)
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
    const envelope = (root: string): string => claimEnvelope({
      root,
      asset: gems.id,
      amount: '1',
      proof: [],
    })
    for (const root of roots.slice(0, MAX_PENDING_CLAIMS - 1)) {
      const value = envelope(root)
      await firstStore.write(scope, root, value)
      expect(await firstStore.admit?.(scope, root, value)).toBe(true)
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
    store.inject(scope, corruptRoot, '{not-json', true)
    store.inject(scope, versionRoot, JSON.stringify({ version: 99, bundle: {} }), true)
    store.inject(scope, largeRoot, 'X'.repeat(MAX_CLAIM_RECORD_BYTES + 1), true)

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
      amount: '9'.repeat(MAX_CLAIM_AMOUNT_DIGITS + 1),
      proof: [],
    }))).code).toBe('claim-amount-too-large')
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
    expect(error.code).toBe('claim-store-write-refused')
    expect(error.message).not.toContain('quota details')

    mismatch.dropWrites = false
    mismatch.throwWrites = true
    const refusedDrop = await gems.commit([{ to: player.address, amount: 8 }])
    const writeError = await refused(player.claims.add(refusedDrop.proofFor(player.address)))
    expect(writeError.code).toBe('claim-store-write-refused')
    expect(writeError.message).not.toContain('quota details')
    expect(claimSubmissions).toBe(0)
  })

  test('direct claim persists and reads back before signing, then removes durably', async () => {
    const refusing = new InspectableClaimStore()
    refusing.throwWrites = true
    const player = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: refusing,
    }))
    const refusedDrop = await gems.commit([{ to: player.address, amount: 11 }])
    const originalProcess = node.process.bind(node)
    let claimSubmissions = 0
    node.process = async (block: Block) => {
      if (block.type === 'asset' && block.op.kind === 'claim') claimSubmissions += 1
      return originalProcess(block)
    }

    expect((await refused(player.claims.claim(refusedDrop.proofFor(player.address)))).code)
      .toBe('claim-store-write-refused')
    expect(claimSubmissions).toBe(0)
    expect(refusing.writeCount).toBe(1)

    const retained = new InspectableClaimStore()
    const claimant = remember(await Kei.start({
      node,
      seed: OTHER_SEED,
      autoClaim: false,
      claimStore: retained,
    }))
    const claimedDrop = await gems.commit([{ to: claimant.address, amount: 13 }])
    await claimant.claims.claim(claimedDrop.proofFor(claimant.address))
    expect(claimSubmissions).toBe(1)
    expect(await retained.list({ network: 'mock', address: claimant.address }, 2)).toEqual([])
    expect(await gems.balanceOf(claimant.address)).toBe(13)
  })

  test('a rejected admission leaves its raw candidate non-signable across recreation', async () => {
    const store = new InspectableClaimStore()
    store.dropAdmissions = true
    const player = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: store,
    }))
    const drop = await gems.commit([{ to: player.address, amount: 19 }])
    expect((await refused(player.claims.add(drop.proofFor(player.address)))).code)
      .toBe('claim-store-write-refused')
    expect((await player.claims.storageStatus()).diagnostics.map(({ code }) => code)).toEqual([
      'claim-store-quarantined',
      'claim-store-write-refused',
    ])
    player.close()

    const originalProcess = node.process.bind(node)
    let claimSubmissions = 0
    node.process = async (block: Block) => {
      if (block.type === 'asset' && block.op.kind === 'claim') claimSubmissions += 1
      return originalProcess(block)
    }
    const reopened = remember(await Kei.start({ node, seed: PLAYER_SEED, claimStore: store }))
    expect(claimSubmissions).toBe(0)
    expect((await reopened.claims.storageStatus()).diagnostics.map(({ code }) => code))
      .toEqual(['claim-store-quarantined'])
    expect(await store.list({ network: 'mock', address: reopened.address }, 2)).toEqual([drop.root])
  })

  test('a recomputed internally-valid admitted replacement stays non-signable across recreation', async () => {
    const store = new InspectableClaimStore()
    store.dropRemoves = true
    store.rewriteWrite = (value) => {
      const record = JSON.parse(value) as {
        bundle: { root: string; asset: string; amount: string; proof: string[] }
      }
      return claimEnvelope({
        ...record.bundle,
        amount: String(BigInt(record.bundle.amount) + 1n),
      })
    }
    const player = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: store,
    }))
    const drop = await gems.commit([{ to: player.address, amount: 29 }])
    expect((await refused(player.claims.add(drop.proofFor(player.address)))).code)
      .toBe('claim-store-readback-mismatch')
    expect((await player.claims.storageStatus()).diagnostics.map(({ code }) => code)).toEqual([
      'claim-store-quarantined',
      'claim-store-readback-mismatch',
    ])
    player.close()

    const originalProcess = node.process.bind(node)
    let claimSubmissions = 0
    node.process = async (block: Block) => {
      if (block.type === 'asset' && block.op.kind === 'claim') claimSubmissions += 1
      return originalProcess(block)
    }
    const reopened = remember(await Kei.start({ node, seed: PLAYER_SEED, claimStore: store }))
    expect(claimSubmissions).toBe(0)
    expect((await reopened.claims.storageStatus()).diagnostics.map(({ code }) => code))
      .toEqual(['claim-store-quarantined'])
  })

  test('an adapter that lies about admission is caught by the separate admitted read', async () => {
    const store = new InspectableClaimStore()
    store.lieAdmissions = true
    store.dropRemoves = true
    const player = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: store,
    }))
    const drop = await gems.commit([{ to: player.address, amount: 37 }])
    expect((await refused(player.claims.add(drop.proofFor(player.address)))).code)
      .toBe('claim-store-readback-mismatch')
    expect((await player.claims.storageStatus()).diagnostics.map(({ code }) => code)).toEqual([
      'claim-store-quarantined',
      'claim-store-readback-mismatch',
    ])
    player.close()

    const originalProcess = node.process.bind(node)
    let claimSubmissions = 0
    node.process = async (block: Block) => {
      if (block.type === 'asset' && block.op.kind === 'claim') claimSubmissions += 1
      return originalProcess(block)
    }
    const reopened = remember(await Kei.start({ node, seed: PLAYER_SEED, claimStore: store }))
    expect(claimSubmissions).toBe(0)
    expect((await reopened.claims.storageStatus()).diagnostics.map(({ code }) => code))
      .toEqual(['claim-store-quarantined'])
  })

  test('a persistent custom adapter without admission support fails before mutation', async () => {
    let writes = 0
    const legacyStore: ClaimStore = {
      durability: 'persistent',
      list: () => [],
      read: () => null,
      write: () => { writes += 1 },
      remove: () => {},
    }
    const player = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: legacyStore,
    }))
    const drop = await gems.commit([{ to: player.address, amount: 43 }])

    expect((await refused(player.claims.add(drop.proofFor(player.address)))).code)
      .toBe('claim-store-admission-unsupported')
    expect(writes).toBe(0)
    expect((await player.claims.storageStatus()).diagnostics.map(({ code }) => code)).toContain(
      'claim-store-admission-unsupported',
    )
  })

  test('a rejected admission never deletes a concurrently admitted same-root proof', async () => {
    const store = new InspectableClaimStore()
    store.dropAdmissions = true
    const player = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: store,
    }))
    const drop = await gems.commit([{ to: player.address, amount: 41 }])
    const bundle = drop.proofFor(player.address)
    const scope = { network: 'mock', address: player.address }
    const admitted = claimEnvelope(bundle)
    store.beforeAdmittedRead = (readScope, root) => store.inject(readScope, root, admitted, true)

    expect((await refused(player.claims.add(bundle))).code).toBe('claim-store-write-refused')

    expect(await store.readAdmitted(scope, bundle.root)).toBe(admitted)
    expect(store.removeCount).toBe(0)
  })

  test('a confirmed claim with failed removal reconciles without signing again', async () => {
    const store = new InspectableClaimStore()
    store.dropRemoves = true
    const player = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: store,
    }))
    const drop = await gems.commit([{ to: player.address, amount: 31 }])
    expect((await refused(player.claims.claim(drop.proofFor(player.address)))).code)
      .toBe('claim-store-remove-refused')
    expect(await gems.balanceOf(player.address)).toBe(31)
    expect(await store.list({ network: 'mock', address: player.address }, 2)).toEqual([drop.root])
    player.close()

    store.dropRemoves = false
    const originalProcess = node.process.bind(node)
    let claimSubmissions = 0
    node.process = async (block: Block) => {
      if (block.type === 'asset' && block.op.kind === 'claim') claimSubmissions += 1
      return originalProcess(block)
    }
    const reopened = remember(await Kei.start({ node, seed: PLAYER_SEED, claimStore: store }))
    expect(claimSubmissions).toBe(0)
    expect(await store.list({ network: 'mock', address: reopened.address }, 2)).toEqual([])
  })

  test('direct claim bounds variable components before serialising or submitting', async () => {
    const store = new InspectableClaimStore()
    const player = remember(await Kei.start({
      node,
      seed: PLAYER_SEED,
      autoClaim: false,
      claimStore: store,
    }))
    const drop = await gems.commit([{ to: player.address, amount: 23 }])
    const bundle = drop.proofFor(player.address)
    const amount = '9'.repeat(1_000_000)
    let amountReads = 0
    const oversized = { ...bundle }
    Object.defineProperty(oversized, 'amount', {
      enumerable: true,
      get: () => {
        amountReads += 1
        return amount
      },
    })
    const stringify = JSON.stringify
    let serialisations = 0
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      serialisations += 1
      return stringify(...args)
    }) as typeof JSON.stringify
    const originalProcess = node.process.bind(node)
    let claimSubmissions = 0
    node.process = async (block: Block) => {
      if (block.type === 'asset' && block.op.kind === 'claim') claimSubmissions += 1
      return originalProcess(block)
    }

    try {
      expect((await refused(player.claims.claim(oversized))).code)
        .toBe('claim-amount-too-large')
    } finally {
      JSON.stringify = stringify
    }
    expect(serialisations).toBe(0)
    expect(amountReads).toBe(1)
    expect(store.writeCount).toBe(0)
    expect(claimSubmissions).toBe(0)
  })
})
