# @keicoin/economy

Rewards, sinks, shops and crafts, declared once as recipes and dry-run before
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
  refuses a second one (SPEC §5.5). Use `token.commit()` for that today.

## Status

**M6 of eleven**, and the newest package in this workspace. It composes
`@keicoin/core` and `@keicoin/market` and adds no consensus rules of its own —
every block it writes is one the SDK could already write by hand.

There is no mainnet yet and **nothing here holds value.**

See the [full documentation](https://github.com/keicoin-org/kei-transaction/blob/master/README.md).

MIT.
