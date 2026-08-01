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

> **Status: M2 complete.** The SDK's exact RPC contract runs end to end against
> both its development mock and the native [Kei node](https://github.com/keicoin-org/kei-node).
> [Button](../button) remains playable against the same API. M3's public testnet
> is not open yet, and nothing here holds value. See
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
const ok = await kei.pay({ to: gameAddress, amount: 0.05 })

// Game server
game.onPayment(async ({ from, amount }) => {
  if (amount >= 0.05) await gems.mint(from, 100)
})
```

A Kei payment has no memo field until M4. Pass `ok.hash` alongside the order
instead; the SDK rejects `pay({ memo })` rather than silently dropping it.

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

M2 of eleven, complete. What exists:

| | |
|---|---|
| **The §6.7 API** | Complete, running end to end, types published |
| **The chain** | A development mock in this package and the native [Kei node](https://github.com/keicoin-org/kei-node), held to the same exact M2 RPC/economy suite |
| **The network** | No public testnet yet. `Kei.start()` with no node gets a private in-process chain; pass a node URL to use an external node. M3 makes that network public |
| **The demo** | [Button](../button) — playable single-player, every number on the chain and none in a database |
| **The market** | M5 — `@keicoin/market` does not exist yet |
| **The wallet panel** | M6 — the headless summary is here, `WalletPanel.mount()` is not |
| **npm** | All seven have a `0.1.0`, but public `create-kei-game@0.1.0` predates the safe purchase/restart work in PR #6 and is stale; the coordinated `0.1.1` release is tracked in [#12](https://github.com/keicoin-org/kei-transaction/issues/12) |
| **The harness** | The source in this tree generates and runs the hash-correlated, restart-safe purchase path. Do not use the public `0.1.0` scaffold for durable payment settlement |

The mock is not a stub of the API: it enforces one chain per account, derived
asset ids, receivable arrivals, work tiers, the issuance burn, circulating-supply
caps, transfer policy, the (account, root) double-claim index, and the genesis
allocation. The mock keeps local development cheap; the native node supplies the
production transport, and M3 deploys it without moving the API.

M1 proved the process boundary with `mockRpcHandler`; M2 kept that boundary fixed
and made the native node serve the same [`docs/rpc.md`](docs/rpc.md) contract. The
exact M2 suite runs issue, top-up, mint, transfer, and item operations between two
clients that share nothing but a URL. **M3 deploys that node as a public testnet;
it does not move the SDK API.**

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
| `@keicoin/market` | M5 |

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
bun test          # 211 tests
bun run build     # tsc --build, emits dist/ and .d.ts across the workspace
```

Documentation worth reading before changing anything:

- [`docs/decisions-m0.md`](docs/decisions-m0.md) — what M0 had to decide that the
  spec left open, and what M2 inherits
- [`docs/decisions-m1.md`](docs/decisions-m1.md) — what a real browser and a real
  process boundary changed, including the two bugs the test suite could not see
- [`docs/rpc.md`](docs/rpc.md) — the node contract the fork has to serve

## Credit

Key derivation, signing, and address encoding come from
[`@bananocoin/bananojs`](https://github.com/BananoCoin/bananojs). Kei is a fork of
Banano, itself a fork of Nano, and hand-rolled crypto is how wallets lose money.

MIT.
