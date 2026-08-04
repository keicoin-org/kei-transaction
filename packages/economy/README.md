# @keicoin/economy

Rewards, sinks, shops, crafts and loot tables, declared once and dry-run before
anything is signed. No server ledger, no pending state, no key that signs for
somebody else.

> Part of [`kei-transaction`](https://www.npmjs.com/package/kei-transaction) — real currencies and items
> for browser games. **Install `kei-transaction` instead unless you are counting
> bytes**; these sub-packages exist for bundle size, not as a puzzle you have to
> solve.

```sh
bun add @keicoin/economy     # or npm / pnpm / yarn
```

## The shared file

A recipe is a declaration, not a transaction. `defineRecipe()` reads no chain
and signs nothing, so the same file is imported by the server that backs the
recipe and by the browser that runs it.

```js
// economy.js — imported by both halves
import { defineRecipe } from '@keicoin/economy'

export const dailyBonus = defineRecipe({
  id: 'daily-bonus',
  grants: [{ asset: { symbol: 'GOLD' }, amount: 250 }],
  issuer: GAME_ADDRESS,
})

export const repair = defineRecipe({
  id: 'repair',
  costs: [{ asset: { symbol: 'GOLD' }, amount: 40 }],   // burned
  issuer: GAME_ADDRESS,
})

export const forgeSword = defineRecipe({
  id: 'forge-sword',
  costs:  [{ asset: { symbol: 'SCRAP' }, amount: 30 }],
  grants: [{ asset: { symbol: 'SWORD' } }],
  issuer: GAME_ADDRESS,
})
```

That shared file is the point. When the player's SDK checks an on-chain offer
against the same recipe object the server published it from, "is this shop
selling me what it said it would" stops being a matter of trust.

## Three shapes, because the ledger has three

`costs` and `grants` decide which; nothing else does.

| | | signs | settles |
|---|---|---|---|
| **grant** | grants, costs nothing | issuer | one `mint` per grant |
| **sink** | costs, grants nothing | the holder | one `burn` (or `transfer`) per cost |
| **exchange** | one in, one out | both, separately | one `swap_accept` — **both legs or neither** |

An exchange is the only shape where nobody has to be trusted for the other
half. The issuer writes the offer that locks the reward; the player writes the
accept; one block moves both legs or neither (SPEC §9.2).

**One asset each way is not an omission.** A `swap_offer` locks one asset and
names one it wants, so "three iron and two wood for a sword" has no block that
could settle it — and every way of splitting it leaves somebody who paid and
did not receive. `defineRecipe` refuses that shape at import rather than
quietly picking which player to expose, and the refusal names the two ways
round it.

## The dry run

`plan()` reads the chain and writes nothing. It is what goes behind a disabled
button, so it answers as data rather than as a throw.

```js
const plan = await kei.economy.plan(forgeSword)

plan.ok        // false
plan.atomic    // true — one block settles it
plan.steps     // [{ signer: 'issuer', action: 'offer', ... },
               //  { signer: 'player', action: 'accept', ... }]
plan.problems  // [{ code: 'insufficient-balance', message: 'Not enough SCRAP — …' }]
plan.warnings  // things that will work and you should still know
console.log(plan.explain())
```

`explain()` prints the whole thing as copyable text — for a log, an agent, or a
bug report:

```
Recipe "forge-sword — Forge a Sword"
exchange, settled by one block — nobody can be left having paid without receiving
player kei_3jge9…
issuer kei_3t8my…

Costs (to the issuer):
  30 SCRAP  Scrap Metal

Grants:
  1 SWORD  Iron Sword

Steps:
  1. [issuer signs] offer: kei_3t8my… locks 1 SWORD in an offer asking 30 SCRAP
  2. [player signs] accept: kei_3jge9… pays 30 SCRAP and receives 1 SWORD — one block, both legs or neither

Problems — this plan will not run:
  - no-listing: kei_3t8my… has no open offer on its chain giving 1 SWORD for 30 SCRAP …
```

Every step carries the account that signs it. That is not decoration: a private
key signs only for its own account (SPEC §6.3), so a plan with an issuer step
in it is a plan the player **cannot** finish alone, and saying so up front is
the difference between an SDK and a server that holds balances.

## Running it

```js
// Server — the half that mints and the half that stocks
await game.economy.run('daily-bonus', { player: playerAddress })
await game.economy.stock('forge-sword', { count: 20, mint: true })

// Browser — the half the player signs
await kei.economy.run('repair')        // burns 40 GOLD, one block
await kei.economy.run('forge-sword')   // accepts a matching offer, atomically
```

`run()` writes only the blocks this account can sign. Ask it for the other
half and it refuses, names the account that has to write it, and names the
call — because "wrong signer" with no second half is how people end up building
a server that holds keys.

`stock()` puts copies on the shelf; each copy is one offer block, and each
serves one buyer. A shop is a set of blocks on the issuer's chain, and the
player's protection is not that the shop is honest — it is that the player's
own copy of the recipe says what the terms must be. Amounts are compared raw
unit for raw unit against the offer block itself. A shop that relists a sword
at ten times the price does not sell it to anybody running this code; it just
stops matching.

A copy reserved for one player (`stock(recipe, { to })`) is a matching offer
nobody else can take, so `plan()` and `run()` step past it to the next one
rather than reading the shelf as empty. When every copy left is somebody else's,
that is what the plan says — a reserved shelf is a shop working as stocked, not
a fault.

## When one block is not enough

An exchange settles in one block, and a grant or sink of a single asset is one
block because it has one leg to move. Anything else is two or more, and one
account keeps one chain with one block per operation (SPEC §5.6.1) — there is
nothing to group them into. `plan()` says so before you run it:

```js
plan.atomic                      // false
plan.warnings                    // [{ code: 'not-one-block', … }]
```

If such a run stops halfway, the blocks already written have settled and cannot
be taken back. The error says which ones, by hash, with the reason it stopped —
because reconciling that is the only thing left to do, and a bare "max supply
reached" does not tell you that half the reward already landed. `stock()` says
the same about copies already on the shelf, which are open offers holding stock
locked.

Keep multi-asset rewards and sinks to things a player can be given twice or
charged twice without harm. When it has to be all or nothing, it has to be one
in and one out.

## Drop tables

Loot is the other half, declared the same way and in the same shared file.

```js
// loot.js — imported by both halves
import { defineDropTable } from '@keicoin/economy'

export const dragonHoard = defineDropTable({
  id: 'dragon-hoard',
  drops: [
    { asset: { symbol: 'GOLD' }, amount: 50, weight: 60 },
    { asset: { symbol: 'SWORD' },            weight: 10 },
  ],
  nothing: 30,              // …and the rest of the time, nothing
  issuer: GAME_ADDRESS,
})

dragonHoard.odds   // [{ drop, chance: 0.6 }, { drop, chance: 0.1 }, { drop: null, chance: 0.3 }]
dragonHoard.digest // 64 hex characters over id, rows, amounts, weights and miss rate
```

Weights are relative, not percentages, and `nothing` is declared rather than
implied — a miss rate is part of what the digest promises, so a game cannot
publish "always a sword" and quietly roll empty half the time.

```js
// Server: one roll per player, one commit block per asset, however big the party
const drop = await game.economy.drop(dragonHoard, [playerA, playerB /* …thousands */])

drop.roots            // one per asset that actually dropped
drop.awarded          // how many players rolled something
drop.awardFor(playerA)  // a claim bundle with the binding attached, or null

// Browser: check it, then claim it
const { symbol, quantity, chance } = await kei.economy.verifyDrop(award)
await kei.claims.add(award)
```

Nothing here mints. A **claim** mints, on the player's own chain, which is the
only reason a boss killed by a thousand people at once is not a thousand writes
queued behind the issuer (SPEC §5.5).

### What `verifyDrop()` actually proves

The table's digest is hashed into the **salt** of the Merkle root the issuer
publishes, and the salt is a leaf of that same tree. So an award carries two
paths, and both fold up to a root the ledger has already accepted:

| Path | What it settles |
|---|---|
| `saltLeaf(H(digest ‖ nonce))` | the batch was published **for this table** |
| `leafHash(you, asset, amount)` | the batch **owes you this** |

Plus two reads: the root exists on this network, and the pair is one the table
declares. Each failure is its own sentence — `table-changed`, `unbound-drop`,
`not-in-drop`, `no-such-root`, `undeclared-drop` — thrown before anything is
claimed.

**It is not verifiable randomness, and should not be sold as it.** The roll
happens on the game's server, out of the chain's sight, and nothing here proves
the weights were honoured: a game that publishes a 1% sword and never rolls one
is not caught by this. What is caught is duller and far more common — a table
rewritten between the announcement and the drop, an award for something the
table never listed, an amount nobody was promised, and an award drawn for one
player and handed to another.

### Closing a batch

```js
await drop.close()                  // every root in the batch
await drop.close({ force: true })   // even over somebody's unclaimed loot
```

Roots are closed by the issuer rather than by a clock, because a block-lattice
has no clock (SPEC §5.5), and closing is what lets a settled batch be pruned
instead of sitting in every node forever. `close()` refuses while anybody still
has an unclaimed entitlement, because closing over one is not housekeeping.

### Two refusals worth knowing before you meet them

- **One roll per address per batch.** A root commits to at most one entitlement
  per account, so two rolls for the same player would have to merge into one leaf
  — producing an award no table row matches. Two batches instead.
- **A batch the supply cannot honour is refused whole.** A claim mints, and
  minting past `maxSupply` is an invalid block, so an over-committed batch would
  otherwise fail one player at a time with no way to tell which. `drop()` checks
  the headroom before it publishes anything.

## What is deliberately not here

- **No off-chain balances.** Nothing here stores a pending, reserved, or
  escrowed anything. Every number comes from the ledger on the way past.
- **No `charge(someoneElse, …)`.** It cannot exist (SPEC §6.3).
- **`requires` is not consensus.** A gate is checked when the plan is built and
  again by the issuer before it signs, which is real for a `grant`. It is *not*
  enforced on an `exchange`: an open offer is open, and anybody who can pay can
  take it. Reserve the offer for one player — `stock(recipe, { to })` — if the
  gate has to hold. The plan says so in `warnings`.
- **No cooldowns or per-player limits.** The honest primitive for "once per
  player" is a commit root: the ledger keys claims on (account, root) and
  refuses a second one (SPEC §5.5). `economy.drop()` and `token.commit()` both
  give you one.
- **No randomness the chain can check.** See above. A native beacon is not a
  primitive Kei has, and inventing one is a consensus change, not an SDK one.

## Status

**M6 of eleven**, and the newest package in this workspace. It composes
`@keicoin/core`, `@keicoin/claims` and `@keicoin/market` and adds no consensus
rules of its own — every block it writes is one the SDK could already write by
hand.

There is no mainnet yet and **nothing here holds value.**

See the [full documentation](https://github.com/keicoin-org/kei-transaction/blob/master/README.md).

MIT.
