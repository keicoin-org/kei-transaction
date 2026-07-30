/**
 * Where a player's seed lives.
 *
 * SPEC §6.4: the seed is generated client-side, persisted in browser storage,
 * and never transmitted anywhere. Browser storage is not durable, which is why
 * §6.4 also requires a backup prompt once a wallet holds value — that prompt is
 * UI and lands with the panel at M6; the durability warning is documented here
 * and in the README so it is not a surprise.
 */

export interface SeedStore {
  read(key: string): string | null
  write(key: string, seed: string): void
}

interface WebStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

class BrowserSeedStore implements SeedStore {
  constructor(private readonly storage: WebStorage) {}

  read(key: string): string | null {
    try {
      return this.storage.getItem(key)
    } catch {
      return null
    }
  }

  write(key: string, seed: string): void {
    try {
      this.storage.setItem(key, seed)
    } catch {
      // Private browsing, or storage full. The wallet still works for this
      // session; it just will not survive a reload.
    }
  }
}

class MemorySeedStore implements SeedStore {
  private readonly seeds = new Map<string, string>()

  read(key: string): string | null {
    return this.seeds.get(key) ?? null
  }

  write(key: string, seed: string): void {
    this.seeds.set(key, seed)
  }
}

const processMemory = new MemorySeedStore()

export function defaultSeedStore(): SeedStore {
  const storage = (globalThis as { localStorage?: WebStorage }).localStorage
  if (storage && typeof storage.getItem === 'function') return new BrowserSeedStore(storage)
  // On a server there is nowhere obviously right to write a key, so nothing is
  // written: pass `seed` explicitly (or set KEI_PLAYER_SEED) for a stable one.
  return processMemory
}

export function seedStoreKey(network: string): string {
  return `kei:seed:${network}`
}

export function environmentSeed(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return env?.KEI_PLAYER_SEED
}
