/**
 * Item stats.
 *
 * A sword that is only a name and a picture is not an item a game can use: it
 * needs an attack number. SPEC §7 settled that an item is a native token with
 * supply 1, and that the issuance record carries name, description and an image
 * pointer — so there is no field left to invent one for. Stats therefore ride in
 * the description, after a marker, as canonical JSON:
 *
 *     A sturdy blade.
 *     kei:stats:{"attack":12,"speed":3}
 *
 * The alternatives were worse. A new payload field is a wire change, and the
 * wire is shared with the node (SPEC §5.6.8) — the SDK cannot add a field
 * unilaterally without producing blocks the node rejects. An IPFS document costs
 * a fetch to answer "how much damage does this do", which is a question the
 * combat loop asks. The description is 256 bytes the chain already carries, and
 * a stat block is tens of bytes; a reader that has never heard of stats prints
 * the human line and then a machine line rather than garbage.
 *
 * Stats are flat and immutable. Flat because canonicalising a tree is a
 * standards document, not a helper, and because a stat is a number. Immutable
 * because issuance metadata is immutable — see `variantOf` in items.ts for what
 * that means for an item whose stats change.
 */

import { MAX_DESCRIPTION, blake2b, bytesToHex, fail, utf8 } from '@keicoin/core'

/** What a game can hang off an item. Flat: a stat is a number, a tag or a flag. */
export type ItemStats = Record<string, number | string | boolean>

/** Everything after this on its own line is machine-read, not prose. */
export const STATS_MARKER = '\nkei:stats:'

/**
 * Key-sorted, whitespace-free JSON, so the same stats always produce the same
 * bytes — which is what lets the asset id commit to them.
 */
export function canonicalStats(stats: ItemStats): string {
  const keys = Object.keys(stats).sort()
  const ordered: Record<string, number | string | boolean> = {}
  for (const key of keys) {
    if (key === '') fail('bad-stats', 'A stat needs a name, and one of these is an empty string.')
    const value = stats[key]
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        fail('bad-stats', `Stat "${key}" is ${String(value)}, and only finite numbers survive a round trip.`)
      }
    } else if (typeof value !== 'string' && typeof value !== 'boolean') {
      fail(
        'bad-stats',
        `Stat "${key}" is ${value === null ? 'null' : typeof value}. Stats are flat: numbers, strings and booleans only, because a nested value has no one canonical spelling and so no stable item id.`,
      )
    }
    ordered[key] = value as number | string | boolean
  }
  return JSON.stringify(ordered)
}

/** An empty stat block is treated as no stat block, so ids stay stable. */
export function hasStats(stats: ItemStats | undefined): stats is ItemStats {
  return stats !== undefined && Object.keys(stats).length > 0
}

/**
 * Pack prose and stats into the one description field the chain has, refusing
 * rather than truncating: a silently clipped stat block decodes as no stats at
 * all, and the game would find out in a player's inventory.
 */
export function encodeDescription(
  description: string | undefined,
  stats: ItemStats | undefined,
): string | undefined {
  if (!hasStats(stats)) return description
  const encoded = (description ?? '') + STATS_MARKER + canonicalStats(stats)
  const size = utf8(encoded).length
  if (size > MAX_DESCRIPTION) {
    fail(
      'description-too-long',
      `This item's description and stats come to ${size} bytes and the chain carries ${MAX_DESCRIPTION} (SPEC §7). Shorten the description or use fewer, shorter stat names — the stats are the part a game reads.`,
    )
  }
  return encoded
}

/** The inverse: what the chain stored, split back into the two things it holds. */
export function decodeDescription(field: string | undefined): {
  description?: string
  stats?: ItemStats
} {
  if (field === undefined) return {}
  // Last, not first: the encoder always appends, so a description that itself
  // mentions the marker cannot shadow the real stat block.
  const at = field.lastIndexOf(STATS_MARKER)
  if (at === -1) return { description: field }

  const prose = field.slice(0, at)
  const stats = parseStats(field.slice(at + STATS_MARKER.length))
  // A description that merely happens to contain the marker is not a stat block;
  // hand back what the chain stored rather than eating half of it.
  if (stats === undefined) return { description: field }
  return { ...(prose === '' ? {} : { description: prose }), stats }
}

/** Undefined rather than a throw: reading somebody else's item must not explode. */
function parseStats(json: string): ItemStats | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const stats: ItemStats = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') return undefined
    stats[key] = value
  }
  return stats
}

/**
 * A symbol for a stat-bearing item: a readable stub plus a digest over the
 * stats, so the asset id commits to them.
 *
 * Two consequences, both wanted. Re-running the same drop is free, because the
 * same stats derive the same id and issuance is idempotent (SPEC §5.6.1). And an
 * item cannot be re-statted behind a player's back: different stats are a
 * different asset, not an edit.
 *
 * `scope` separates a variant of a base item from a fresh item that happens to
 * share a name and a stat block.
 */
export function statSymbolFor(name: string, stats: ItemStats, scope = ''): string {
  const text = String(name ?? '').trim()
  if (text === '') fail('bad-name', 'A stat-bearing item needs a name — that is what its symbol is derived from.')
  const stub = text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 7)
    .replace(/-+$/g, '')
  // 20 characters is the node's max_symbol: 7 of stub, a hyphen, and 6 bytes of
  // digest. 48 bits over a game's catalogue of stat rolls, not over the world.
  // Length-prefixed so no combination of scope, name and stats can collide by
  // running one field into the next.
  const input = [scope, text, canonicalStats(stats)].map((part) => `${part.length}:${part}`).join('')
  return `${stub === '' ? 'ITEM' : stub}-${bytesToHex(blake2b(utf8(input), 6))}`
}
