<p align="center">
  <img src="assets/kei-coin-256.png" width="168" alt="The Kei coin: an owl pushing a boulder uphill between two olive branches, reading UNUS KEI — one boulder — above a lyre marked with the Roman numeral one.">
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
> the native swap blocks it reads have since merged into the node — and
> `WalletPanel.mount()` gives games a drop-in balance/inventory/claims UI. Both
> ship in `0.3.0`, so installing the SDK gets them.
> The public testnet is one best-effort node with weak consensus, no uptime promise, and no
> monetary value: a dev-network chain whose keys are published, so anyone can
> fund or reset it and it may be rebuilt without notice. The 0.3.0 SDK and the
> native node's pinned M4 CI gate cover commit, claim, commit-close, and the work
> server; that does not by itself prove which build the public endpoint runs. See
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

A Kei payment has no memo field in the current wire contract. The SDK rejects `pay({ memo })` rather
than silently dropping it. `pay()` returns the player's send-block hash;
`onPayment.hash` is the game's receive-block hash, and that receive block's
`link` is the send hash. Persist orders and confirmed payments independently by
send hash, then run the same atomic, idempotent reconciliation after either
write. A payment can confirm before the browser attaches it to an order.

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
await kei.items.ownedBy(address)     // [ item, ... ]
await kei.items.transfer(sword.id, toAddress)   // player-signed
```

### Stats

Items carry stats if you want them — a sword with no attack number is a picture.

```js
const sword = await game.items.create({
  name: 'Iron Sword',
  stats: { attack: 10, weight: 3 },
})

// Mint with stats and the player gets a variant of the sword.
const drop = await game.items.mint(sword.id, playerAddress, {
  label: 'Flaming',
  stats: { attack: 17, element: 'fire' },
})

drop.id       // not sword.id — the variant is its own item
drop.stats    // { attack: 17, weight: 3, element: 'fire' } — the roll over the base
```

Stats are flat (numbers, strings, booleans), immutable, and on-chain: they ride
in the description field the chain already carries, so reading them is free and
does not cost an IPFS fetch. `item.description` stays prose.

**A variant is its own asset, and stats are part of its id.** That is what makes
it safe — an item cannot be re-statted behind a player's back, because different
stats are a different item rather than an edit. It is also the cost model to
design around: issuing the nth asset burns n Kei (SPEC §5.6.5), but the same
stats always derive the same id, so the hundredth Flaming Sword reuses the first
one's asset and burns nothing. **A bounded table of rolls is cheap. A fresh
random roll per drop issues an asset every time and gets expensive fast.**

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

## The market

An auction house is usually weeks of work: listings, bids, settlement, price
history, and a database in front of all of it. Here a listing is one block, and
settlement is atomic — there is no server and no database to run.

```js
// Seller: locks the item, asks 5 Kei
const offer = await kei.market.sell({ asset: sword, price: 5 })

// Buyer: one block moves both legs, or neither
await kei.market.accept(offer)

// Anyone: price history is transaction history, already there
await kei.market.medianPrice(sword, { window: '7d' })
```

Only the seller ever locks anything, and it is their own item — the same sword
cannot be listed twice, because after the first offer it is not in their wallet
to offer again. `market.cancel(offer)` gets it back any time before someone
accepts. An `expiresAt` is advisory only — this chain has no clock — and the
SDK cancels a wallet's own expired listings in the background, which is what
actually clears them off the ledger.

`market.offers({ from })` and `market.trades({ from })` read a bounded walk of
the chains you name — there is no network-wide listing index, on purpose
(the chain moves and records assets; it does not run a matching engine).

## The wallet

```js
await kei.wallet.summary()      // { address, kei, tokens, items, pending }
kei.wallet.on('change', s => {})
```

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

`AGENTS.md` and `llms.txt` ship at M9.

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
| **The chain** | A real Kei node enforcing the SPEC §5.6 / §7 ledger rules, including native M4 commit/claim/commit-close in its pinned CI gate. Native `swap_offer`/`swap_accept`/`swap_cancel` are merged too; the reference mock remains for hermetic tests |
| **The network** | One public, rate-limited, best-effort Hetzner testnet node. `Kei.start()` selects it by default; `Kei.mock()` is explicit |
| **The demo** | [Button](../button) — playable single-player, every number on the chain and none in a database |
| **The market** | `@keicoin/market@0.1.0` — offers, atomic settlement, price history, all read from the chain. Published; `0.1.0` rather than `0.3.0` because it is the newest package here and has the least mileage |
| **The wallet panel** | `WalletPanel.mount()` is real and tested end to end, with the SPEC §6.6 seed-reveal friction |
| **npm** | `kei-transaction@0.3.0` and every `@keicoin/*` package are published, carrying M5 and M6; `@keicoin/market` at `0.1.0` and `create-kei-game` at `0.1.2`. What is installable and what is merged are the same thing again |
| **The harness** | `npm create kei-game@0.1.1` generates and runs the hash-correlated, restart-safe purchase path |
| **The work server** | `@keicoin/work@0.2.0` exports the bounded handler/server integration and the `kei-work-server` CLI; operating a public instance is separate deployment work |

The mock is not a stub of the API: it enforces one chain per account, derived
asset ids, receivable arrivals, work tiers, the issuance burn, circulating-supply
caps, transfer policy, the (account, root) double-claim index, self-locking
swaps, and the accept-vs-cancel race (SPEC §9.2, conflict 4) — so the SDK is
written against the intended semantics before the native swap node lands. What
the mock cannot rehearse is stated in
[`docs/decisions-m5.md`](docs/decisions-m5.md) §2: the race is resolved by
arrival order in one process, standing in for the fork-resolution rule a real
node needs across many.

M1 proved that across a process boundary rather than asserting it: `mockRpcHandler`
serves [`docs/rpc.md`](docs/rpc.md) as a plain `Request → Response`, and the whole
economy — issue, top-up, mint, transfer, item, commit, parallel claims — runs
between two clients that share nothing but a URL. **M2 changes what is behind that
URL and nothing above it.** M3 made that swap: the same suites now pass against
the public node with `KEI_NODE_URL` as the only switch, and `npm run test:m3-live`
runs SPEC §6.2's no-argument `Kei.start()` against it, faucet to payment.

Read that precisely. Issue, top-up, mint, transfer and item run through the
public M3 endpoint. Native `commit`, `claim`, and `commit_close` are merged and
run through the exact pinned M4 SDK contract against a clean node in CI. That is
implementation evidence, not a claim that the public node has been redeployed
with M4; deployment remains separately observable work.

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

`@keicoin/core` depends on nothing else in the tree.

One package in the tree is not part of the SDK: **`create-kei-game`** is the
harness behind `npm create kei-game` (SPEC §11.3). It writes a working
single-player game — wallet, currency, purchasable item, Babylon.js scene, and a
mock node to develop against — and exits. It has no dependencies, and nothing it
generates depends on it. It lives here because it emits code against this API and
has to move when this API moves; it versions with the tree for the same reason.

That last part is enforced rather than intended: `bun test` writes the project
out, imports both halves of it, and buys the item against the SDK in this tree.
The generated shop is the `pay()` flow above end to end — pay, then hand the
game the hash of what you signed — and the emitted code breaks here rather than
in somebody's new project.

## Development

```sh
bun install
bun test
bun run build     # tsc --build, emits dist/ and .d.ts across the workspace
```

Documentation worth reading before changing anything:

- [`docs/decisions-m0.md`](docs/decisions-m0.md) — what M0 had to decide that the
  spec left open, and what M2 inherits
- [`docs/decisions-m1.md`](docs/decisions-m1.md) — what a real browser and a real
  process boundary changed, including the two bugs the test suite could not see
- [`docs/decisions-m5.md`](docs/decisions-m5.md) — the swap wire layout proposal,
  and what the mock's accept-vs-cancel race does and does not prove
- [`docs/rpc.md`](docs/rpc.md) — the node contract the fork has to serve

## Credit

Key derivation, signing, and address encoding come from
[`@bananocoin/bananojs`](https://github.com/BananoCoin/bananojs). Kei is a fork of
Banano, itself a fork of Nano, and hand-rolled crypto is how wallets lose money.

MIT.
