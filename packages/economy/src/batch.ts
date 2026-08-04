/**
 * Publishing a drop batch, and checking one you were handed.
 *
 * `drops.ts` is the declaration and the arithmetic; nothing in it touches a
 * chain. This is the half that does, and the split is not tidiness: the table
 * has to be importable by a browser that will never publish anything, and the
 * digest it hashes has to be computable before any asset in it exists.
 *
 * The write pattern is SPEC §5.5's, unchanged: one `commit` block per asset,
 * however many players rolled it, and then a thousand claim blocks written by a
 * thousand accounts in parallel. Nothing here mints. A claim mints, on the
 * player's own chain, and that is the only reason a boss killed by a thousand
 * people at once is not a thousand writes queued behind the issuer.
 */

import type { AssetId, KeiClient } from '@keicoin/core'
import { KeiError, assertAddress, fail, formatRaw, fromRaw } from '@keicoin/core'
import { buildCommit } from '@keicoin/claims'

import { isResolved, resolveStack, type ResolvedStack } from './assets.js'
import {
  assertAwardShape,
  checkDropBinding,
  dropNonce,
  dropSalt,
  rollDropTable,
  type Drop,
  type DropAward,
  type DropTable,
  type VerifiedDrop,
} from './drops.js'

export interface DropOptions {
  /** Who publishes. Defaults to the table's issuer, then to this account. */
  issuer?: string
  /**
   * A uniform source on [0, 1), one call per player. Defaults to the platform
   * CSPRNG. It is here so a test can be deterministic, not so a game can be.
   */
  random?: () => number
  /**
   * Reproduce a specific batch. Left alone it is fresh, which is what keeps two
   * rolls of the same table from building a root the ledger has already seen.
   */
  nonce?: string
}

/** One published `commit` block: one asset, however many players rolled it. */
export interface DropRoot {
  root: string
  /** The issuer block that published it. */
  hash: string
  asset: AssetId
  symbol: string
  /** Recipients under this root. */
  count: number
  /** Raw total committed. */
  total: string
  recipients: readonly string[]
}

export interface DropOutcome {
  to: string
  /** Null when the roll landed on `nothing`. */
  award: DropAward | null
}

export interface CloseOptions {
  /** Close even though somebody has not claimed. Their entitlement dies with it. */
  force?: boolean
}

export interface PublishedDrop {
  table: DropTable
  issuer: string
  /** Revealed with the awards; it is what lets a player recompute the salt. */
  nonce: string
  roots: readonly DropRoot[]
  outcomes: readonly DropOutcome[]
  /** How many players rolled something. */
  readonly awarded: number
  /** What to hand one player. Null if they rolled nothing. */
  awardFor(address: string): DropAward | null
  /**
   * Mark every root in this batch as taking no further claims (SPEC §5.5).
   *
   * Roots are closed by the issuer rather than by a clock, because a
   * block-lattice has no clock — and closing is what lets a settled batch be
   * pruned instead of sitting in every node's memory forever. Refuses while
   * anybody still has an unclaimed entitlement, because closing over one is not
   * housekeeping, it is taking their loot back.
   */
  close(options?: CloseOptions): Promise<{ closed: string[]; unclaimed: string[] }>
}

/**
 * Roll one table for a set of players and publish the result.
 *
 * One roll per address, which is not a limitation to work around: a root commits
 * to at most one entitlement per account (SPEC §5.5), so two rolls for the same
 * player in one batch are one leaf whatever this function does, and merging them
 * silently would produce an award no `verifyDrop()` could match against a table
 * row. Two batches, or one row with the larger amount.
 */
export async function publishDrop(
  client: KeiClient,
  table: DropTable,
  players: readonly string[],
  options: DropOptions = {},
): Promise<PublishedDrop> {
  if (client.role !== 'issuer') {
    fail(
      'not-issuer-context',
      `economy.drop('${table.id}') publishes a commit block from the account that issues what drops, and only that account can sign it (SPEC §6.3). Call this on your Kei.server() instance — a browser that could do it would be holding your issuer seed.`,
    )
  }
  const issuer = assertAddress(options.issuer ?? table.issuer ?? client.address, 'drop table issuer address')
  if (issuer !== client.address) {
    fail(
      'wrong-issuer',
      `Drop table "${table.id}" is published by ${issuer} and this wallet is ${client.address}. A key signs only for its own account (SPEC §6.3), so this account cannot publish that batch.`,
    )
  }

  const addresses = rollCall(table, players)
  const rows = await resolveRows(client, table, issuer)

  const nonce = options.nonce ?? dropNonce()
  const salt = dropSalt(table.digest, nonce)

  /** asset id → the players who rolled it, and the raw amount each is owed. */
  const byAsset = new Map<AssetId, Array<{ to: string; amount: string }>>()
  const picks = new Map<string, Drop | null>()
  for (const address of addresses) {
    const drop = rollDropTable(table, options.random)
    picks.set(address, drop)
    if (drop === null) continue
    const row = rowFor(rows, drop, table)
    const list = byAsset.get(row.asset) ?? []
    list.push({ to: address, amount: row.raw.toString() })
    byAsset.set(row.asset, list)
  }

  assertHeadroom(table, rows, byAsset)

  const roots: DropRoot[] = []
  const awards = new Map<string, DropAward>()
  for (const [asset, entries] of byAsset) {
    const row = rows.find((candidate) => candidate.asset === asset) as ResolvedStack
    // Decimals 0 and raw amounts: the entries are already exact, and running
    // them back through a decimal conversion is a rounding step with nothing to
    // gain.
    const built = buildCommit({
      asset,
      decimals: 0,
      entries: entries.map((entry) => ({ to: entry.to, amount: entry.amount })),
      salt,
    })
    let hash: string
    try {
      ;({ hash } = await client.submitAsset({
        kind: 'commit',
        root: built.root,
        asset,
        count: built.count,
        total: built.total,
      }))
    } catch (error) {
      throw stoppedPartway(table, roots, error)
    }
    roots.push({
      root: built.root,
      hash,
      asset,
      symbol: row.symbol,
      count: built.count,
      total: built.total,
      recipients: built.recipients,
    })
    for (const address of built.recipients) {
      const bundle = built.proofFor(address)
      awards.set(address, {
        ...bundle,
        table: table.id,
        digest: table.digest,
        nonce,
        saltProof: built.saltProof,
        symbol: row.symbol,
        itemName: row.name,
        quantity: fromRaw(BigInt(bundle.amount), row.decimals),
      })
    }
  }

  const outcomes = addresses.map((to) => ({ to, award: awards.get(to) ?? null }))

  return {
    table,
    issuer,
    nonce,
    roots,
    outcomes,
    awarded: awards.size,
    awardFor(address) {
      const target = assertAddress(address, 'player address')
      if (!picks.has(target)) {
        fail(
          'not-in-drop',
          `${target} was not one of the ${addresses.length} ${addresses.length === 1 ? 'player' : 'players'} this batch of "${table.id}" rolled for, so there is no award to hand them. Roll them into the next batch.`,
        )
      }
      return awards.get(target) ?? null
    },
    close: (closeOptions) => closeRoots(client, table, roots, closeOptions ?? {}),
  }
}

/**
 * Check an award against the table it claims to come from, and against the
 * chain.
 *
 * Four things have to hold, and each one is a different kind of lie:
 *
 * 1. The root exists on this network and was published by somebody. A game can
 *    hand out proofs against a batch it never published; the ledger catches that
 *    at claim time, and catching it here means the player is told rather than
 *    left with a failing claim they cannot read.
 * 2. The root's salt is the one this table and nonce produce — so the batch was
 *    published for the odds the player was shown (`checkDropBinding`).
 * 3. The player's own leaf is under that root, for this asset and this amount.
 * 4. The pair is one the table actually declares. This is the check that needs a
 *    chain: a table row says `{ symbol: 'GEM' }, amount: 50` and the award says
 *    an asset id and a raw integer, and only `assetInfo` joins them.
 */
export async function verifyAward(
  client: KeiClient,
  award: DropAward,
  table: DropTable,
  options: { account?: string } = {},
): Promise<VerifiedDrop> {
  const account = assertAddress(options.account ?? client.address, 'account address')
  // Before the first read, so a malformed award is a sentence about the award
  // rather than a sentence about a chain it was never going to match.
  assertAwardShape(award)

  const commit = await client.node.commitInfo(award.root)
  if (!commit) {
    fail(
      'no-such-root',
      `No batch with root ${award.root} has been published on ${client.node.network}, so this award is not backed by anything the network has accepted (SPEC §5.5). Ask the game for a current drop; a claim against it would be refused.`,
    )
  }
  if (commit.asset !== award.asset) {
    fail(
      'wrong-asset',
      `Root ${award.root} pays out ${commit.asset} and this award names ${award.asset}. The game handed over a proof for the wrong batch — ask it for a current one.`,
    )
  }
  if (commit.closed) {
    fail(
      'root-closed',
      `Batch ${award.root} has been closed by ${commit.issuer} and accepts no further claims (SPEC §5.5). The award may well have been honest — closing is how a settled batch stops being permanent state on every node — but this one was not claimed in time and the ledger will refuse it now.`,
    )
  }

  checkDropBinding(award, table, account)

  const rows = await resolveRows(client, table, table.issuer ?? commit.issuer)
  const match = rows.find((row) => row.asset === award.asset && row.raw === BigInt(award.amount))
  if (!match) {
    const listed = rows
      .map((row) => `${formatRaw(row.raw, row.decimals)} ${row.symbol}`)
      .join(', ')
    fail(
      'undeclared-drop',
      `Drop table "${table.id}" does not list ${award.amount} raw units of ${award.asset} as something that can drop — it lists ${listed}. The batch is bound to this table and this award is inside it, so the table and the payout disagree: the game published one thing and committed another.`,
    )
  }

  const index = rows.indexOf(match)
  const drop = table.drops[index] as Drop
  const odds = table.odds.find((entry) => entry.drop === drop)
  return {
    table,
    root: award.root,
    asset: match.asset,
    symbol: match.symbol,
    quantity: fromRaw(match.raw, match.decimals),
    drop,
    chance: odds?.chance ?? 0,
  }
}

// ---------------------------------------------------------------- internals

/** The addresses, checked and unique. */
function rollCall(table: DropTable, players: readonly string[]): string[] {
  if (!Array.isArray(players) || players.length === 0) {
    fail(
      'no-players',
      `economy.drop('${table.id}', players) needs at least one address to roll for. Pass the accounts that were in the fight: economy.drop('${table.id}', [playerA, playerB]).`,
    )
  }
  const seen = new Set<string>()
  return players.map((player) => {
    const address = assertAddress(player, 'player address')
    if (seen.has(address)) {
      fail(
        'duplicate-player',
        `${address} appears twice in this batch of "${table.id}", and a root commits to at most one entitlement per account (SPEC §5.5) — the second roll would have to be merged into the first, producing an award no drop table row matches. Roll them once here and again in the next batch.`,
      )
    }
    seen.add(address)
    return address
  })
}

/** Every declared row, resolved against the chain, in declaration order. */
async function resolveRows(client: KeiClient, table: DropTable, issuer: string | null): Promise<ResolvedStack[]> {
  const rows: ResolvedStack[] = []
  for (const [index, drop] of table.drops.entries()) {
    const where = `drops[${index}] of drop table "${table.id}"`
    const resolved = await resolveStack(client, { asset: drop.asset, amount: drop.amount }, issuer, where)
    if (!isResolved(resolved)) fail(resolved.code, resolved.message)
    rows.push(resolved)
  }
  return rows
}

function rowFor(rows: readonly ResolvedStack[], drop: Drop, table: DropTable): ResolvedStack {
  const index = table.drops.indexOf(drop)
  const row = rows[index]
  if (!row) {
    fail('bad-drop-table', `A roll of "${table.id}" landed on a row that is not in the resolved table. This is an SDK bug — please report it.`)
  }
  return row
}

/**
 * Refuse a batch the ledger would only half-honour.
 *
 * A claim mints, and minting past `maxSupply` is an invalid block (SPEC §5.6.6),
 * so an over-committed batch does not fail here — it fails one player at a time,
 * whichever thousand of them happen to press claim last, and there is no way to
 * tell them apart afterwards. Better to refuse the whole batch while it is still
 * a number in a variable.
 */
function assertHeadroom(
  table: DropTable,
  rows: readonly ResolvedStack[],
  byAsset: ReadonlyMap<AssetId, ReadonlyArray<{ to: string; amount: string }>>,
): void {
  for (const [asset, entries] of byAsset) {
    const row = rows.find((candidate) => candidate.asset === asset)
    if (!row || row.maxSupplyRaw === null) continue
    let committed = 0n
    for (const entry of entries) committed += BigInt(entry.amount)
    const headroom = row.maxSupplyRaw - row.circulatingRaw
    if (committed <= headroom) continue
    fail(
      'no-headroom',
      `This batch of "${table.id}" commits ${formatRaw(committed, row.decimals)} ${row.symbol} and only ${formatRaw(headroom < 0n ? 0n : headroom, row.decimals)} more can exist: ${row.symbol} caps circulating supply at ${formatRaw(row.maxSupplyRaw, row.decimals)} and ${formatRaw(row.circulatingRaw, row.decimals)} are already held (SPEC §5.6.6). Roll fewer players, lower the amount on that row, or burn some ${row.symbol} to free headroom. Entitlements from earlier batches that nobody has claimed yet are not counted in circulating supply, so leave room for those too.`,
    )
  }
}

/**
 * What a multi-asset batch owes the caller when it stops between roots.
 *
 * One block does one thing and there is nothing to group two of them into
 * (SPEC §5.6.1), so a party that rolled gold and a sword is two commits and the
 * first stands whatever happens to the second. The players under a published
 * root are owed what it says; the ones under the root that never landed are owed
 * nothing and hold no proof. Naming the roots is the difference between
 * re-rolling the remainder and paying the first group twice.
 */
function stoppedPartway(table: DropTable, published: readonly DropRoot[], error: unknown): unknown {
  if (published.length === 0) return error
  const reason = error instanceof Error ? error.message : String(error)
  const done = published.map((root) => `${root.count} × ${root.symbol} (${root.root})`).join('; ')
  return new KeiError(
    error instanceof KeiError ? error.code : 'drop-stopped-partway',
    `This batch of "${table.id}" published ${published.length} of its roots before it stopped, and a settled block cannot be taken back. Standing, and claimable by the players under them: ${done}. Roll only the players who are not under those roots into the next batch. It stopped because: ${reason}`,
  )
}

async function closeRoots(
  client: KeiClient,
  table: DropTable,
  roots: readonly DropRoot[],
  options: CloseOptions,
): Promise<{ closed: string[]; unclaimed: string[] }> {
  const unclaimed: string[] = []
  for (const root of roots) {
    for (const recipient of root.recipients) {
      if (!(await client.node.hasClaimed(recipient, root.root))) unclaimed.push(recipient)
    }
  }
  if (unclaimed.length > 0 && options.force !== true) {
    const sample = unclaimed.slice(0, 3).join(', ')
    fail(
      'unclaimed-drop',
      `${unclaimed.length} of the players in this batch of "${table.id}" have not claimed yet (${sample}${unclaimed.length > 3 ? ', …' : ''}), and a closed root accepts no further claims (SPEC §5.5) — closing now takes their loot away rather than tidying up. Wait for them, or pass { force: true } if the batch is old enough that you mean it.`,
    )
  }
  const closed: string[] = []
  for (const root of roots) {
    await client.submitAsset({ kind: 'commit_close', root: root.root })
    closed.push(root.root)
  }
  return { closed, unclaimed }
}
