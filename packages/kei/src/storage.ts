/**
 * Where a player's seed lives, and whether it actually survives a reload.
 *
 * SPEC §6.4: the seed is generated client-side, persisted in browser storage,
 * and never transmitted anywhere. Browser storage is not durable — private
 * browsing, disabled storage, and a full quota all make `setItem` throw, and
 * some of them make `getItem` throw too — which is why §6.4 also requires the
 * wallet to say so before a player puts anything of value in it.
 *
 * The rule this file exists to enforce: **a store that cannot promise a reload
 * says so, rather than swallowing the failure.** A write is verified by reading
 * it back, a store that only holds memory declares itself session-only, and the
 * seed that could not be saved is still kept for the rest of the session so the
 * address does not change under a page that is already using it.
 */

/**
 * How long this wallet's seed lasts.
 *
 * - `'persistent'` — written to browser storage and read back from it, so a
 *   reload finds the same wallet.
 * - `'session'` — memory only. A reload, or a second tab, is a different
 *   wallet, and anything sent to this address is lost with it.
 * - `'supplied'` — you passed the seed (or `KEI_PLAYER_SEED`), so keeping it is
 *   yours to do and the SDK stored nothing.
 */
export type SeedDurability = 'persistent' | 'session' | 'supplied'

/** Why a seed is session-only. Stable; the message beside it is the sentence. */
export type SeedSessionReason =
  | 'no-browser-storage'
  | 'storage-write-refused'
  | 'storage-unreadable'
  | 'store-session-only'

/** What a store reports about the seed it just wrote, or the one it just read. */
export interface SeedWriteResult {
  durability: 'persistent' | 'session'
  /** Set whenever `durability` is `'session'`. */
  reason?: SeedSessionReason
}

export interface SeedStore {
  read(key: string): string | null
  /**
   * Returning a result is how a store reports that a write did not land.
   * Returning nothing still works — the seed is read back and compared instead
   * — so a store written against the older `void` shape keeps working, it just
   * cannot distinguish "saved" from "saved somewhere that forgets".
   */
  write(key: string, seed: string): SeedWriteResult | void
  /**
   * Optional. What this store can promise about the value it last read or
   * wrote. A store with no `status()` is taken at its word when a read-back
   * verifies, so an in-memory store that wants to be honest implements this and
   * returns `{ durability: 'session' }`.
   */
  status?(): SeedWriteResult
}

/** The two `localStorage` methods this file uses, and nothing else. */
export interface WebStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

class MemorySeedStore implements SeedStore {
  private readonly seeds = new Map<string, string>()

  constructor(private readonly reason: SeedSessionReason) {}

  read(key: string): string | null {
    return this.seeds.get(key) ?? null
  }

  write(key: string, seed: string): SeedWriteResult {
    this.seeds.set(key, seed)
    return { durability: 'session', reason: this.reason }
  }

  status(): SeedWriteResult {
    return { durability: 'session', reason: this.reason }
  }
}

/**
 * A seed browser storage refused, kept under the key it was refused for.
 *
 * Keyed, rather than one seed and one reason for the whole module, because a
 * page can hold wallets for more than one network: `kei:seed:mock` failing a
 * write must not change what `kei:seed:testnet` reports about itself. The seed
 * and the reason are one entry for the same purpose — the wallet a read hands
 * back and the durability it is described with have to be the same event.
 */
type SessionSeeds = Map<string, { seed: string; reason: SeedSessionReason }>

/**
 * One session map per storage object, because a key is only half an identity.
 *
 * Two stores over the *same* `localStorage` are the same page and must share
 * what one of them could not save — that is what keeps a second `Kei.start()`
 * on one address. Two stores over *different* storage objects are not, and a
 * seed one refused must never be handed back by the other: nothing about
 * storage `A` refusing `kei:seed:testnet` says anything about storage `B`.
 *
 * Weak, so a storage object that goes away takes its kept seeds with it, and a
 * fresh runtime — the thing a reload actually is — starts with none.
 */
const sessionSeedsByStorage = new WeakMap<WebStorage, SessionSeeds>()

function sessionSeedsFor(storage: WebStorage): SessionSeeds {
  const existing = sessionSeedsByStorage.get(storage)
  if (existing) return existing
  const created: SessionSeeds = new Map()
  sessionSeedsByStorage.set(storage, created)
  return created
}

/**
 * The one store in this file that can be durable, and the one that has to prove
 * it: every call into `localStorage` is guarded, because in private browsing
 * both halves of it can throw rather than return null.
 *
 * When a write cannot be confirmed the seed goes into the session map instead.
 * That is not a durability claim — the result says `'session'` and the wallet
 * panel warns — it is what keeps one page from generating a second wallet at
 * the next `Kei.start()` and losing whatever the first one was sent.
 */
class BrowserSeedStore implements SeedStore {
  /**
   * What the last `read`/`write` on this instance was worth, which is all
   * `status()` claims to answer (`readDurability` calls it immediately after
   * the read whose durability it is asking about).
   */
  private last: SeedWriteResult | null = null

  constructor(
    private readonly storage: WebStorage,
    private readonly kept: SessionSeeds,
  ) {}

  read(key: string): string | null {
    try {
      const stored = this.storage.getItem(key)
      if (stored) {
        this.last = { durability: 'persistent' }
        return stored
      }
    } catch {
      // Storage refused the read. The session copy below is what is left.
    }
    // Kept by a failed write earlier in this session, under this key and with
    // the reason recorded for this key — this read is only how a second
    // `Kei.start()` on the same page finds the wallet the first one made.
    const kept = this.kept.get(key)
    if (kept) {
      this.last = { durability: 'session', reason: kept.reason }
      return kept.seed
    }
    this.last = null
    return null
  }

  write(key: string, seed: string): SeedWriteResult {
    try {
      this.storage.setItem(key, seed)
    } catch {
      // Private browsing, storage switched off, or the quota is full.
      return this.keepForSession(key, seed, 'storage-write-refused')
    }
    let readBack: string | null
    try {
      readBack = this.storage.getItem(key)
    } catch {
      return this.keepForSession(key, seed, 'storage-unreadable')
    }
    if (readBack !== seed) return this.keepForSession(key, seed, 'storage-write-refused')
    this.last = { durability: 'persistent' }
    return this.last
  }

  status(): SeedWriteResult {
    return this.last ?? { durability: 'persistent' }
  }

  private keepForSession(key: string, seed: string, reason: SeedSessionReason): SeedWriteResult {
    this.kept.set(key, { seed, reason })
    this.last = { durability: 'session', reason }
    return this.last
  }
}

/**
 * On a server there is nowhere obviously right to write a key, so nothing is
 * written that outlives the process: pass `seed` explicitly (or set
 * `KEI_PLAYER_SEED`) for a stable one.
 */
const processMemory = new MemorySeedStore('no-browser-storage')

/**
 * A store over one `localStorage`-shaped object.
 *
 * `kept` defaults to the session map this storage object already owns, so two
 * stores over one `localStorage` are one page. Passing a fresh map is what a
 * page reload looks like from here: the same storage, and nothing remembered
 * about the writes it refused last time.
 */
export function createBrowserSeedStore(
  storage: WebStorage,
  kept: SessionSeeds = sessionSeedsFor(storage),
): SeedStore {
  return new BrowserSeedStore(storage, kept)
}

/**
 * `globalThis.localStorage`, if there is one this code may use.
 *
 * The property access is inside the `try` deliberately: where browser policy
 * blocks storage for a page, reading the property itself throws a
 * `SecurityError` before any method on it is called.
 */
function browserStorage(): WebStorage | undefined {
  try {
    const candidate = (globalThis as { localStorage?: WebStorage }).localStorage
    if (candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function') {
      return candidate
    }
  } catch {
    // Storage exists and this page is not allowed to touch it. Same outcome as
    // not having it: a session wallet that says so, and no seed anywhere else.
  }
  return undefined
}

export function defaultSeedStore(): SeedStore {
  const storage = browserStorage()
  return storage ? createBrowserSeedStore(storage) : processMemory
}

/** `store.read`, with a store that throws treated as a store with nothing in it. */
export function readSeed(store: SeedStore, key: string): string | null {
  try {
    return store.read(key)
  } catch {
    return null
  }
}

/**
 * What the seed just read from `store` is worth.
 *
 * A store with **no** `status()` is taken at its word: it is the older shape,
 * and the read-back in `persistSeed` is what stands behind the claim. A
 * `status()` that **throws** is a different thing — the store meant to answer
 * and could not, so nothing here can promise a reload, and the honest reading
 * is session rather than a guess in the direction that loses money.
 */
export function readDurability(store: SeedStore): SeedWriteResult {
  try {
    return store.status?.() ?? { durability: 'persistent' }
  } catch {
    return { durability: 'session', reason: 'store-session-only' }
  }
}

/**
 * Write a seed and report what that was actually worth.
 *
 * A store that returns a result is believed, because it knows more than this
 * function can. A store that returns nothing is verified the only way left: the
 * seed is read back and compared, so a `setItem` that throws, silently drops the
 * value, or truncates it is a `'session'` result rather than a promise nobody
 * checked.
 */
export function persistSeed(store: SeedStore, key: string, seed: string): SeedWriteResult {
  let reported: SeedWriteResult | void
  try {
    reported = store.write(key, seed)
  } catch {
    return { durability: 'session', reason: 'storage-write-refused' }
  }
  if (reported && reported.durability === 'session') {
    return { durability: 'session', reason: reported.reason ?? 'store-session-only' }
  }
  if (!reported) {
    let readBack: string | null
    try {
      readBack = store.read(key)
    } catch {
      return { durability: 'session', reason: 'storage-unreadable' }
    }
    if (readBack !== seed) return { durability: 'session', reason: 'storage-write-refused' }
  }
  const declared = readDurability(store)
  if (declared.durability === 'session') {
    return { durability: 'session', reason: declared.reason ?? 'store-session-only' }
  }
  return { durability: 'persistent' }
}

/** Where this wallet's seed came from. */
export type SeedOrigin = 'generated' | 'restored' | 'supplied' | 'environment'

/**
 * What `Kei.start()` can honestly say about the seed it is using: where it came
 * from, whether it survives a reload, and one sentence stating the fix when it
 * does not.
 *
 * Nothing in here is ever derived from the seed itself (SPEC §6.6): `message`
 * is written from `origin` and `reason` alone, so it is safe to log, render, or
 * put in a bug report.
 */
export interface SeedCustody {
  readonly durability: SeedDurability
  readonly origin: SeedOrigin
  /** Set whenever `durability` is `'session'`. */
  readonly reason?: SeedSessionReason
  readonly message: string
}

const SESSION_CAUSE: Record<SeedSessionReason, string> = {
  'no-browser-storage': 'there is no browser storage available here to save it in',
  'storage-write-refused':
    'browser storage refused to keep it — private browsing, storage switched off, or a full quota',
  'storage-unreadable': 'browser storage would not read it back, so nothing can promise it is really there',
  'store-session-only': 'the storage passed to Kei.start() reports that it does not survive a reload',
}

const FIX =
  'It lasts as long as this page does: a reload starts a different wallet, and anything sent to this address goes with the old one. Back the seed up, or pass seed: <your own seed> to Kei.start() (KEI_PLAYER_SEED works too) so the wallet is one you keep.'

/** One custody record, with a message built from the codes rather than from the seed. */
export function describeCustody(
  origin: SeedOrigin,
  result: SeedWriteResult = { durability: 'persistent' },
): SeedCustody {
  if (origin === 'supplied' || origin === 'environment') {
    const where = origin === 'environment' ? 'KEI_PLAYER_SEED holds' : 'You supplied'
    return {
      durability: 'supplied',
      origin,
      message: `${where} this wallet's seed, so keeping it is yours to do — nothing was written to browser storage.`,
    }
  }
  if (result.durability === 'persistent') {
    return {
      durability: 'persistent',
      origin,
      message:
        origin === 'restored'
          ? 'This wallet was restored from browser storage, so a reload finds it again. Browser storage is still not a backup: clearing site data ends it.'
          : 'This wallet was saved to browser storage and read back, so a reload finds it again. Browser storage is still not a backup: clearing site data ends it.',
    }
  }
  const reason = result.reason ?? 'store-session-only'
  return {
    durability: 'session',
    origin,
    reason,
    message: `This wallet is not saved, because ${SESSION_CAUSE[reason]}. ${FIX}`,
  }
}

export function seedStoreKey(network: string): string {
  return `kei:seed:${network}`
}

export function environmentSeed(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return env?.KEI_PLAYER_SEED
}
