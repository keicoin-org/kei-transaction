/**
 * SPEC §6.4 — a generated seed is persisted client-side, and a wallet that
 * could not be persisted has to say so.
 *
 * The failure this file exists to prevent: `Kei.start()` swallowing a
 * `localStorage` failure, handing back a working wallet, and losing everything
 * sent to it at the next reload because a different seed is generated. Private
 * browsing, disabled storage, quota exhaustion, and browser policy all make
 * `setItem` throw, and some of them make `getItem` throw too.
 *
 * The `localStorage` global is installed and removed around each case that
 * needs one: `bun test` runs every package's tests in one process, so a fake
 * left behind would change how every later `Kei.start()` in the run resolves
 * its seed. Networks are chosen per case for the same reason — the store key is
 * `kei:seed:<network>` (`seedStoreKey`), and the session copy that keeps one
 * page on one address outlives a single test by design.
 */

import { describe, expect, test } from 'bun:test'
import { containsSecret } from '@keicoin/core'
import {
  Kei,
  KeiError,
  MockNode,
  defaultSeedStore,
  persistSeed,
  randomSeed,
  readSeed,
  seedStoreKey,
  type SeedStore,
} from 'kei-transaction'
// Not part of the package's public surface: a store over a session map this
// test owns is how a page reload is simulated in one process (see below).
import { createBrowserSeedStore } from '../src/storage.js'

interface WebStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** An ordinary, working `localStorage`, over a map a test can inspect. */
function browserStorage(disk = new Map<string, string>()): WebStorage & { disk: Map<string, string> } {
  return {
    disk,
    getItem: (key) => disk.get(key) ?? null,
    setItem: (key, value) => void disk.set(key, value),
  }
}

/** What a full quota actually throws: a named DOM exception, not a return value. */
function quotaExhausted(): WebStorage {
  return {
    getItem: () => null,
    setItem: () => {
      const error = new Error('The quota has been exceeded.')
      error.name = 'QuotaExceededError'
      throw error
    },
  }
}

/** Private browsing at its most hostile: even reading throws. */
function unreadableStorage(disk = new Map<string, string>()): WebStorage {
  return {
    getItem: () => {
      throw new Error('The operation is insecure.')
    },
    setItem: (key, value) => void disk.set(key, value),
  }
}

/**
 * One storage that fails differently per key, which is what makes a
 * cross-key test possible: a key ending `-refused` cannot be written, one
 * ending `-unreadable` cannot be read back, and anything else works.
 */
function perKeyStorage(): WebStorage {
  const disk = new Map<string, string>()
  return {
    getItem: (key) => {
      if (key.endsWith('-unreadable')) throw new Error('The operation is insecure.')
      return disk.get(key) ?? null
    },
    setItem: (key, value) => {
      if (key.endsWith('-refused')) {
        const error = new Error('The quota has been exceeded.')
        error.name = 'QuotaExceededError'
        throw error
      }
      disk.set(key, value)
    },
  }
}

/**
 * Browser policy at its most hostile: reading `globalThis.localStorage` throws
 * before any method on it can be called. Chrome does this when site data is
 * blocked for the origin.
 */
function withThrowingLocalStorageProperty<T>(run: () => Promise<T>): Promise<T> {
  const scope = globalThis as { localStorage?: unknown }
  const had = Object.prototype.hasOwnProperty.call(scope, 'localStorage')
  const previous = had ? Object.getOwnPropertyDescriptor(scope, 'localStorage') : undefined
  Object.defineProperty(scope, 'localStorage', {
    configurable: true,
    get(): never {
      throw new Error('Access is denied for this document.')
    },
  })
  const restore = (): void => {
    delete scope.localStorage
    // Put back exactly what was there, getter, value, flags and all.
    if (previous) Object.defineProperty(scope, 'localStorage', previous)
  }
  return run().finally(restore)
}

async function withLocalStorage<T>(storage: WebStorage, run: () => Promise<T>): Promise<T> {
  const scope = globalThis as { localStorage?: unknown }
  const had = 'localStorage' in scope
  const previous = scope.localStorage
  scope.localStorage = storage
  try {
    return await run()
  } finally {
    if (had) scope.localStorage = previous
    else delete scope.localStorage
  }
}

async function withoutLocalStorage<T>(run: () => Promise<T>): Promise<T> {
  const scope = globalThis as { localStorage?: unknown }
  const had = 'localStorage' in scope
  const previous = scope.localStorage
  delete scope.localStorage
  try {
    return await run()
  } finally {
    if (had) scope.localStorage = previous
  }
}

/**
 * The default store, with its key namespaced to one case.
 *
 * The session copy a failed write leaves behind outlives a single test on
 * purpose — it is what keeps one page on one address. It is scoped to the
 * storage object it was refused by, but several cases here share one
 * `globalThis.localStorage` and every `Kei.start()` against a mock node asks
 * for the same `kei:seed:mock`, so without a scope one case's unsaveable wallet
 * would be found by the next one and read as a saved one.
 */
function pageStorage(scope: string): SeedStore {
  const store = defaultSeedStore()
  return {
    read: (key) => store.read(`${key}#${scope}`),
    write: (key, seed) => store.write(`${key}#${scope}`, seed),
    status: () => store.status?.() ?? { durability: 'persistent' },
  }
}

/** Records every call, so "an explicit seed touches no storage" is checkable. */
function countingStore(): { store: SeedStore; reads: () => number; writes: () => number } {
  let reads = 0
  let writes = 0
  return {
    store: {
      read: () => {
        reads++
        return null
      },
      write: () => {
        writes++
      },
    },
    reads: () => reads,
    writes: () => writes,
  }
}

function spyConsole(): { calls: string[]; restore(): void } {
  const calls: string[] = []
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
  const originals = methods.map((name) => console[name])
  for (const name of methods) {
    console[name] = (...args: unknown[]): void => {
      calls.push(args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack ?? ''}` : String(arg))).join(' '))
    }
  }
  return {
    calls,
    restore(): void {
      methods.forEach((name, i) => {
        console[name] = originals[i] as Console[typeof name]
      })
    },
  }
}

describe('a seed store reports what a write was actually worth (issue #34)', () => {
  test('a setItem that throws is a session result, and the seed is still kept for this session', async () => {
    const key = 'kei:seed:test-quota'
    const seed = randomSeed()
    await withLocalStorage(quotaExhausted(), async () => {
      const store = defaultSeedStore()
      expect(persistSeed(store, key, seed)).toEqual({ durability: 'session', reason: 'storage-write-refused' })
      // Same page, second `defaultSeedStore()`: one session, one address.
      expect(readSeed(defaultSeedStore(), key)).toBe(seed)
    })
  })

  test('a getItem that throws reads as empty, and leaves a write unverifiable', async () => {
    const key = 'kei:seed:test-unreadable'
    const seed = randomSeed()
    await withLocalStorage(unreadableStorage(), async () => {
      const store = defaultSeedStore()
      expect(readSeed(store, key)).toBe(null)
      expect(persistSeed(store, key, seed)).toEqual({ durability: 'session', reason: 'storage-unreadable' })
    })
  })

  test('a working browser store is persistent, and says so', async () => {
    const key = 'kei:seed:test-working'
    const seed = randomSeed()
    const storage = browserStorage()
    await withLocalStorage(storage, async () => {
      expect(persistSeed(defaultSeedStore(), key, seed)).toEqual({ durability: 'persistent' })
      expect(storage.disk.get(key)).toBe(seed)
    })
  })

  test('no browser storage is a session result, not a silent one', async () => {
    const seed = randomSeed()
    await withoutLocalStorage(async () => {
      expect(persistSeed(defaultSeedStore(), 'kei:seed:test-absent', seed)).toEqual({
        durability: 'session',
        reason: 'no-browser-storage',
      })
    })
  })

  test('localStorage this page may not touch at all is session, not a thrown start', async () => {
    const seed = randomSeed()
    await withThrowingLocalStorageProperty(async () => {
      // Reading the property is itself the throw, so a guard around `getItem`
      // and `setItem` alone would never run: `defaultSeedStore()` would blow up
      // and take `Kei.start()` with it.
      const store = defaultSeedStore()
      expect(readSeed(store, 'kei:seed:test-blocked')).toBe(null)
      expect(persistSeed(store, 'kei:seed:test-blocked', seed)).toEqual({
        durability: 'session',
        reason: 'no-browser-storage',
      })
    })

    // Restored exactly as it was found, whether that was a value, a getter, or
    // nothing at all — every later case in this run depends on it.
    const scope = globalThis as { localStorage?: unknown }
    expect(() => scope.localStorage).not.toThrow()
  })

  test('a key browser storage refused does not change what another key reports', async () => {
    const refused = 'kei:seed:test-cross-refused'
    const unreadable = 'kei:seed:test-cross-unreadable'
    const saved = 'kei:seed:test-cross-saved'
    const seeds = { refused: randomSeed(), unreadable: randomSeed(), saved: randomSeed() }

    // One page, one storage, one session map: three wallets that fail three
    // different ways must not answer for each other.
    const storage = perKeyStorage()
    const store = createBrowserSeedStore(storage, new Map())

    expect(persistSeed(store, refused, seeds.refused)).toEqual({
      durability: 'session',
      reason: 'storage-write-refused',
    })
    expect(persistSeed(store, unreadable, seeds.unreadable)).toEqual({
      durability: 'session',
      reason: 'storage-unreadable',
    })
    expect(persistSeed(store, saved, seeds.saved)).toEqual({ durability: 'persistent' })

    // Each key reads back its own seed, and the reason travels with it rather
    // than with whichever write happened to fail last.
    expect(store.read(refused)).toBe(seeds.refused)
    expect(store.status?.()).toEqual({ durability: 'session', reason: 'storage-write-refused' })

    expect(store.read(unreadable)).toBe(seeds.unreadable)
    expect(store.status?.()).toEqual({ durability: 'session', reason: 'storage-unreadable' })

    // The saved one is still persistent after two session failures beside it.
    expect(store.read(saved)).toBe(seeds.saved)
    expect(store.status?.()).toEqual({ durability: 'persistent' })

    // And a key nobody wrote is empty, not somebody else's wallet.
    expect(store.read('kei:seed:test-cross-absent')).toBe(null)
  })

  test('a seed one storage refused is never handed back by a different storage', async () => {
    // The key is deliberately identical throughout: a key alone is not an
    // identity. Two stores over one `localStorage` are one page and must share
    // what neither could save; two stores over *different* storage objects are
    // not, and the seed the first one kept must not surface in the second.
    const key = 'kei:seed:test-cross-store'
    const refusedSeed = randomSeed()
    const refusing = quotaExhausted()
    const working = browserStorage()

    await withLocalStorage(refusing, async () => {
      expect(persistSeed(defaultSeedStore(), key, refusedSeed)).toEqual({
        durability: 'session',
        reason: 'storage-write-refused',
      })
      // Same storage object, a second store over it: one page, one wallet.
      expect(readSeed(defaultSeedStore(), key)).toBe(refusedSeed)
    })

    await withLocalStorage(working, async () => {
      // Nothing was ever written here, and the other storage's refusal is not
      // this storage's business.
      expect(readSeed(defaultSeedStore(), key)).toBe(null)
      const own = randomSeed()
      expect(persistSeed(defaultSeedStore(), key, own)).toEqual({ durability: 'persistent' })
      expect(working.disk.get(key)).toBe(own)
      expect(own).not.toBe(refusedSeed)
    })

    // And the refusing storage still answers with its own kept seed, unchanged
    // by the durable write that happened next door.
    await withLocalStorage(refusing, async () => {
      const store = defaultSeedStore()
      expect(readSeed(store, key)).toBe(refusedSeed)
      // Still session, still for the reason this storage refused it for.
      expect(store.status?.()).toEqual({ durability: 'session', reason: 'storage-write-refused' })
    })
  })

  test('a store that drops the write silently is caught by the read-back', () => {
    const store: SeedStore = { read: () => null, write: () => undefined }
    expect(persistSeed(store, 'kei:seed:test-dropped', randomSeed())).toEqual({
      durability: 'session',
      reason: 'storage-write-refused',
    })
  })

  test('storage disappearing after its own verification keeps one session identity', () => {
    const disk = new Map<string, string>()
    let reads = 0
    const storage: WebStorage = {
      getItem: (key) => {
        reads++
        if (reads > 1) throw new Error('storage access disappeared')
        return disk.get(key) ?? null
      },
      setItem: (key, value) => void disk.set(key, value),
    }
    const store = createBrowserSeedStore(storage, new Map())
    const key = 'kei:seed:test-transient-read'
    const seed = randomSeed()

    expect(persistSeed(store, key, seed)).toEqual({ durability: 'session', reason: 'storage-unreadable' })
    expect(readSeed(store, key)).toBe(seed)
    expect(store.status?.()).toEqual({ durability: 'session', reason: 'storage-unreadable' })
  })

  test('a custom store cannot claim persistent while dropping the write', () => {
    const store: SeedStore = {
      read: () => null,
      write: () => ({ durability: 'persistent' }),
    }
    expect(persistSeed(store, 'kei:seed:test-false-persistent', randomSeed())).toEqual({
      durability: 'session',
      reason: 'storage-write-refused',
    })
  })

  test('a custom store cannot claim persistent when the seed cannot be read', () => {
    const store: SeedStore = {
      read: () => {
        throw new Error('storage is disabled')
      },
      write: () => ({ durability: 'persistent' }),
    }
    expect(persistSeed(store, 'kei:seed:test-false-readable', randomSeed())).toEqual({
      durability: 'session',
      reason: 'storage-unreadable',
    })
  })

  test("a store whose write throws does not take the caller's wallet down with it", () => {
    const store: SeedStore = {
      read: () => null,
      write: () => {
        throw new Error('storage is disabled')
      },
    }
    expect(persistSeed(store, 'kei:seed:test-throwing', randomSeed())).toEqual({
      durability: 'session',
      reason: 'storage-write-refused',
    })
  })

  test('a store whose read throws leaves the write unverified, not persistent', () => {
    // The write claimed nothing, so the read-back is the only evidence there
    // was — and it threw. Calling that persistent would be the original defect
    // with a different exception in the middle of it.
    const store: SeedStore = {
      read: () => {
        throw new Error('storage is disabled')
      },
      write: () => undefined,
    }
    expect(persistSeed(store, 'kei:seed:test-read-throws', randomSeed())).toEqual({
      durability: 'session',
      reason: 'storage-unreadable',
    })
  })

  test('readSeed treats a store that throws as a store with nothing in it', () => {
    const store: SeedStore = {
      read: () => {
        throw new Error('the operation is insecure')
      },
      write: () => undefined,
    }
    expect(readSeed(store, 'kei:seed:test-read-throws-start')).toBe(null)
  })

  test('a store whose status() throws is session, not taken at its word', () => {
    // A store with no `status()` is the older shape and is believed after a
    // read-back. One that has a `status()` which throws is broken, and a broken
    // store cannot promise a reload.
    const kept = new Map<string, string>()
    const store: SeedStore = {
      read: (key) => kept.get(key) ?? null,
      write: (key, seed) => void kept.set(key, seed),
      status: () => {
        throw new Error('cannot answer that')
      },
    }
    expect(persistSeed(store, 'kei:seed:test-status-throws', randomSeed())).toEqual({
      durability: 'session',
      reason: 'store-session-only',
    })
  })

  test('a store that declares itself session-only is believed, however well it reads back', () => {
    const kept = new Map<string, string>()
    const store: SeedStore = {
      read: (key) => kept.get(key) ?? null,
      write: (key, seed) => void kept.set(key, seed),
      status: () => ({ durability: 'session' }),
    }
    expect(persistSeed(store, 'kei:seed:test-declared', randomSeed())).toEqual({
      durability: 'session',
      reason: 'store-session-only',
    })
  })

  test('the older void-returning store still works, and is verified by read-back', () => {
    const kept = new Map<string, string>()
    const store: SeedStore = {
      read: (key) => kept.get(key) ?? null,
      write: (key, seed) => void kept.set(key, seed),
    }
    expect(persistSeed(store, 'kei:seed:test-legacy', randomSeed())).toEqual({ durability: 'persistent' })
  })
})

describe('Kei.start() says whether this wallet survives a reload (SPEC §6.4)', () => {
  test('a saved wallet reports persistent, and a reload finds the same address and balance', async () => {
    const node = await MockNode.create()
    const storage = browserStorage()
    await withLocalStorage(storage, async () => {
      const first = await Kei.start({ node, storage: pageStorage('saved') })
      expect(first.custody).toMatchObject({ durability: 'persistent', origin: 'generated' })
      expect(storage.disk.get(`${seedStoreKey('mock')}#saved`)).toBe(first.seed)
      await first.faucet()
      first.close()

      // A reload: the page is new, the store is new, the disk is the same one.
      const second = await Kei.start({ node, storage: pageStorage('saved') })
      expect(second.address).toBe(first.address)
      expect(await second.balance()).toBeGreaterThan(0)
      expect(second.custody).toMatchObject({ durability: 'persistent', origin: 'restored' })
      second.close()
    })
  })

  test('a wallet nothing could save reports session, keeps one address for this session, and never leaks the seed', async () => {
    // Its own network, so the session copy this case creates cannot be mistaken
    // for a saved wallet by any other test in the run.
    const node = await MockNode.create({ network: 'testnet' })
    await withLocalStorage(quotaExhausted(), async () => {
      const logs = spyConsole()
      const kei = await Kei.start({ node, storage: pageStorage('unsaveable') }).finally(() => logs.restore())

      expect(kei.custody.durability).toBe('session')
      expect(kei.custody.reason).toBe('storage-write-refused')
      expect(kei.custody.message).toContain('not saved')
      expect(kei.custody.message).toContain('reload')
      expect(containsSecret(kei.custody.message)).toBe(false)
      expect(containsSecret(JSON.stringify(kei.custody))).toBe(false)
      expect(logs.calls.filter((line) => containsSecret(line))).toEqual([])

      // The wallet still works — it is the not-saying-so that was the defect.
      await kei.faucet()
      expect(await kei.balance()).toBeGreaterThan(0)

      // A second component on the same page gets the same wallet, not a second
      // one that quietly abandons the balance the first was funded with.
      const alongside = await Kei.start({ node, storage: pageStorage('unsaveable') })
      expect(alongside.address).toBe(kei.address)
      expect(alongside.custody.durability).toBe('session')

      kei.close()
      alongside.close()
    })
  })

  test('two starts on one page share the refused wallet; a reload gets a different one and never calls it saved', async () => {
    // No `storage` option and no key namespacing: this is the path a game
    // actually takes, `defaultSeedStore()` over `globalThis.localStorage`. The
    // session map it keeps belongs to *this* `storage` object, which is created
    // here and used nowhere else, so `kei:seed:testnet` in it is this case's
    // alone. The blocked-storage case below claims the same key in the
    // process-memory store — a different store with a different map — and
    // every other case here goes through `pageStorage()`.
    const node = await MockNode.create({ network: 'testnet' })
    const storage = quotaExhausted()

    await withLocalStorage(storage, async () => {
      const logs = spyConsole()
      const first = await Kei.start({ node }).finally(() => logs.restore())
      expect(first.custody).toMatchObject({
        durability: 'session',
        origin: 'generated',
        reason: 'storage-write-refused',
      })
      await first.faucet()
      const funded = await first.balance()
      expect(funded).toBeGreaterThan(0)

      // Second component, same page, same tick: the same wallet, down to the
      // balance. Before this, it was a second address and an abandoned one.
      const alongside = await Kei.start({ node })
      expect(alongside.address).toBe(first.address)
      expect(alongside.seed).toBe(first.seed)
      expect(await alongside.balance()).toBe(funded)
      // Restored from the session copy, and still not a durability claim.
      expect(alongside.custody).toMatchObject({
        durability: 'session',
        origin: 'restored',
        reason: 'storage-write-refused',
      })

      // A reload is a new runtime: the same refusing storage, and nothing
      // remembered about the writes it refused. The session copy must not
      // survive it, and what comes back must not pretend it was saved.
      const reloaded = await Kei.start({ node, storage: createBrowserSeedStore(storage, new Map()) })
      expect(reloaded.address).not.toBe(first.address)
      expect(reloaded.custody).toMatchObject({
        durability: 'session',
        origin: 'generated',
        reason: 'storage-write-refused',
      })
      // The loss the panel warns about, demonstrated: the funded address is
      // gone with the old session.
      expect(await reloaded.balance()).toBe(0)

      for (const custody of [first.custody, alongside.custody, reloaded.custody]) {
        expect(containsSecret(custody.message)).toBe(false)
        expect(containsSecret(JSON.stringify(custody))).toBe(false)
      }
      expect(logs.calls.filter((line) => containsSecret(line))).toEqual([])

      first.close()
      alongside.close()
      reloaded.close()
    })
  })

  test('a page that may not touch localStorage at all starts, twice, and calls neither wallet saved', async () => {
    // The startup half of the blocked-storage case. The store-level test above
    // proves `defaultSeedStore()` survives the throwing property access; this
    // one proves `Kei.start()` does, on the path a game actually takes — no
    // `storage` option, so `Kei.start()` reaches `defaultSeedStore()` itself
    // and the throw happens inside the SDK rather than inside the test.
    //
    // Blocked storage means there is no browser store at all, so the fallback
    // is the process-memory one and the key is the un-namespaced
    // `kei:seed:testnet` in it. Nothing else in the suite writes that key
    // there: every other seedless start outside a browser is on `mock`.
    const node = await MockNode.create({ network: 'testnet' })

    await withThrowingLocalStorageProperty(async () => {
      const logs = spyConsole()
      try {
        // Before the property access was guarded, this line threw a
        // SecurityError out of `defaultSeedStore()` and took the game with it.
        const first = await Kei.start({ node })
        expect(first.custody).toMatchObject({
          durability: 'session',
          origin: 'generated',
          reason: 'no-browser-storage',
        })

        // Second component, same page. The seed the first start generated is
        // kept for the session, so this is the same wallet — not a second one
        // that abandons whatever the first was sent.
        const second = await Kei.start({ node })
        expect(second.address).toBe(first.address)
        expect(second.seed).toBe(first.seed)
        expect(second.custody).toMatchObject({
          durability: 'session',
          origin: 'restored',
          reason: 'no-browser-storage',
        })

        // And it is a working wallet, funded once and seen twice.
        await first.faucet()
        expect(await second.balance()).toBeGreaterThan(0)

        // Nothing the player, the console, or a bug report can see carries
        // either seed — the message is built from the codes alone (SPEC §6.6).
        for (const custody of [first.custody, second.custody]) {
          expect(containsSecret(custody.message)).toBe(false)
          expect(containsSecret(JSON.stringify(custody))).toBe(false)
        }
        expect(logs.calls.filter((line) => containsSecret(line))).toEqual([])

        // `containsSecret` answers from the secret registry, so it only proves
        // this much for seeds something remembered to register. Both seeds are
        // in hand here, so the same claim can be made against the literal
        // strings and hold whether or not the registry ever saw them.
        const shown = [
          first.custody.message,
          second.custody.message,
          JSON.stringify(first.custody),
          JSON.stringify(second.custody),
          ...logs.calls,
        ].join('\n')
        for (const seed of [first.seed, second.seed]) {
          // Guards the assertion below from passing on an empty string.
          expect(seed).toMatch(/^[0-9A-F]{64}$/)
          expect(shown).not.toContain(seed)
        }

        first.close()
        second.close()
      } finally {
        logs.restore()
      }
    })

    // Restored exactly as it was found, whether that was a value, a getter, or
    // nothing at all — every later case in this run depends on it.
    const scope = globalThis as { localStorage?: unknown }
    expect(() => scope.localStorage).not.toThrow()
  })

  test('storage that will not read back is session-only too', async () => {
    const node = await MockNode.create()
    await withLocalStorage(unreadableStorage(), async () => {
      const kei = await Kei.start({ node, storage: pageStorage('unreadable') })
      expect(kei.custody).toMatchObject({ durability: 'session', reason: 'storage-unreadable' })
      kei.close()
    })
  })

  test('outside a browser the wallet is session-only, and says which reason applies', async () => {
    const node = await MockNode.create()
    await withoutLocalStorage(async () => {
      // Origin is deliberately not asserted: the process-memory store is shared
      // by every seedless `Kei.start()` in this run, so this wallet may have
      // been generated by an earlier test file and restored here. What must
      // hold either way is that it is never called persistent.
      const kei = await Kei.start({ node })
      expect(kei.custody.durability).toBe('session')
      expect(kei.custody.reason).toBe('no-browser-storage')
      expect(kei.custody.message).toContain('KEI_PLAYER_SEED')
      kei.close()
    })
  })

  test('requireDurableSeed refuses rather than hand back a wallet nothing keeps', async () => {
    const node = await MockNode.create()
    await withLocalStorage(quotaExhausted(), async () => {
      const attempt = Kei.start({ node, storage: pageStorage('required'), requireDurableSeed: true })
      await expect(attempt).rejects.toThrow(KeiError)
      const error = (await attempt.catch((thrown: unknown) => thrown)) as KeiError
      expect(error.code).toBe('seed-not-durable')
      expect(error.message).toContain('browser storage refused')
      expect(error.message).toContain('seed:')
      expect(containsSecret(error.message)).toBe(false)
      expect(containsSecret(error.stack ?? '')).toBe(false)
    })
  })

  test('a durable wallet passes requireDurableSeed without an argument about it', async () => {
    const node = await MockNode.create()
    await withLocalStorage(browserStorage(), async () => {
      const kei = await Kei.start({ node, storage: pageStorage('required-ok'), requireDurableSeed: true })
      expect(kei.custody.durability).toBe('persistent')
      kei.close()
    })
  })
})

describe('a seed the caller supplied is a different thing from one the SDK made', () => {
  test('an explicit seed is reported as supplied, and no store is touched', async () => {
    const node = await MockNode.create()
    const seed = randomSeed()
    const storage = countingStore()
    const kei = await Kei.start({ node, seed, storage: storage.store })

    expect(kei.custody).toMatchObject({ durability: 'supplied', origin: 'supplied' })
    expect(kei.custody.reason).toBeUndefined()
    expect(kei.seed).toBe(seed.toUpperCase())
    expect(storage.reads()).toBe(0)
    expect(storage.writes()).toBe(0)
    expect(containsSecret(kei.custody.message)).toBe(false)
    kei.close()
  })

  test('KEI_PLAYER_SEED is supplied too — the environment is the caller', async () => {
    const node = await MockNode.create()
    const seed = randomSeed()
    const env = (globalThis as { process: { env: Record<string, string | undefined> } }).process.env
    const had = env.KEI_PLAYER_SEED
    env.KEI_PLAYER_SEED = seed
    try {
      const kei = await Kei.start({ node, storage: { read: () => null, write: () => undefined } })
      expect(kei.custody).toMatchObject({ durability: 'supplied', origin: 'environment' })
      expect(kei.seed).toBe(seed.toUpperCase())
      expect(containsSecret(kei.custody.message)).toBe(false)
      kei.close()
    } finally {
      if (had === undefined) delete env.KEI_PLAYER_SEED
      else env.KEI_PLAYER_SEED = had
    }
  })

  test('an issuer seed is the caller\'s, and Kei.server() says so', async () => {
    const node = await MockNode.create()
    const game = await Kei.server({ node, seed: 'C'.repeat(64) })
    expect(game.custody).toMatchObject({ durability: 'supplied', origin: 'supplied' })
    game.close()
  })
})
