/**
 * Loot tables as commitments (SPEC §5.5).
 *
 * A drop table is the third thing a game economy is made of, after the currency
 * and the shop, and it is the one the ledger can say something surprising about.
 * A shop sale is a swap and nobody has to be trusted for the other half. A drop
 * is not: the game decides what fell out of the boss, and on every other stack
 * in the world the player's only option is to believe it.
 *
 * What this buys them instead is one checkable sentence: **the batch was
 * published for the table you were shown.** The table — every asset it can drop,
 * every amount, every weight — hashes to a digest. The digest goes into the
 * salt of the commit's Merkle root, which is one leaf of the tree the issuer
 * publishes in a single block. So a player holding an award can fold two paths
 * up to the same root the ledger already accepted:
 *
 * - `saltLeaf(H(digest ‖ nonce))` → the root **commits to this table**.
 * - `leafHash(me, asset, amount)` → the root **owes me this**.
 *
 * A game that changes the table after the fight changes the digest, and no
 * nonce recovers the salt inside a root it already published.
 *
 * **Be exact about what that is not.** It is not verifiable randomness. The roll
 * happens on the game's server, out of the chain's sight, and nothing here
 * proves the weights were honoured — a game that publishes a 1% crown and never
 * rolls one is not caught by this. What it catches is the larger and duller
 * class: a table quietly rewritten between the announcement and the drop, an
 * award for something the table never listed, an amount nobody was promised, and
 * an award minted for one player and handed to another. Every one of those is a
 * sentence out of `verifyDrop()` rather than an argument in a forum.
 *
 * The distributed-writes property is the point of the shape, and it is inherited
 * rather than invented: one issuer block underwrites a thousand player claims,
 * each written by a different account, in parallel, with no ordering contention
 * (SPEC §5.5). Minting per drop would put every one of them behind the issuer's
 * own chain.
 */

import type { AssetId } from '@keicoin/core'
import {
  blake2b,
  bytesToHex,
  combineHashes,
  concat,
  fail,
  hexToBytes,
  isHex,
  leafHash,
  publicKeyFromAddress,
  randomSalt,
  saltLeaf,
  utf8,
  verifyProof,
} from '@keicoin/core'
import type { ClaimBundle } from '@keicoin/claims'

import type { AssetRef } from './recipe.js'

/**
 * Bumping this invalidates every digest, which is the point of having it: the
 * salt binding is a promise about a serialisation, and a serialisation that
 * changes silently is a promise that quietly stops meaning anything.
 */
const TABLE_DOMAIN = 'kei-drop-table-v1'
const SALT_DOMAIN = 'kei-drop-salt-v1'

// -------------------------------------------------------------- declaration

export interface DropSpec {
  /** What falls out. The same asset reference recipes take. */
  asset: AssetRef
  /** How much of it. Defaults to 1, which is the item case. */
  amount?: number | string
  /** Relative likelihood against every other row and against `nothing`. Default 1. */
  weight?: number
}

export interface DropTableSpec {
  /** Stable id. It is how the server and the browser name the same table. */
  id: string
  /** Shown to players. Defaults to the id. */
  name?: string
  /**
   * The account that publishes this table's batches and issues what it drops.
   * Defaults to whoever calls `economy.drop()`.
   */
  issuer?: string
  drops: readonly DropSpec[]
  /**
   * How often this table pays out nothing, weighted against the rows. Default 0
   * — a table that always drops something. Declared rather than implied, because
   * a miss rate is part of what the digest promises: a game cannot publish
   * "always a sword" and then quietly roll empty half the time.
   */
  nothing?: number
}

/** One row of a table, normalised and frozen. */
export interface Drop {
  readonly asset: AssetRef
  /** Exact decimal text, canonicalised, so two spellings of 0.50 hash alike. */
  readonly amount: string
  readonly weight: number
}

/** What a table publishes about itself: the odds, as declared. */
export interface Odds {
  /** Null for the `nothing` row. */
  readonly drop: Drop | null
  readonly weight: number
  /** Share of rolls, between 0 and 1. */
  readonly chance: number
}

export interface DropTable {
  readonly id: string
  readonly name: string
  readonly issuer?: string
  readonly drops: readonly Drop[]
  readonly nothing: number
  /** 64 hex characters over the declaration. What the published root binds to. */
  readonly digest: string
  /** Every row and its chance, in declaration order, with `nothing` last. */
  readonly odds: readonly Odds[]
}

/**
 * Validate a table, hash it, and freeze it.
 *
 * Pure and synchronous, like `defineRecipe()`: it reads no chain and signs
 * nothing, so it belongs in the file both halves of the game import. That shared
 * file is what makes the digest worth anything — the player's copy of the table
 * is not a copy the server sent them.
 */
export function defineDropTable(spec: DropTableSpec): DropTable {
  if (!spec || typeof spec !== 'object') {
    fail(
      'bad-drop-table',
      "defineDropTable() takes { id, drops } — for example defineDropTable({ id: 'dragon', drops: [{ asset: gold, amount: 50, weight: 60 }, { asset: sword, weight: 1 }] }).",
    )
  }
  const id = String(spec.id ?? '').trim()
  if (id === '') {
    fail(
      'bad-drop-table',
      "A drop table needs an id: it is how the server and the browser name the same table, and it travels with every award. Try { id: 'dragon-hoard' }.",
    )
  }
  if (!Array.isArray(spec.drops) || spec.drops.length === 0) {
    fail(
      'empty-drop-table',
      `Drop table "${id}" lists nothing that can drop, so rolling it could only ever pay out nothing. Give it drops: [{ asset: gold, amount: 50, weight: 60 }, ...].`,
    )
  }

  const drops = Object.freeze(spec.drops.map((drop, index) => normalizeDrop(drop, id, index)))
  const nothing = weightOf(spec.nothing, `nothing on drop table "${id}"`, 0)
  const total = drops.reduce((sum, drop) => sum + drop.weight, 0) + nothing
  if (total <= 0) {
    fail(
      'no-weight',
      `Every row of drop table "${id}" has a weight of zero, so no roll can land anywhere. Weights are relative, so any positive numbers will do — { weight: 1 } on each row is a flat table.`,
    )
  }

  const digest = digestOf(id, drops, nothing)
  const odds = Object.freeze([
    ...drops.map((drop) => Object.freeze({ drop, weight: drop.weight, chance: drop.weight / total })),
    ...(nothing > 0 ? [Object.freeze({ drop: null, weight: nothing, chance: nothing / total })] : []),
  ])

  return Object.freeze({
    id,
    name: spec.name === undefined ? id : String(spec.name),
    ...(spec.issuer === undefined ? {} : { issuer: String(spec.issuer) }),
    drops,
    nothing,
    digest,
    odds,
  })
}

/** A whole set of tables at once, keyed by id. */
export function defineDropTables(specs: readonly DropTableSpec[]): Map<string, DropTable> {
  if (!Array.isArray(specs)) {
    fail('bad-drop-table', 'defineDropTables() takes an array of tables. Pass one table to defineDropTable() instead.')
  }
  const out = new Map<string, DropTable>()
  for (const spec of specs) {
    const table = defineDropTable(spec)
    if (out.has(table.id)) {
      fail(
        'duplicate-drop-table',
        `Two drop tables here are both called "${table.id}", and an id is how the server and the browser agree on which one they mean. Rename one of them.`,
      )
    }
    out.set(table.id, table)
  }
  return out
}

/**
 * Whether this came out of `defineDropTable()`.
 *
 * The digest is recomputed rather than trusted. An object carrying a `digest`
 * field is not a table that hashes to it, and the one thing this predicate is
 * for is deciding whether a value may skip revalidation — so a digest nobody
 * checked is the exact hole worth closing.
 */
export function isDropTable(value: DropTable | DropTableSpec): value is DropTable {
  if (!Object.isFrozen(value)) return false
  const candidate = value as Partial<DropTable>
  if (typeof candidate.id !== 'string' || candidate.id === '') return false
  if (typeof candidate.digest !== 'string' || !Array.isArray(candidate.drops)) return false
  if (typeof candidate.nothing !== 'number') return false
  for (const drop of candidate.drops) {
    if (!drop || typeof drop.amount !== 'string' || typeof drop.weight !== 'number') return false
    if (!namesAnAsset(drop.asset)) return false
  }
  return digestOf(candidate.id, candidate.drops, candidate.nothing) === candidate.digest
}

// ----------------------------------------------------------------- the roll

/**
 * Pick a row, or `null` for a miss.
 *
 * `random` is a uniform source on [0, 1). It exists so a test can be a test;
 * the default is the platform CSPRNG, because a game seeding this from the clock
 * is a game whose loot is predictable to anyone who can read a timestamp.
 */
export function rollDropTable(table: DropTable, random: () => number = uniform): Drop | null {
  const total = table.drops.reduce((sum, drop) => sum + drop.weight, 0) + table.nothing
  const value = random()
  if (!(value >= 0) || value >= 1) {
    fail('bad-random', `A drop table's random source returns a number in [0, 1) — got ${String(value)}.`)
  }
  // Integer weights and an integer target: no rounding decides whether the 1-in-
  // a-thousand crown drops.
  let target = Math.floor(value * total)
  for (const drop of table.drops) {
    target -= drop.weight
    if (target < 0) return drop
  }
  return null
}

function uniform(): number {
  const source = (globalThis as { crypto?: { getRandomValues?(into: Uint32Array): Uint32Array } }).crypto
  if (!source?.getRandomValues) {
    fail('no-randomness', 'No secure random source available for a drop roll. Use Node 18+, Bun, or a modern browser.')
  }
  const bytes = new Uint32Array(1)
  source.getRandomValues(bytes)
  return (bytes[0] as number) / 2 ** 32
}

// ------------------------------------------------------------- the binding

/**
 * The salt a batch published for this table carries.
 *
 * `nonce` is fresh per batch and revealed with the awards. It is not a secret —
 * it exists so two batches of the same table are two different roots, which the
 * ledger requires (a duplicate root is refused), and so the salt cannot be
 * precomputed into a table of digests.
 */
export function dropSalt(digest: string, nonce: string): string {
  if (!isHex(digest, 32)) fail('bad-digest', 'A drop table digest is 64 hex characters.')
  if (!isHex(nonce, 32)) fail('bad-nonce', 'A drop nonce is 64 hex characters.')
  return bytesToHex(
    blake2b(concat(utf8(SALT_DOMAIN), hexToBytes(digest), hexToBytes(nonce)), 32),
  ).toUpperCase()
}

/**
 * What a player is handed. It is a `ClaimBundle` with the binding attached, so
 * `kei.claims.add(award)` takes it unchanged and the extra fields ride along.
 */
export interface DropAward extends ClaimBundle {
  /** The table id, so an award found in storage knows what to check itself against. */
  table: string
  /** The digest the root's salt commits to. */
  digest: string
  /** This batch's nonce, revealed. */
  nonce: string
  /** The path from the salt leaf to the root. */
  saltProof: string[]
  /** For showing the player. `amount` above stays raw, because a proof is exact. */
  symbol: string
  itemName: string
  quantity: number
}

/** What survived `verifyDrop()`. */
export interface VerifiedDrop {
  table: DropTable
  root: string
  asset: AssetId
  symbol: string
  quantity: number
  /** The declared row this award matched. */
  drop: Drop
  /** That row's published chance. */
  chance: number
}

/**
 * The half of verification that needs no chain: the award's asset id and raw
 * amount are taken as given, and everything binding them to a root and a table
 * is checked here.
 *
 * Split out from `economy.verifyDrop()` because the remaining check — that the
 * pair is one the table actually declares — needs `assetInfo` to turn a symbol
 * into an id and an amount into raw units, and a wallet holding an award offline
 * can still run everything below.
 */
export function assertAwardShape(award: DropAward): void {
  if (!award || typeof award !== 'object') {
    fail('bad-award', 'A drop award looks like { root, asset, amount, proof, table, digest, nonce, saltProof } — the game gives you one.')
  }
  if (!isHex(award.root, 32)) fail('bad-award', "A drop award's root is 64 hex characters.")
  if (!isHex(award.asset, 32)) fail('bad-award', "A drop award's asset is 64 hex characters.")
  if (!/^\d+$/.test(String(award.amount))) {
    fail('bad-award', "A drop award's amount is a whole number of raw units, as a string.")
  }
  if (!Array.isArray(award.proof) || !Array.isArray(award.saltProof)) {
    fail('bad-award', "A drop award's proof and saltProof are both arrays of hashes.")
  }
}

export function checkDropBinding(award: DropAward, table: DropTable, account: string): void {
  assertAwardShape(award)
  if (award.table !== table.id) {
    fail(
      'wrong-table',
      `This award came from drop table "${String(award.table)}" and it is being checked against "${table.id}". Look the right table up by the award's own id — economy.verifyDrop(award) does that for you when the table is registered.`,
    )
  }
  if (award.digest !== table.digest) {
    fail(
      'table-changed',
      `The award for "${table.id}" was published against digest ${short(award.digest)} and this copy of the table hashes to ${short(table.digest)}. The two halves of the game are not holding the same table: something edited a row, an amount, or a weight. Import the table from the shared file both halves read, and if the game changed it after publishing this batch, that batch is what it promised and this table is not.`,
    )
  }

  const salt = dropSalt(award.digest, award.nonce)
  if (!verifyProof(saltLeaf(salt), award.saltProof, award.root)) {
    fail(
      'unbound-drop',
      `Root ${short(award.root)} does not commit to drop table "${table.id}" — its salt is not the one this table and nonce produce. Whatever that batch was published for, it was not the odds you were shown. Nothing of yours has moved; do not claim it.`,
    )
  }

  const leaf = leafHash(publicKeyFromAddress(account), award.asset, BigInt(award.amount))
  if (!verifyProof(leaf, award.proof, award.root)) {
    fail(
      'not-in-drop',
      `Root ${short(award.root)} does not owe ${account} ${award.amount} of ${short(award.asset)}. The proof is for somebody else, some other amount, or some other batch — re-fetch it from the game. The ledger would refuse this claim block for the same reason (SPEC §5.5).`,
    )
  }
}

/** Fold a leaf to a root by hand, for a caller that wants the arithmetic. */
export function foldProof(leaf: string, proof: readonly string[]): string {
  return proof.reduce((current, sibling) => combineHashes(current, sibling), leaf)
}

// ---------------------------------------------------------------- internals

function normalizeDrop(drop: DropSpec, id: string, index: number): Drop {
  const where = `drops[${index}] of drop table "${id}"`
  if (!drop || typeof drop !== 'object') {
    fail('bad-drop', `${where} is not an object. Each row looks like { asset: gold, amount: 50, weight: 60 }.`)
  }
  if (!namesAnAsset(drop.asset)) {
    fail(
      'bad-asset',
      `${where} does not name an asset. Pass the token or item object, an asset id, 'KEI', or { symbol: 'GEM', issuer: gameAddress } for a table written before the asset exists.`,
    )
  }
  return Object.freeze({
    asset: drop.asset,
    amount: canonicalAmount(drop.amount ?? 1, where),
    weight: weightOf(drop.weight, where, 1),
  })
}

function weightOf(weight: number | undefined, where: string, fallback: number): number {
  if (weight === undefined) return fallback
  if (!Number.isInteger(weight) || weight < 0) {
    fail(
      'bad-weight',
      `The weight of ${where} is a whole number, zero or more — got ${String(weight)}. Weights are relative to each other, not percentages: { weight: 60 } against { weight: 1 } is sixty times as likely.`,
    )
  }
  return weight
}

/**
 * One spelling per amount, so the digest is a property of what the table says
 * rather than of how somebody typed it. `0.50`, `.5` and `+0.5` are one number
 * and must hash as one, or two honest copies of the same table disagree.
 */
function canonicalAmount(amount: number | string, where: string): string {
  const text = typeof amount === 'number' ? formatNumber(amount, where) : String(amount).trim()
  const match = /^\+?(\d*)(?:\.(\d*))?$/.exec(text)
  if (!match || (match[1] === '' && (match[2] ?? '') === '')) {
    fail('bad-amount', `The amount in ${where} must be a positive decimal like 50 or '1.5' — got ${JSON.stringify(String(amount))}.`)
  }
  const whole = (match[1] ?? '').replace(/^0+(?=\d)/, '')
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  const canonical = fraction === '' ? whole || '0' : `${whole || '0'}.${fraction}`
  if (Number(canonical) <= 0) {
    fail('bad-amount', `The amount in ${where} must be greater than zero — got ${JSON.stringify(String(amount))}.`)
  }
  return canonical
}

/**
 * A number, spelled the way the ledger will read it. `toRaw` is not reachable
 * here — it needs the asset's decimals, and a table is written before the asset
 * is looked up — so exponent notation is refused rather than mangled.
 */
function formatNumber(amount: number, where: string): string {
  if (!Number.isFinite(amount) || amount <= 0) {
    fail('bad-amount', `The amount in ${where} must be a positive number — got ${String(amount)}.`)
  }
  const text = String(amount)
  if (text.includes('e') || text.includes('E')) {
    fail(
      'bad-amount',
      `The amount in ${where} is ${text}, which JavaScript writes in exponent notation and a ledger amount never is. Pass it as a decimal string instead: '${amount.toFixed(18).replace(/0+$/, '')}'.`,
    )
  }
  return text
}

function namesAnAsset(asset: AssetRef | undefined): boolean {
  if (typeof asset === 'string') return asset.trim() !== ''
  if (!asset || typeof asset !== 'object') return false
  if ('id' in asset && typeof asset.id === 'string' && asset.id !== '') return true
  return 'symbol' in asset && typeof asset.symbol === 'string' && asset.symbol.trim() !== ''
}

/**
 * The serialisation the digest is taken over.
 *
 * Line-oriented and tab-separated rather than JSON: a digest is a promise, and a
 * promise whose meaning depends on how a JSON serialiser orders keys or spells
 * numbers is one nobody can reimplement. Everything here is text this file wrote
 * itself, in declaration order, and a reader can see what is covered by looking
 * at it. Row order is covered too — it is what `odds` displays.
 */
function digestOf(id: string, drops: readonly Drop[], nothing: number): string {
  const lines = [
    TABLE_DOMAIN,
    id,
    String(nothing),
    ...drops.map((drop) => `${refKey(drop.asset)}\t${drop.amount}\t${drop.weight}`),
  ]
  return bytesToHex(blake2b(utf8(lines.join('\n')), 32)).toUpperCase()
}

/**
 * How a row's asset reference is spelled inside the digest.
 *
 * A table naming `{ symbol: 'GEM' }` and one naming the resolved id are two
 * different declarations and hash differently, which is correct: they are the
 * same asset only once a chain has been asked, and the digest is what the two
 * halves of the game compare before either of them asks.
 */
function refKey(asset: AssetRef): string {
  if (typeof asset === 'string') return `ref\t${asset.trim().toUpperCase()}`
  if ('id' in asset && typeof asset.id === 'string' && asset.id !== '') return `id\t${asset.id.trim().toUpperCase()}`
  const named = asset as { symbol: string; issuer?: string }
  return `symbol\t${named.symbol.trim().toUpperCase()}\t${named.issuer === undefined ? '' : named.issuer.trim()}`
}

function short(hash: string): string {
  const text = String(hash)
  return text.length <= 16 ? text : `${text.slice(0, 12)}…`
}

/** 32 fresh bytes. Not a secret, and revealed with the awards. */
export function dropNonce(): string {
  return randomSalt()
}
