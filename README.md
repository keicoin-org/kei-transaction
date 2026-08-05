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

> **Status: public testnet, no mainnet.** `Kei.start()` uses the real node at
> `https://testnet.keicoin.org/rpc`; `Kei.mock()` remains available for tests.
> `@keicoin/market` provides swap offers, atomic settlement, and price history —
> the native swap blocks it reads have since merged into the node — and
> `WalletPanel.mount()` gives games a drop-in balance/inventory/claims UI.
> Player shops (`kei.shop`), the bounded market surface (`book()`, `series()`,
> `candles()`, `accept(offer, { expect })`), wallet durability reporting, and
> drop tables ship in the published `0.8.0` umbrella, so
> `bun add kei-transaction` resolves the coordinated release —
> [Releases](#releases) has the exact versions and
> [Where this is](#where-this-is) the consequences.
> The public endpoint answers `version` with `store_version 24`, which is the
> build that accepts both claim and swap blocks, so this is measured rather than
> inferred from CI. It is still one best-effort node with weak consensus, no
> uptime promise, and no
> monetary value: a dev-network chain whose keys are published, so anyone can
> fund or reset it and it may be rebuilt without notice. See
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

// Game server
game.onPayment(async ({ from, amount, sendHash, hash: receiveHash }) => {
  await payments.record({ sendHash, receiveHash, from, amount })
  await reconcile(sendHash)
})
```

A Kei payment has no memo field in the current wire contract. The SDK rejects `pay({ memo })` rather
than silently dropping it. `pay()` returns the player's send-block hash, and the
game reads that same value as `onPayment.sendHash` — the one id both parties
hold. (`onPayment.hash` is the game's own receive block, which the payer never
sees.) Persist orders and confirmed payments independently by send hash, then
run the same atomic, idempotent reconciliation after either write. A payment can
confirm before the browser attaches it to an order.

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
`issue()` again returns the token you already have, writing no block and burning
no Kei.

Idempotent, not indifferent. Issuance parameters are immutable, so `issue()`
compares every argument you passed against the token on chain and refuses if any
of them disagree, naming the field, what the chain says, and what you asked for.
Tightening `transfer: 'open'` to `'issuer-only'` in your source and redeploying
is an error, not a success that changes nothing. Arguments you leave out are not
compared — omitting `transfer` is not asking for `'open'` — and `rate` is your
desk's own price, never on chain, so it is free to change.

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
  image: './sword.png',   // a path that exists, image bytes, a CID, or a URL
})

await game.items.mint(sword.id, playerAddress)
await kei.items.owner(sword.id)      // 'kei_3abc...'
await kei.items.ownedBy(address)     // [ item, ... ], eight lookups at a time
await kei.items.ownedBy(address, { limit: 20 })  // first 20 holdings, not first 20 items
await kei.items.transfer(sword.id, toAddress)   // player-signed
```

**The symbol is derived from the name.** 7 characters of stub plus 48 bits of
digest, which is the node's 20-character `max_symbol` spent as widely as it goes.
`items.create()` is therefore idempotent per (issuer, name), and it refuses an
asset whose name is not the one you asked to create — so a digest collision, or a
`symbol` you passed that another item already holds, is an error rather than two
items sharing one supply. Pass `symbol` to override the derivation.

> **Changed after 0.9.0.** The digest used to be 16 bits, which collides across a
> catalogue of a few hundred items. Items already issued keep the symbol and id
> they were issued with; the new derivation would give the same name a new asset.
> If you have shipped a catalogue, pin its symbols with
> `items.create({ symbol })` — read them off your existing items, or off
> `itemSymbolFor` from a 0.9.x install — before upgrading.

### Stats

Items carry stats if you want them — a sword with no attack number is a picture.

```js
const sword = await game.items.create({
  name: 'Iron Sword',
  stats: { attack: 10, weight: 3 },
  supply: 1000,               // how many swords can exist, rolls included
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

Reusing that asset only helps if it has room, so **a roll is as plentiful as the
item it varies.** `create` defaults to a supply of 1 — genuinely unique, and one
Flaming Iron Sword is then all there will ever be — so give the base item a
supply if many players are meant to hold rolls of it, as above. Supply is fixed
at a roll's first issuance: issuance metadata is immutable, so raising it
afterwards is refused rather than ignored.

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

Claim proofs are off-chain data: a root cannot reconstruct one after a reload.
The default remains session memory, while wallets that need “next login”
recovery can opt into browser storage (or inject the same interface on Node):

```js
const kei = await Kei.start({
  claimStore: createBrowserClaimStore(localStorage),
})

await kei.claims.add(bundle)             // atomically admitted and read back before signing
await kei.claims.storageStatus()         // durability plus typed diagnostics
```

Records are isolated by network, wallet address, and root, removed only after
confirmed claim/reconciliation, and bounded to 128 records, 16,384 bytes each,
128 proof hashes, and 39 decimal amount digits. Browser admission is a wallet
signature over the network, address, root, and exact stored bytes, so storage
cannot authorise a rewritten record by recomputing public digests. Non-canonical
Ed25519 signatures, including equivalent `S + L` encodings, are rejected before
verification, and the signed wallet scope prevents cross-account replay.
Rejected candidates remain non-signable across restarts. They contain award metadata but no
seed or private key; browser storage is recovery, not a backup. See
[`docs/decisions-claims-durability.md`](docs/decisions-claims-durability.md).

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

## The market

An auction house is usually weeks of work: listings, bids, settlement, price
history, and a database in front of all of it. Here a listing is one block and
settlement is atomic without application custody. A useful market screen still
needs an explicit discovery/history source; the built-in bounded account-chain
adapter is a local baseline, while durable or global history belongs in a
replaceable materialized provider.

```js
// Seller: locks the item, asks 5 Kei
const offer = await kei.market.sell({ asset: sword, price: 5 })

// Buyer: one block moves both legs, or neither
await kei.market.accept(offer)

// One explicitly scoped view of settled ledger facts
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

Above those primitives sit the pieces a market screen actually needs: a bounded
**directory** of which chains to read, a **book** that reads them in one walk per
chain and reports what it could not see, **price series and candles** ready to
draw, and a **verify-before-signing** check so an index can never become an
authority.

The instrument surface binds those pieces into one product-shaped call:

```js
const source = createAccountChainSource({ id: 'main-market', accounts: directory })
const swords = kei.market.instrument({ base: sword, quote: KEI_ASSET, source })

const snapshot = await swords.snapshot({
  depth: 20,
  history: { interval: '1h', range: { window: '30d' } },
})

renderTicker(snapshot.ticker)
renderBook(snapshot.book)
chart.setData(toUnixCandles(snapshot.history))

const stop = swords.subscribe({ every: '2s', readTimeout: '30s', signal }, update => render(update))
await swords.sell({ units: 10, unitPrice: 2 })
await swords.accept(snapshot.book.bestAsk)
```

Snapshots are normal serializable objects with exact raw terms, pair identity,
ticker/book/history, status, completeness, source/time provenance, and an honest
unsupported-pagination answer for the legacy account-chain adapter. The book
and history pages share one roster but are not atomic; `coverage.combined`
reports the exact accounts that answered both, while `asOf` marks completion.
History windows prefer `settledAt`, fall back to usable `seenAt`, and keep a
fully untimed accepted row explicit through `available`/`partial` state and
`time.untimed` without fabricating a line point or candle. Both inclusive window
bounds use the request-time `asOf` anchor, even when the underlying read is slow.
Polls do not overlap, have a finite per-refresh deadline, retain last-good data
through transient failures, measure age from successful completion, and wake
after instrument writes. Acceptance freshly re-reads chain and asset metadata
and compares every displayed term, including raw quantities and decimals,
before signing.

### An item chart that survives a restart

`instrument()` reads live chains on every call. An application that wants an
exchange-like price chart for one item ingests once into a store and draws from
it afterwards — with no hand-rolled directory, cursor bookkeeping, or price
conversion:

```js
const storage = createMemoryMarketStorage()   // or your own atomic compare-and-swap adapter
const catalog = createMarketCatalog({ storage })
const store = createMarketStore({ storage })  // bounded — see retention below

await catalog.announce({
  network: kei.node.network, address: sellerAddress, source: 'my-app',
  observedAt: Date.now(), observationId: crypto.randomUUID(),
  instrument: { base: sword, quote: KEI_ASSET },
})

const ingestor = createAccountChainIngestor({ id: 'main', provider: kei.node, catalog, store })
const run = await ingestor.ingest({ budget: { maxAccounts: 64, deadlineMs: 10_000 } })
run.cursor          // round-trip it to continue the roster — in this process or the next one
run.sourceBackfill  // { complete: false, reason: 'unsupported_pagination' } — always, for now

const chart = await kei.market.stored({ store, base: sword }).history({ interval: '1h', window: '30d' })
chart.instrument.id                // 'SWORD/KEI', from the chain's own asset names
chart.points[0].baseQuantity.raw   // exact ledger units that changed hands
chart.points[0].quoteTotal.raw     // what the whole lot cost — a total, never a price
chart.points[0].unitPrice          // { numerator, denominator, priceUnit, display }
chart.summary.median               // exact rational; an even count averages the two middles
chart.pagination.cursor            // opaque, resumable, and it outlives this process
```

**`raw`, `numerator` and `denominator` are the values that round-trip.** Every
`display` field is a `double` for rendering and nothing else: two settlements one
raw unit apart share one `display` and differ in the exact fields, which is the
whole reason this path exists.

Both tables have a bound and a compaction path. Discovery rows fold to one row
per participant, pair and source — keeping first and last observation times and
the count — before anything is evicted; settled offers compact before open ones;
and every page plus `store.coverage()` reports what folding and eviction did.
Pass `retention` to move the bounds, up to `MAX_MARKET_RETENTION`. A store that
reports `durability: 'durable'` has had that commit read back through the
adapter's own load path, and `sourceBackfill` stays incomplete until a node RPC
can prove exhaustion — so this is materialized history, never global history.

> **Everything below this line ships in `@keicoin/market@0.4.0`**, published 4
> August 2026. The original directory, `book()`, `series()`, `candles()` and
> `accept(offer, { expect })` surface arrived in `0.2.0`; `0.3.0` made aggregate
> reads bounded and abortable and preserved explicit coverage provenance;
> `0.4.0` adds defensive read bounds and ranks book levels by exact
> cross-multiplied price ratios. `kei-transaction@0.8.0` depends on
> `@keicoin/market@^0.4.0`, so a plain install resolves that current surface
> without a nested older market copy.

```js
const directory = createDirectory()         // or your own { accounts() }
directory.watch(sellerAddress)

const book = await kei.market.book({ from: directory, asset: sword })
book.asks[0].unitPrice  // quote per sword; cheapest ask first
book.bids[0].unitPrice  // the same units; highest bid first
book.coverage       // { asked, read, failed, truncated, dropped, complete }

const series = await kei.market.series({ asset: sword, from: directory })
series.ordering     // { by: 'advisory-time', exact, estimated, note }
```

**`coverage` and `ordering` are the honest half.** A book over a roster is a
floor, never a census, and `complete: false` says which of four reasons applies.
Prices are consensus; the *order* of them is the node's own first-seen time,
because this chain has no clock — and the value says so rather than a comment.

## Player shops

> **Published, and in the plain SDK install since `0.6.0`.** `kei.shop` lives in
> `@keicoin/player-economy`; the current `0.1.2` is resolved by the `0.8.0`
> umbrella.
> `kei-transaction@0.5.0` predated it and did not depend on it, so `kei.shop`
> was `undefined` after a `bun add kei-transaction` on that version. `0.6.0`
> first included `@keicoin/player-economy@^0.1.0`.
> `kei-transaction@0.8.0`, published 4 August 2026, depends on
> `@keicoin/player-economy@^0.1.2` and `@keicoin/market@^0.4.0`, so a plain
> `bun add kei-transaction` resolves both with one copy of the market in the
> tree.

The counterpart to the recipes below: a shop that belongs to the **player**, that
a world can embed and cannot touch.

```js
const kei = await Kei.start({
  shop: {
    currency: gold.id,                                        // your money, not Kei
    catalogue: [{ key: 'sword', asset: sword.id, title: 'Iron Sword' }],
    directory,                                                // which chains to read
  },
})

await kei.shop.list({ item: 'sword', qty: 2, each: 120 })     // open a stall
const shelves = await kei.shop.browse()                        // everybody else's
await kei.shop.buy(shelves.listings[0])                        // one block, both legs
await kei.shop.gift({ to: friend, item: 'sword' })             // no price, no offer
```

`buy()` re-reads the offer and checks the seller, the item, the quantity and the
price against the row you rendered before it signs — because matching price and
quantity alone lets a dishonest index hand you a different item at the same
price.

A balance is three numbers here, not one, and the SDK keeps them apart:

```js
const funds = await kei.shop.funds()
funds.confirmed   // what the chain says is spendable
funds.incoming    // owed to you, not yet signed for
funds.spendable   // confirmed minus what you signed a moment ago — the only one a spend uses
```

Nothing is custodial and nothing is stored. The world provides a directory of
addresses and no more; it cannot list, cancel, buy, or gift for anybody, because
it has no key for their account. A wrong directory hides a stall and cannot move
an item.

There is a runnable version in
[`examples/player-shops`](examples/player-shops).

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

**Nothing runs before you can see what it would do.** `plan()` reads the chain,
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

**A shop is blocks on the issuer's chain, and the recipe is the player's
receipt in advance.** Before accepting, the SDK compares the on-chain offer to
the player's own copy of the recipe, raw unit for raw unit. A shop that relists
a sword at ten times the price does not sell it to anybody running this code —
it just stops matching.

**One asset each way, and the refusal is at import.** A swap moves one asset
per side, so "three iron and two wood for a sword" has no block that could
settle it, and every way of splitting it leaves somebody who paid and did not
receive. `defineRecipe` refuses that shape and names the two ways round it —
price it in one currency, or split it into a sink and a reward and say plainly
that they are two steps.

There is a runnable version of all of this in
[`examples/economy`](examples/economy), and its player-owned counterpart in
[`examples/player-shops`](examples/player-shops).

## The wallet

```js
await kei.wallet.summary()      // { address, kei, keiLocked, tokens, items, locked, pending }
kei.wallet.on('change', s => {})
```

`kei`, `tokens` and `items` are what the player can spend right now; `locked` and
`keiLocked` are what they own and cannot. An offer holds the seller's own asset
until somebody takes it or they cancel it, so a listed sword leaves the spendable
balance while it is still theirs — `items` plus `locked` is the inventory, and a
screen showing only the first tells a player who just listed a sword that they
have no sword.

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

### Proving a player controls their address

An address is public, so a server binding a session to one cannot take the
client's word for it. Ask for a signature. The player's key never leaves the
SDK, and this works under every `reveal` policy, `never` included.

The server issues a challenge:

```js
import { createNonceStore, randomChallengeNonce, verifyOwnershipProof } from 'kei-transaction'

const nonces = createNonceStore()             // one use per nonce

const challenge = {
  domain: 'example.com/my-game/session/v1',   // your namespace, versioned
  address: claimedAddress,
  nonce: randomChallengeNonce(),              // server-generated, per challenge
  context: { roomId, sessionId },             // bounded, and all of it signed
}
```

The player answers it:

```js
const proof = await kei.wallet.signOwnershipChallenge(challenge)
// { address, signature, challenge }   — never a bare digest, never the key
```

The server checks it:

```js
const ok = await verifyOwnershipProof(proof, { ...challenge, nonces })
```

`verifyOwnershipProof` needs the address and nothing else — no key, no wallet,
no node — so a server holding no Kei wallet at all can run it. It returns
`false` for anything a client could have got wrong and throws only when your own
expectation is malformed, which is the one case a sentence can fix.

The wallet signs the digest it derived from the challenge, never a digest you
hand it. You may send yours along as `hash`; it is checked, and a disagreement
is refused rather than quietly corrected. That is the difference between this
and a signing oracle: the bytes a hostile server would choose are the hash of a
send.

Two properties make it safe to hand a game.

- **Domain separation.** The signed preimage is a fixed `kei-ownership-challenge-v1`
  prefix and canonical JSON of the challenge. A Kei block hashes under
  `blake2b-256("kei-block-v1")` or `kei-block-local-v0`, so a proof is not a
  transaction and a transaction is not a proof. Your `domain` travels inside the
  signed JSON rather than in front of it, so no value you choose moves those
  leading bytes.
- **One use.** The nonce is yours to generate and yours to retire. Keep the
  store, and stop accepting a challenge long before the store's bound could
  evict its nonce; `createNonceStore` is per process, so a fleet behind a load
  balancer wants one shared store implementing `NonceStore`.

What it is not: identity, proof a human is present, or a bearer token for
anything else. It says one thing — whoever sent this holds the key for that
address, once.

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

### The four tasks, in full

Everything below is the complete call. There is no setup step missing, no
session to establish, and no id to correlate.

```js
// 1. Sell something you hold, priced in the world's currency.
await kei.shop.list({ item: 'sword', qty: 2, each: 120 })

// 2. Find what is for sale, and buy one.
const shelves = await kei.shop.browse()
await kei.shop.buy(shelves.listings[0])      // verified against what you read

// 3. Give something away.
await kei.shop.gift({ to: address, item: 'sword' })     // or { kei: 0.5 }

// 4. Take your own listing back.
await kei.shop.cancel(listing)
```

Three return values are worth reading rather than ignoring, because each one
reports a limit the chain genuinely has:

| Field | What it means when it is not the happy value |
|---|---|
| `shelves.coverage.complete` | `false` — some chain failed, filled its page, or was evicted from the directory. The rows are a floor, not a census. |
| `series.ordering.exact` | `false` — some trades had no settlement time and fell back to first-seen. The prices are still consensus; the order is not. |
| `funds.spendable` vs `funds.confirmed` | They differ — something is signed and not yet read back. Check spends against `spendable`, always. |

Refusals name the account that has to act. `"only its author can cancel it"`,
`"is granted by kei_… and only that account can sign for it"`, and
`"is not the trade that was shown to you"` are all telling you that the fix is a
different signer or a re-read, not a retry.

Create Kei MMO, the creation harness, lives in the standalone
[`create-kei-game`](https://github.com/keicoin-org/create-kei-game) repository —
still that name pending the rename. Its current implementation is an unmerged
draft, [PR #1](https://github.com/keicoin-org/create-kei-game/pull/1).

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

The M0–M10 ladder was retired on 3 August 2026 for four concurrent tracks
(SPEC §13), so this is no longer a position on a count. What exists:

| | |
|---|---|
| **The §6.7 API** | Complete, running end to end, types published |
| **The chain** | A real Kei node enforcing the SPEC §5.6 / §7 ledger rules, including native `commit`/`claim`/`commit_close` in its pinned CI gate. Native `swap_offer`/`swap_accept`/`swap_cancel` are merged too; the reference mock remains for hermetic tests |
| **The network** | One public, rate-limited, best-effort Hetzner testnet node. `Kei.start()` selects it by default; `Kei.mock()` is explicit |
| **The demo** | [Button](../button) — playable single-player, every number on the chain and none in a database |
| **The market** | `@keicoin/market@0.4.0` — offers, atomic settlement, price history, the directory, bounded and abortable `book()`/`series()`/`candles()` reads, explicit coverage provenance, oriented book levels, exact cross-multiplied price ranking, and verified-before-signing acceptance. **`kei.market` from a plain `kei-transaction@0.8.0` install is this release**, without an older nested market copy |
| **The wallet panel** | `@keicoin/wallet@0.5.0` — `WalletPanel.mount()` plus the SPEC §6.6 seed-reveal friction, explicit `persistent`/`session`/`supplied` custody reporting, bounded identity-checked metadata caching, and an ordered coalesced refresh stream. The panel warns before displaying a balance when browser storage could not persist its seed |
| **Recipes and loot tables** | `@keicoin/economy@0.2.2` — recipes and drop tables remain reachable as `kei.economy`; the patch moves its market dependency floor to the coordinated `0.4.0` graph. Drop tables add no consensus rules: every block written is one the SDK could already write by hand |
| **Player shops** | `@keicoin/player-economy@0.1.2` — `kei.shop` lets players list, browse, buy, cancel, and gift from their own keys, with whole-shelf browsing aligned to the market's oriented ask levels. It is reachable from a plain `kei-transaction@0.8.0` install |
| **npm** | The initial `0.8.0` graph published and verified on 4 August 2026 was core `0.5.0`, work `0.4.1`, claims `0.5.1`, tokens `0.5.2`, market `0.4.0`, wallet `0.5.0`, economy `0.2.2`, player economy `0.1.2`, and umbrella `0.8.0`. It is no longer the whole of what the registry serves: **a release run on 5 August 2026 published six packages on top of it and then stopped**, so npm now also holds core `0.6.0`, work `0.4.2`, claims `0.6.0`, tokens `0.5.3`, market `0.5.0` and wallet `0.5.1`, with no umbrella pinning any of them. `npm install kei-transaction` still installs `0.8.0` and still imports, because the `0.8.0` floors cannot reach the newer versions — which is also why it resolves six copies of core. `@keicoin/core@0.6.0` is burnt: the tarball on npm predates [#141](https://github.com/keicoin-org/kei-transaction/pull/141) and lacks three symbols the umbrella re-exports, so it can never be the core this tree ships against. [#157](https://github.com/keicoin-org/kei-transaction/issues/157) is the diagnosis and the `0.9.0` candidate below is the fix. `create-kei-game@0.2.0` predates the harness's move to its standalone repository; future harness releases are owned there |
| **The harness** | Create Kei MMO owns its own releases. Its repository is still named [`create-kei-game`](https://github.com/keicoin-org/create-kei-game) pending the rename, and its default branch still carries the retired scaffolder that `create-kei-game@0.2.0` was published from; the transition into an ongoing MMO creation harness is an unmerged draft, [PR #1](https://github.com/keicoin-org/create-kei-game/pull/1) |
| **The work server** | `@keicoin/work@0.4.1` exports the bounded handler/server integration and the `kei-work-server` CLI; operating a public instance is separate deployment work |

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
public endpoint. Native `commit`, `claim`, and `commit_close` run through the
exact pinned SDK contract against a clean node in CI — and, since the public node
was rebuilt onto `master` on 3 August 2026, over the public URL as well: it
answers `version` with `store_version 24`, a rooted claim lands, a second claim
from the same account is refused, an offer locks its units, and one accept moves
both legs. What CI proves and what the deployment proves are still two different
things, and both have now been checked.

Nothing here holds value, and until the validator set is meaningfully
distributed, nothing should.

## Releases

Versions here are per package, because a market fix and a claims field have no
reason to share a number. What ties them together is the umbrella: whatever
`kei-transaction` pins is what a plain install actually gets, and a package
published outside that range may as well not exist. The **npm** row above is
that lesson learned the expensive way, and this section exists so the next
release is read as a set rather than as nine independent publishes.

### Unreleased — coordinated `0.9.0` candidate

None of the numbers below is published. The registry is **not** the clean
`0.8.0` set any more: a release run on 5 August 2026 published core `0.6.0`,
work `0.4.2`, claims `0.6.0`, tokens `0.5.3`, market `0.5.0` and wallet `0.5.1`
between 16:35:45 and 16:36:55 UTC, and stopped before economy, player economy
and the umbrella. What npm holds is a half-graph with no umbrella over it, and
one number in it is unusable
([#157](https://github.com/keicoin-org/kei-transaction/issues/157)).

`publish.log` shows that run's `npm publish` for wallet failing with
`E403 … cannot publish over the previously published versions: 0.5.1`, which
reads as though `0.5.1` was already there. It was not. The registry records
exactly one publish time for `@keicoin/wallet@0.5.1` — 16:36:54.939 UTC, inside
that run's own window — and the integrity it serves,
`sha512-GoC1spIJbGkY/…tjD67wZz9NGzQ==`, is the integrity that run's log printed
for the tarball it had just packed. The `403` was npm refusing a **re-`PUT` of
an upload that had already succeeded**, not a stale `404` in the pre-check. The
practical difference is one package: six of the nine are published, not five.

**`@keicoin/core@0.6.0` on npm is burnt.** Unpacking the published tarball shows
no `src/swaps.ts` and no `src/ownership.ts`, and its public entry exports 123
names where the tree's exports 141. So it contains neither
[#141](https://github.com/keicoin-org/kei-transaction/pull/141)'s `parseSwapInfo`
/ `parseSwapOffer` / `parseAccountSwaps` nor
[#142](https://github.com/keicoin-org/kei-transaction/pull/142)'s ownership
surface — all of which the umbrella re-exports statically. A consumer install of
the graph as previously numbered dies at import under Node and under Bun with
`SyntaxError: The requested module '@keicoin/core' does not provide an export
named 'parseAccountSwaps'`. A published version cannot be replaced, so core moves
to `0.7.0` and every dependent's floor moves with it.

Each number below is derived from what changed **inside that package since the
version the registry actually serves**, established by unpacking that published
tarball and diffing it against this tree, not from the package's role in the
release.

| Package | On the registry | After release | Why |
|---|---:|---:|---|
| `@keicoin/core` | `0.6.0` burnt | **`0.7.0`** | Minor. `swaps.ts` ([#141](https://github.com/keicoin-org/kei-transaction/pull/141)) and `ownership.ts` ([#142](https://github.com/keicoin-org/kei-transaction/pull/142)) are absent from the published tarball entirely; the entry gains 18 names. #141 also **changed an existing failure mode**: `swap_info` with no `offer` and `account_swaps` with no `offers` used to default to "no such offer" and "no offers", and are now refused as malformed |
| `@keicoin/work` | `0.4.2` | **`0.4.3`** | Patch. Every file under `src/` is byte-identical to the published tarball; only its core floor moves |
| `@keicoin/claims` | `0.6.0` | **`0.7.0`** | Minor. `headroom.ts` is new, the entry gains `assertCommitHeadroom` and `CommitHeadroomOptions` ([#137](https://github.com/keicoin-org/kei-transaction/pull/137)), and [#159](https://github.com/keicoin-org/kei-transaction/pull/159) rewrote which refusal an unpayable drop raises |
| `@keicoin/tokens` | `0.5.3` | **`0.6.0`** | Minor, and the one to read before publishing. The entry gains `IssuanceField`; `issueToken()` now throws `issuance-mismatch` where a contradicting re-issue used to succeed silently ([#148](https://github.com/keicoin-org/kei-transaction/pull/148)); and [#149](https://github.com/keicoin-org/kei-transaction/pull/149) changes the symbol and asset id derived from **every** item name |
| `@keicoin/market` | `0.5.0` | **`0.6.0`** | Minor. `stored-history.ts` is new and the entry goes from 172 to 201 exports — bounded durable storage ([#147](https://github.com/keicoin-org/kei-transaction/pull/147)) and unrounded stored price history ([#161](https://github.com/keicoin-org/kei-transaction/pull/161)) |
| `@keicoin/wallet` | `0.5.1` | **`0.6.0`** | Minor. The published tarball contains no `signOwnershipChallenge` at all, so `WalletApi` gains a required member ([#142](https://github.com/keicoin-org/kei-transaction/pull/142)), and the entry gains `LockedHolding` and the four `WalletMarket*` types ([#139](https://github.com/keicoin-org/kei-transaction/pull/139)) |
| `@keicoin/economy` | `0.2.2` | **`0.2.3`** | Patch, and never published at `0.2.3`. Its entry is byte-identical to the published one; only `batch.ts` moved to claims' shared headroom helper, with the same `no-headroom` code |
| `@keicoin/player-economy` | `0.1.2` | **`0.1.3`** | Patch, and never published at `0.1.3`. Every file under `src/` is byte-identical to `0.1.2`; its core and market floors move |
| `kei-transaction` | `0.8.0` | **`0.9.0`** | Minor, and never published at `0.9.0`. Its entry goes from 259 to 399 exports — the durable claims, market storage and stored-history, swap-parsing, ownership and wallet-market surface — and it re-floats every internal range onto the versions above |

Only `work` and `player-economy` are dependency-only, and that is a measurement
rather than a judgement: their `src/` trees hash identically to the tarballs npm
serves. #157 proposed dependency-only patches for claims, market, tokens and
wallet as well; that is no longer true, and this section takes minors for them
instead. Dependency-only moves are patches; anything that gained API or changed a
failure takes a minor, because this repository does not hide new API in a patch —
and a minor also has the useful property that no old caret range can reach across
it, so the graph is closed by arithmetic rather than by good intentions.

#### Two things a person doing this release needs to have read

**#149 must not reach npm until the consumer checklist in
[#155](https://github.com/keicoin-org/kei-transaction/issues/155) is ticked.**
The published `@keicoin/tokens@0.5.3` still derives an item symbol from a
12-character slug and a 2-byte digest; this tree derives it from a 7-character
stub and a 6-byte digest. So a game that upgrades and keeps calling
`items.create({ name })` derives a different symbol for the same name and issues
a **second** asset for an item its players already hold: Kei burnt on the new
issuance, and the units in inventories orphaned against an id nothing mints into
any more. The five consumers to confirm first are world-of-wonder, button,
`create-kei-game`'s templates, carpet-markets and kei-wallet.
`items.create({ symbol })` is the pin, and it needs no new API. `@keicoin/tokens`
is where the change lands, and the umbrella carries it too.

**`issuance-mismatch` now shadows `item-name-mismatch`.** #148 and #149 landed
together, and in `items.create()` the `name` comparison inside
`assertIssuanceMatches` runs first — before `create()` reaches its own
`item-name-mismatch` guard. So a symbol collision on an existing item surfaces as
`issuance-mismatch`, and #149's guard is unreachable through `create()`. Any
consumer error handling or documentation written against `item-name-mismatch` is
wrong as of this release.

`npm run release:check` is the mechanical proof that the graph is closed: it
reads every public manifest, refuses any internal range that cannot select the
version being published, and refuses a `bun.lock` whose workspace names,
versions and dependency ranges do not match the manifests. It runs in CI, so a
range and a version cannot drift apart between releases. What it cannot see is a
range selecting a *published* version that lacks a symbol the tree re-exports —
which is exactly #157 — so the tarball-integrity comparison in `publish.sh` is
the guard that matters, and
[#158](https://github.com/keicoin-org/kei-transaction/issues/158) puts a
`prepack` build and a manifest-target check underneath it in every package.

Publication order stays core, work, claims, tokens, market, wallet, economy,
player economy, umbrella last. It requires a person with an authenticator: the
script needs an OTP, an attached HEAD on `master`, and that HEAD to match a
freshly fetched `origin/master` exactly.

### `0.8.0` — published 4 August 2026

This coordinated market-safety set is on npm. At publication, fresh empty projects installed
`kei-transaction@0.8.0` with both npm and Bun, resolved one compatible copy of
every package in the graph, and imported the umbrella successfully. The release
advanced only packages whose public surface or dependency floor changed; the
other graph members keep their existing registry versions and reviewed
tarballs.

| Package | Previous | Published | Why |
|---|---:|---:|---|
| `@keicoin/core` | `0.5.0` | `0.5.0` | Unchanged; market's safety work does not change its core dependency |
| `@keicoin/work` | `0.4.1` | `0.4.1` | Unchanged |
| `@keicoin/claims` | `0.5.1` | `0.5.1` | Unchanged |
| `@keicoin/tokens` | `0.5.2` | `0.5.2` | Unchanged |
| `@keicoin/market` | `0.3.0` | **`0.4.0`** | Minor. Refuses asset-metadata identity mismatches; bounds long-expiry timers, generated candles, directories, and total account walks; validates custom account sources and matched candle times; preserves safe negative candle buckets; ranks book levels by exact cross-multiplied price ratios; and exports the new bounds and typed error codes |
| `@keicoin/wallet` | `0.5.0` | `0.5.0` | Unchanged; it does not depend on market |
| `@keicoin/economy` | `0.2.1` | **`0.2.2`** | Patch. Source and exports are unchanged; its market floor moves to `^0.4.0` so the coordinated install cannot retain an older market copy |
| `@keicoin/player-economy` | `0.1.1` | **`0.1.2`** | Patch. Source and exports are unchanged; its market floor moves to `^0.4.0` for the same single-copy guarantee |
| `kei-transaction` | `0.7.0` | **`0.8.0`** | Minor. Re-exports `DEFAULT_MAX_CANDLES`, `MAX_CANDLES`, `MAX_ACCOUNTS_PER_WALK`, and `MAX_DIRECTORY_LIMIT`, and moves its market/economy/player-economy ranges to the published graph |

The market's new constants and `MarketErrorCode` members are additive public
surface, and its defensive refusals deliberately tighten previously accepted
runtime inputs. Under this repository's strict pre-1.0 policy that warrants a
market minor rather than a patch. The umbrella also takes a minor because it
re-exports that surface. Economy and player economy contain no source change,
but `^0.3.0` cannot select market `0.4.0`, so their dependency-only releases are
patches. Core, work, claims, tokens, and wallet neither changed nor depend on
market and remain byte-for-byte registry dependencies.

The release incorporates the corrective sequence in PRs
[#76](https://github.com/keicoin-org/kei-transaction/pull/76),
[#77](https://github.com/keicoin-org/kei-transaction/pull/77),
[#78](https://github.com/keicoin-org/kei-transaction/pull/78),
[#79](https://github.com/keicoin-org/kei-transaction/pull/79),
[#81](https://github.com/keicoin-org/kei-transaction/pull/81),
[#84](https://github.com/keicoin-org/kei-transaction/pull/84),
[#88](https://github.com/keicoin-org/kei-transaction/pull/88), and
[#91](https://github.com/keicoin-org/kei-transaction/pull/91). There is no wire,
ledger, or consensus change. Publication ran market first, then the two
dependency-only consumers, then the umbrella; the release script checked the
unchanged graph members' reviewed integrities before skipping them.

### `0.7.0` — published 4 August 2026

This coordinated set is on npm. Fresh empty projects installed
`kei-transaction@0.7.0` with both npm and Bun, resolved one compatible copy of
every package below, imported every public entry, and found the
`kei-work-server` binary. Release coordination and downstream documentation are
tracked in [#53].

| Package | Published | Why |
|---|---:|---|
| `@keicoin/core` | `0.5.0` | Bounded HTTP requests and response bodies, single-flight receivable polling with backoff, cancellation, typed timeout errors, and credential-safe endpoint diagnostics |
| `@keicoin/work` | `0.4.1` | Dependency-only move to `@keicoin/core@^0.5.0` |
| `@keicoin/claims` | `0.5.1` | Dependency-only move to `@keicoin/core@^0.5.0` |
| `@keicoin/tokens` | `0.5.2` | Dependency-only move to `@keicoin/core@^0.5.0` and `@keicoin/claims@^0.5.1` |
| `@keicoin/market` | `0.3.0` | Bounded and abortable aggregate reads, explicit scope-safe coverage provenance with structural validation before merges, oriented `BookLevel` prices, deterministic precision/race/paging conformance, validated limits and retry timers |
| `@keicoin/wallet` | `0.5.0` | Durable-seed reporting, bounded identity-checked metadata caching, and a coalesced ordered refresh stream with subscription-instance stale-paint protection |
| `@keicoin/economy` | `0.2.1` | Dependency-only move to core `^0.5.0`, claims `^0.5.1`, and market `^0.3.0` |
| `@keicoin/player-economy` | `0.1.1` | Correct whole-shelf browsing to consume oriented ask levels, plus dependency moves to core `^0.5.0` and market `^0.3.0` |
| `kei-transaction` | `0.7.0` | The coordinated umbrella range that exposes one copy of every release above and records its public npm access policy in the manifest |

`HttpNodeOptions.requestTimeout` is new public configuration, so core takes a
strict-semver minor rather than hiding that surface in a patch. Under 0.x caret
rules `^0.4.0` excludes `0.5.0`; every direct core consumer therefore moves its
floor and is republished. Dependency-only consumers take patches; player economy
also carries its compatible browse fix, while market, wallet, and the umbrella
keep the minor versions warranted by their own public additions.

The publish order was core, work, claims, tokens, market, wallet, economy,
player-economy, and the umbrella last. `sh scripts/publish.sh --check` requires
the committed Bun lockfile, installs it
frozen, cleans and rebuilds every declaration and JavaScript artifact, runs the
suite, validates every manifest export and binary in each tarball, then installs
the packed graph and imports its public Node entries. Publication is allowed only
from the fetched, merged default-branch commit, and interrupted reruns skip an
existing version only when its registry integrity matches the reviewed local
artifact. The exact tarballs were verified before publication, and the clean
consumer checks above were repeated against the registry artifacts afterward.

[#53]: https://github.com/keicoin-org/kei-transaction/issues/53

### `0.6.0` — published 4 August 2026

This set remains on npm. At publication, `npm view kei-transaction version`
reported `0.6.0`, and a plain `bun add kei-transaction` (or `npm install`)
resolved every version below — verified against the registry on 4 August 2026.

| Package | Previously | Published | Why |
|---|---|---|---|
| `kei-transaction` | `0.5.0` | **`0.6.0`** | Minor. Re-exports the drop-table API and takes `Kei.start({ tables })`; and it is the release that finally depends on `@keicoin/player-economy` and on `@keicoin/market@^0.2.0`, so `kei.shop`, `book()`, `series()`, `candles()` and `accept({ expect })` reach a plain install |
| `@keicoin/economy` | `0.1.0` | **`0.2.0`** | Minor. Drop tables: `defineDropTable`, `publishDrop`, `verifyAward`, `economy.drop()`, `economy.verifyDrop()`. Additive — every existing recipe export keeps its shape |
| `@keicoin/claims` | `0.4.0` | **`0.5.0`** | Minor. `BuiltCommit.saltProof` — the sibling path from the salt leaf, which is what lets a drop table bind to the root published for it. Additive; no root, proof or block changes |
| `@keicoin/tokens` | `0.5.0` | **`0.5.1`** | Patch. Source is unchanged. Its `@keicoin/claims` floor moves to `^0.5.0`, because for a 0.x package `^0.4.0` stops below `0.5.0` and leaving it would put two copies of claims in one tree |
| `@keicoin/wallet` | `0.4.1` | **`0.4.2`** | Patch, same reason: `@keicoin/claims@^0.5.0` and `@keicoin/tokens@^0.5.1` |
| `@keicoin/market` | `0.2.0` | `0.2.0` | Unchanged since it published. The umbrella reaches it by moving its own range, not by republishing the market |
| `@keicoin/player-economy` | `0.1.0` | `0.1.0` | Unchanged since it published |
| `@keicoin/core` | `0.4.0` | `0.4.0` | Unchanged |
| `@keicoin/work` | `0.4.0` | `0.4.0` | Unchanged |

**The two patch bumps are the part worth explaining**, because it is easy to read
them as churn. `@keicoin/tokens` and `@keicoin/wallet` contain not one changed
line. What changed is the floor they declare on `@keicoin/claims`, and under 0.x
caret rules `^0.4.0` refuses `0.5.0` outright. Left alone they would each drag a
second, older claims into the same `node_modules` — so `kei.token.commit()` would
return a `BuiltCommit` with no `saltProof` while `buildCommit` exported from
`kei-transaction` returned one with it, in a single install. That is the same
shape of defect as the `market@0.1.1`/`0.2.0` split this release exists to close,
and it is cheaper to refuse than to document. Every intra-workspace range in this
set resolves to exactly one version of every package.

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
| `@keicoin/market` | offers, atomic swap settlement, bounded multi-account books, price history — depends on `@keicoin/core` alone |
| `@keicoin/economy` | recipes — rewards, sinks, shops and crafts, with a dry run before anything signs — and drop tables, published as commitments |
| `@keicoin/player-economy` | player-owned shops: list, browse, buy, cancel, gift, and honest pending state |

`@keicoin/core` depends on nothing else in the tree.

The harness behind `npm create kei-game` (SPEC §11.3) is not part of the SDK.
It moved from this workspace to the standalone
[`create-kei-game`](https://github.com/keicoin-org/create-kei-game) repository so
its release and game-creation workflow can evolve independently. The original
in-tree design and validation record remains in
[`docs/decisions-m9.md`](docs/decisions-m9.md); ongoing M9 implementation is in
[standalone PR #1](https://github.com/keicoin-org/create-kei-game/pull/1).

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
- [`docs/decisions-drop-tables.md`](docs/decisions-drop-tables.md) — how a loot
  table binds to a published root, and the boundary of what that proves
- [`docs/decisions-wallet-durability.md`](docs/decisions-wallet-durability.md) —
  why a seed store now reports what a write was worth, and why a session-only
  wallet reports rather than throws
- [`docs/decisions-player-economy.md`](docs/decisions-player-economy.md) — what
  two applications had to invent on top of `@keicoin/market`, what moved into the
  SDK, the acceptance criteria, and the gaps that remain
- [`docs/rpc.md`](docs/rpc.md) — the node contract the fork has to serve

## Credit

Key derivation, signing, and address encoding come from
[`@bananocoin/bananojs`](https://github.com/BananoCoin/bananojs). Kei is a fork of
Banano, itself a fork of Nano, and hand-rolled crypto is how wallets lose money.

MIT.
