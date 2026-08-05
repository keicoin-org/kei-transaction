<p align="center">
  <img src="https://keicoin.org/img/kei-coin-256.png" width="168" alt="The Kei coin: an owl pushing a boulder uphill between two olive branches, reading UNUS KEI — one boulder — above a lyre marked with the Roman numeral one.">
</p>

# kei-transaction

Real currencies and items for browser games. One install, no payment
infrastructure, no database, no signup.

```js
import { Kei } from 'kei-transaction'

const kei = await Kei.start()          // wallet created, persisted, funded
await kei.send('kei_3abc...', 0.001)   // sub-cent, instant, feeless
```

> **Status: M6 in progress.** `Kei.start()` uses the real node at
> `https://testnet.keicoin.org/rpc`; `Kei.mock()` remains available for tests.
> `@keicoin/market` provides swap offers, atomic settlement, and price history —
> the native `swap_offer`/`swap_accept`/`swap_cancel` blocks it reads are merged
> in the node — and `WalletPanel.mount()` gives games a drop-in
> balance/inventory/claims UI.
> The public testnet is one best-effort node with weak consensus, published dev
> keys, no uptime promise, and no monetary value. See
> [Where this is](#where-this-is).

---

## What it is for

Every game with an economy eventually needs an auction house: listings, bids,
settlement, price history, anti-fraud, and a database with a server in front of
it. It is weeks of work, it is the part most likely to be exploited, and it is
the part a hobbyist cannot build safely.

On Kei most of that stops being work, because ownership, transfer, and
settlement are consensus rather than code you maintain. Micropayments are the
demo; the market is the product.

The reason it can exist: a card processor cannot take a $0.001 payment, because
the fee exceeds the payment. A feeless chain can.

## Install

```sh
bun add kei-transaction     # or npm / pnpm / yarn
```

ESM, TypeScript types included, runs in the browser and in Node or Bun.

## Two entry points, because a key signs only for its own account

```js
Kei.start()    // PLAYER — browser. Holds the player's seed.
Kei.server()   // ISSUER — Node/Bun only. Holds the game's seed.
```

`Kei.server()` refuses to run if it detects a browser and tells you why. An
issuer seed in the client is a total compromise of your economy: anyone can mint
your currency without limit.

A purchase is therefore always **two signed transactions**. There is no
`charge(someoneElse, …)`, and there never will be — it cannot exist.

```js
// Player
const order = await orders.create({ sku: 'starter-pack' })
const receipt = await kei.pay({ to: gameAddress, amount: 0.05 })
await orders.attachPayment(order.id, receipt.hash)

// Game server: onPayment.hash is the receive hash, not receipt.hash.
game.onPayment(async ({ from, amount, hash: receiveHash }) => {
  const receive = await game.client.node.blockInfo(receiveHash)
  if (!receive || receive.type !== 'state' || !['open', 'receive'].includes(receive.subtype)) return
  await payments.record({ sendHash: receive.link, receiveHash, from, amount })
  await reconcile(receive.link)
})
```

> A memo isn't available on `pay()` yet — a Kei payment has no wire field for
> one until M4, and `pay({ memo })` is rejected. `pay()` returns the player's
> send-block hash; `onPayment.hash` is the game's receive-block hash, whose
> `link` is that send hash. Persist orders and payments independently by send
> hash, then invoke one atomic, idempotent reconciliation after either write so
> payment-before-order is not lost and one payment cannot deliver twice.

## A currency in one call

```js
const gems = await game.token.issue({
  name: 'Gems',
  symbol: 'GEM',
  decimals: 0,
  maxSupply: 1_000_000,

  transfer: 'open',   // 'open' | 'issuer-only' | 'none' — enforced by the chain, immutable
  swap: 'one-way',    // 'two-way' | 'one-way' | 'off'   — a promise to players, on-chain
  rate: 100,          // your desk's price. Never on-chain, so you can change it.
})

await gems.mint(playerAddress, 500)
await gems.balanceOf(playerAddress)   // 500 — one call
```

Issuing is idempotent per (issuer, symbol): asset ids are derived, so calling
`issue()` again returns the token you already have.

**`transfer` is the only real mechanism for a closed economy.** `open` means a
permissionless market can and eventually will appear, whatever you would prefer.
`issuer-only` means players genuinely cannot trade with each other — and that
they genuinely cannot, which is the trade. `none` is soulbound: units can only be
burned.

**Your first token burns 1 Kei.** The nth asset an account issues burns n Kei —
the tenth costs 10, the five hundredth costs 500 — and it is the one operation
that is not free, because an asset record is permanent state on every node
forever. It escalates per account because what has to be expensive is one
account creating a great many records, not one account creating its first.
Transactions — sending, transferring, minting, claiming — are free, always.

## Items are tokens

An item is a token with supply 1 and 0 decimals. Not a special type, not a
second code path, and no indexer.

```js
const sword = await game.items.create({
  name: 'Sword of Testing',
  description: 'It tests things.',
  image: './sword.png',
})

await game.items.mint(sword.id, playerAddress)
await kei.items.owner(sword.id)      // 'kei_3abc...'
await kei.items.ownedBy(address)     // [ item, ... ], eight lookups at a time
await kei.items.ownedBy(address, { limit: 20 })  // first 20 holdings, not first 20 items
await kei.items.transfer(sword.id, toAddress)   // player-signed
```

## A thousand loot drops, one block

Minting per drop makes your issuer account a global write lock. So the issuer
publishes **one root** committing to the whole batch, and each player writes
their own claim from their own chain — in parallel, with no contention between
them.

```js
// Game server: one block, however large the batch
const drop = await gems.commit([
  { to: playerA, amount: 500 },
  { to: playerB, amount: 120 },
  // ...thousands more
])
send(playerA, drop.proofFor(playerA))   // plain JSON

// Player: hand it to the SDK, and it lands
await kei.claims.add(bundle)
```

Claiming happens in the background. A forged proof, a forged amount, or a second
claim from the same account is rejected by the ledger, not by the SDK.

When a batch is old, close it: `await gems.close(drop.root)`. Closed roots take
no further claims and become prunable. Nothing expires on a timer — this chain
has no clock, deliberately.

## Loot tables: the odds, published before the fight

`commit()` is the mechanism. A **drop table** is what a game designer actually
writes — declared in a file both halves of the game import, like a recipe.

```js
// loot.js — the server and the browser import this same file
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
```

```js
// Game server: one roll per player, one block per asset, however big the party
const drop = await game.economy.drop(dragonHoard, party)
send(playerA, drop.awardFor(playerA))    // plain JSON; null if they rolled nothing

// Player: check it, then claim it
const { symbol, quantity, chance } = await kei.economy.verifyDrop(award)
await kei.claims.add(award)
```

The table hashes to a digest, and the digest is bound into the salt of the root
the issuer publishes. `verifyDrop()` folds two paths up to that root — the one
the ledger already accepted — and gets two facts out of one block: **the batch
was published for the table you were shown**, and **it owes you this**.

**Be exact about what that is not: it is not verifiable randomness.** The roll
happens on the game's server, and nothing here proves the weights were honoured.
A game that publishes a 1% sword and never rolls one is not caught by this. What
is caught is duller and far more common — a table quietly rewritten between the
announcement and the drop, an award for something the table never listed, an
amount nobody was promised, and an award drawn for one player and handed to
another. Each of those is a sentence out of `verifyDrop()` before anything is
claimed.

`drop.close()` closes every root in the batch, and refuses while anybody still
has an unclaimed entitlement in it — closing over one is not housekeeping, it is
taking their loot back. Pass `{ force: true }` when you mean it.

## Recipes: the systems around the money

Rewards, sinks, shops and crafts are the same four shapes in every game, and
hand-wiring them is where an economy quietly grows a server that holds
balances. A recipe is a declaration instead — frozen, chain-free, and imported
by both halves of the game.

```js
// economy.js — the server and the browser import this same file
export const forgeSword = defineRecipe({
  id: 'forge-sword',
  costs:  [{ asset: { symbol: 'SCRAP' }, amount: 30 }],
  grants: [{ asset: { symbol: 'SWORD' } }],
  issuer: GAME_ADDRESS,
})
```

`costs` and `grants` decide what it becomes, and nothing else does:

| | | signs | settles |
|---|---|---|---|
| **grant** — a reward, a bonus, a quest payout | grants, costs nothing | issuer | one `mint` each |
| **sink** — a repair fee, a re-roll, a ticket | costs, grants nothing | the holder | one `burn` each |
| **exchange** — a shop, a craft, an upgrade | one in, one out | both, separately | **one block, both legs or neither** |

```js
// Game server
await game.economy.stock('forge-sword', { count: 20, mint: true })
await game.economy.run('daily-bonus', { player: playerAddress })

// Player
await kei.economy.run('repair')        // burns 40 gold, one signed block
await kei.economy.run('forge-sword')   // accepts a matching offer, atomically
```

Nothing runs before you can see what it would do. `plan()` reads the chain,
writes nothing, and answers as data — which is what a disabled button needs:

```js
const plan = await kei.economy.plan(forgeSword)
plan.ok        // false
plan.atomic    // true — one block settles it
plan.steps     // [{ signer: 'issuer', action: 'offer' }, { signer: 'player', action: 'accept' }]
plan.problems  // [{ code: 'insufficient-balance', message: 'Not enough SCRAP — …' }]
console.log(plan.explain())   // the whole thing, copyable
```

Every step names the account that signs it, because a key signs only for its
own account. A plan with an issuer step in it is one the player **cannot**
finish alone, and `run()` refuses the other half by name rather than silently
skipping it.

A shop is blocks on the issuer's chain, and the recipe is the player's receipt
in advance: before accepting, the SDK compares the on-chain offer to the
player's own copy of the recipe, raw unit for raw unit. A shop that relists a
sword at ten times the price does not sell it to anybody running this code.

A swap moves one asset per side, so a recipe takes one asset and gives one.
"Three iron and two wood for a sword" has no block that could settle it, and
every way of splitting it leaves somebody who paid and did not receive —
`defineRecipe` refuses that shape at import and names the two ways round it.

There is a runnable version of all of this in
[`examples/economy`](https://github.com/keicoin-org/kei-transaction/tree/master/examples/economy).

## The wallet

```js
await kei.wallet.summary()      // { address, kei, tokens, items, pending }
kei.wallet.on('change', s => {})
```

Each summary re-reads mutable balances, holdings, and claims. Immutable asset
metadata is cached in a bounded LRU and fetched through one wallet-wide
concurrency gate (eight at once by default, configurable from 1 through 32), so
an item-heavy inventory takes waves of requests rather than one serial round
trip per item. Change listeners share one coalesced refresh stream, and token and
item rows are stable by asset id regardless of node response order.

The seed lives in browser storage and is never transmitted anywhere. Whether a
player can see it is your decision, declared at setup:

```js
const kei = await Kei.start({ reveal: 'on-request' })   // 'on-request' | 'never' | 'always'
```

`on-request` is the default and almost always right. `never` means the player
cannot back up, cannot move to another wallet, and cannot recover if browser
storage is cleared — defensible for a game aimed at children, but it makes
"players own their items" substantially less true. Choose it knowingly.

Hiding the seed in the UI is not a security control. It defends against
screenshots, streams, and shoulder-surfing. It does not defend against an
attacker: the seed is in browser storage, and any XSS on your page reads it
whatever the UI does.

### Whether the wallet survives a reload

Browser storage is not always there. Private browsing, a switched-off store, a
full quota, and browser policy all make `localStorage.setItem()` throw, and some
of them make `getItem()` throw too. A generated seed that nothing kept is a
wallet that a reload replaces — leaving the old address accessible only with a
separately backed-up seed —
so `Kei.start()` says which one you have rather than looking identical either
way:

```js
const kei = await Kei.start()

kei.custody.durability   // 'persistent' | 'session' | 'supplied'
kei.custody.origin       // 'generated' | 'restored' | 'supplied' | 'environment'
kei.custody.reason       // why it is session-only: 'storage-write-refused', …
kei.custody.message      // one sentence, safe to render or log — never the seed
```

`persistent` means the seed was written **and read back**, so a reload finds the
same wallet. `session` means memory only, and a reload is a different wallet.
`supplied` means you passed the seed (or `KEI_PLAYER_SEED`), so keeping it is
yours to do and nothing was written anywhere.

Two things follow from a `session` wallet, and both are handled rather than
warned about:

- **The address holds still for the rest of the session.** A seed browser
  storage refused is kept in memory, so a second `Kei.start()` on the same page
  is the same wallet rather than a second one that abandons the first's balance.
- **`WalletPanel` says so, first and undismissably**, and puts the seed-backup
  control inside the warning. A game drawing its own UI should read
  `kei.custody` and do the same before it lets a wallet hold anything;
  `panel.element.dataset.durability` carries the same fact for styling or for
  disabling a buy button.

If the wallet is meant to hold something and a session-only one is not
acceptable, refuse at the door instead:

```js
const kei = await Kei.start({ requireDurableSeed: true })
// KeiError seed-not-durable: "…browser storage refused to keep it — private
// browsing, storage switched off, or a full quota. …"
```

A custom `storage` store keeps working unchanged. If it cannot survive a reload,
say so — return `{ durability: 'session' }` from `write()`, or implement
`status()` — and it will be reported as session rather than assumed durable. A
claimed persistent write is always verified by reading the seed back. The store
itself remains trusted code: only its implementation can know whether its
backing service truly survives a process restart.

## For agents

No signup, no API key, no dashboard, no OAuth, no interactive prompt anywhere.
The wallet *is* the account: a seed is a credential and a funded address is a
provisioned account. On testnet, `faucet()` self-funds. On mainnet the only human
step in the whole lifecycle is sending Kei to a printed address.

Every error is a sentence that states its own fix, because the agent reading it
cannot ask a follow-up question:

```
Not enough Kei — balance is 0.4, tried to send 1.2.
```

The ongoing M9 harness work lives in the standalone
[`create-kei-game`](https://github.com/keicoin-org/create-kei-game) repository;
follow [PR #1](https://github.com/keicoin-org/create-kei-game/pull/1) for its
current implementation.

## Shipping

Testnet is where you build, and the wrong place to finish. Its Kei is worth
nothing and that chain can be reset without notice, so a game that reaches real
players on testnet has an economy with an expiry date nobody chose (SPEC §5.9).

So `Kei.server()` refuses to start against testnet from a host that looks like a
deployment — `NODE_ENV=production`, or a platform variable nobody sets on
purpose like `FLY_APP_NAME`, `RAILWAY_ENVIRONMENT`, or `K_SERVICE` — and the
refusal names the move:

```
This looks like a deployment (NODE_ENV=production) and your game is pointed at
testnet. […] move to mainnet before real players arrive: network: 'mainnet'.
```

Mainnet is not open yet, so today that refusal means *not yet*: keep the game in
front of testers who know the money is play money. It opens when enough
independent validators run the chain that value is safe on it (SPEC §15).

Two things it deliberately does not block. A mock, deployed or not, because a
mock was never pretending to be money. And a public testnet demo you meant to
run: `KEI_ALLOW_TESTNET=1`, set in the deploy's environment rather than in a
commit, because that is where the decision is actually made.

## Where this is

M6 of eleven. What exists:

| | |
|---|---|
| **The §6.7 API** | Complete, running end to end, types published |
| **The chain** | A real Kei node enforcing the SPEC §5.6 / §7 ledger rules; native claims and native swaps are both merged |
| **The network** | One public, rate-limited, best-effort Hetzner testnet node. `Kei.start()` selects it by default; `Kei.mock()` is explicit |
| **The demo** | [Button](https://github.com/keicoin-org/button) — playable single-player, every number on the chain and none in a database |
| **The market** | `@keicoin/market` — offers, atomic settlement, price history, all read from the chain |
| **The wallet panel** | `WalletPanel.mount()` is real and tested end to end, with the SPEC §6.6 seed-reveal friction |

The mock is not a stub of the API: it enforces one chain per account, derived
asset ids, receivable arrivals, work tiers, the issuance burn, circulating-supply
caps, transfer policy, the (account, root) double-claim index, and the genesis
allocation. The mock keeps local development cheap; the native node supplies the
production transport, and M3 deploys it without moving the API.

M1 proved that across a process boundary rather than asserting it: `mockRpcHandler`
serves [`docs/rpc.md`](https://github.com/keicoin-org/kei-transaction/blob/master/docs/rpc.md) as a plain `Request → Response`, and the whole
economy — issue, top-up, mint, transfer, item, commit, parallel claims — runs
between two clients that share nothing but a URL. **M2 changes what is behind that
URL and nothing above it.** M3 made that swap: the same suites now pass against
the public node with `KEI_NODE_URL` as the only switch, and `npm run test:m3-live`
runs SPEC §6.2's no-argument `Kei.start()` against it, faucet to payment.

Read that precisely. Issue, top-up, mint, transfer and item all run against the
node today; **`commit` and `claim` do not** — they are M4, they stay covered
against the mock, and they are deliberately not in the suite that gates the
public endpoint.

Nothing here holds value, and until the validator set is meaningfully
distributed, nothing should.

## Packages

`kei-transaction` is the umbrella and the default install. The sub-packages exist
for people who care about bundle size, not as a puzzle everyone must solve.

| Package | What it holds |
|---|---|
| `@keicoin/core` | wallet, send, receive, blocks, node clients, the mock ledger |
| `@keicoin/tokens` | issue, mint, burn, transfer, policy flags, items |
| `@keicoin/claims` | Merkle roots, proofs, claim blocks |
| `@keicoin/work` | proof-of-work tiers, local generation, work-server client |
| `@keicoin/wallet` | in-game wallet: balances, inventory, pending claims |
| `@keicoin/market` | offers, atomic swap settlement, price history — depends on `@keicoin/core` alone |
| `@keicoin/economy` | recipes — rewards, sinks, shops and crafts, with a dry run before anything signs — and drop tables, published as commitments |

`@keicoin/core` depends on nothing else in the tree.

## Development

```sh
bun install
bun test
bun run build     # tsc --build, emits dist/ and .d.ts across the workspace
```

Documentation worth reading before changing anything:

- [`docs/decisions-m0.md`](https://github.com/keicoin-org/kei-transaction/blob/master/docs/decisions-m0.md) — what M0 had to decide that the
  spec left open, and what M2 inherits
- [`docs/decisions-m1.md`](https://github.com/keicoin-org/kei-transaction/blob/master/docs/decisions-m1.md) — what a real browser and a real
  process boundary changed, including the two bugs the test suite could not see
- [`docs/decisions-drop-tables.md`](https://github.com/keicoin-org/kei-transaction/blob/master/docs/decisions-drop-tables.md) — how a loot
  table binds to a published root, and the boundary of what that proves
- [`docs/rpc.md`](https://github.com/keicoin-org/kei-transaction/blob/master/docs/rpc.md) — the node contract the fork has to serve

## Credit

Key derivation, signing, and address encoding come from
[`@bananocoin/bananojs`](https://github.com/BananoCoin/bananojs). Kei is a fork of
Banano, itself a fork of Nano, and hand-rolled crypto is how wallets lose money.

MIT.
