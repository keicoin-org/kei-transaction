# Player economy — decisions

What `@keicoin/market` was missing, what `@keicoin/player-economy` is for, and
the exact behaviour both now owe.

This is the implementation spec for the slice. As with
[`decisions-m0.md`](decisions-m0.md) and [`decisions-m5.md`](decisions-m5.md),
**nothing here overrides `SPEC.md`.** Where this document and the parent spec
disagree, the parent spec is right and this is a bug.

---

## 1. The evidence

Two applications have now been built on `@keicoin/market`, and both had to
invent the same missing layer before they could draw a single screen.

| What they needed | `carpet-markets` | `world-of-wonder` |
|---|---|---|
| A roster of which chains to read | `traders: Set<string>`, unbounded | `traders: Map`, LRU, `ROSTER_LIMIT = 128` |
| Asks + bids for one asset | `book()`, two `market.offers()` walks | `walk()`, two walks |
| Cache / single-flight / stale-beats-empty | `SUMMARY_TTL_MS`, per-coin | `CACHE_MS`, `inflight`, `generation` |
| Many assets summarised from one walk | — | `summarise()`, hand-rolled median |
| A price series a chart can draw | `PriceChart`, sorts by `settledAt ?? seenAt` | — |
| confirmed / incoming / in-flight balances | `lib/balance.ts` (104 lines) + `act()` in `use-market.tsx` | `until()` polling with a 20s timeout |
| Re-read and verify before accepting | — | `offerMatchesDisplay` in `shared/market.ts` |
| Unit price → lot price | `amount * unitPrice`, with a comment about the factor-of-`amount` bug | manual |
| Pricing in the world's own coin | — | `market.offer()` longhand, because `sell()` hardcodes Kei |
| Saying what the walk could not see | a comment: "a floor, not a census" | an `accounts` count |

Three of those are load-bearing correctness, not convenience:

- **`offerMatchesDisplay`.** Its own comment states the reason: *matching the
  price and quantity is insufficient — a dishonest hall could attach the hash of
  a different item at the same price and make the wallet accept that asset.*
  `carpet-markets` does not have this check. A primitive that every consumer must
  reinvent to be safe belongs in the SDK.
- **The three balances.** `lib/balance.ts` exists because showing only
  `confirmed` makes a market page look broken for two seconds after every action,
  and adding the other two in makes it offer money the ledger will refuse. Every
  application that ever draws a balance next to a button hits this.
- **The roster bound.** `world-of-wonder` capped it and wrote a paragraph
  explaining why; `carpet-markets` did not, and its `watch` route is reachable
  unauthenticated. That is a per-request cost set by whoever last posted to it.

**The diagnosis:** `@keicoin/market` is correct and too low-level. It models the
ledger exactly — an offer is a block, a trade is a settled offer — and stops
there, which leaves everything between "a block exists" and "a person can see it"
to the application. This slice moves the reusable half of that gap into the SDK
and leaves the rest (UI, framework, transport) where it belongs.

---

## 2. What is in scope, and what is refused

### In

- Bounded multi-account book aggregation over an **explicit account-directory
  input**.
- Settled-trade queries, price series, and chart-ready bucketing, with the
  sequence and time semantics stated in the returned value.
- Lifecycle classification and reconciliation for listings.
- Terms verification before signing.
- A player-owned shop surface: list, browse, buy, cancel, gift, funds, pending.

### Out — refused for cause, and these are not negotiable by degrees

| Refused | Why |
|---|---|
| **A custodial server** | The burden Kei exists to remove (SPEC §5.2, §4). A directory holds addresses, never balances and never keys. |
| **Off-chain balances** | `Funds` is arithmetic over two node reads and this process's own unsettled writes. Nothing is stored. |
| **A network-wide indexer** | SPEC §9.4. Every read is a bounded walk of named chains, and every gap in that walk is reported (§4.2). |
| **AMM / bonding curve / order matching** | SPEC §3, §9.4, §9.5. `book()` sorts; it does not match, quote, or price. There is no reserve to quote against, and adding one is the route §9.5 already disqualified. |
| **A React dependency** | `@keicoin/player-economy` imports `@keicoin/core` and `@keicoin/market` and nothing else. Its event surface is `Emitter`, which any framework adapts in ten lines. |
| **Any claim that mainnet exists** | Untouched. `Kei.start({ network: 'mainnet' })` still refuses (SPEC §15). |
| **Duplicating the issuer recipe surface** | §3 below. |
| **Consensus time** | §5. Nothing here introduces a deadline the ledger enforces, because the ledger cannot (SPEC §5.5). |

---

## 3. The boundary against `@keicoin/economy`

The two packages are counterparts and the split is by **who signs**, not by what
the operation is called.

| | `@keicoin/economy` | `@keicoin/player-economy` |
|---|---|---|
| Whose account | The issuer's | The player's |
| What it declares | Recipes: costs, grants, strategy | Nothing. It lists what the wallet already holds. |
| Where stock comes from | `stock()`, which will **mint** the shortfall | Never mints. There is nothing to mint from. |
| The listing's terms | Fixed by the recipe, and a player's copy is compared raw unit for raw unit | Chosen by the seller, per listing |
| The read before buying | The recipe is the receipt in advance | The rendered row is the receipt, checked field by field |
| Runs in | Server (`Kei.server`) for `stock`; browser for `run` | Browser |

`shop.list()` is deliberately **not** `economy.stock()` with the recipe removed.
`stock()` mints, is issuer-only, refuses in a browser context, and derives its
price from a declaration both halves of the game import. `list()` does none of
that: it prices what the caller says, from what the caller holds, from any
account, and there is no declaration anywhere.

Neither package re-exports the other's surface. `kei.economy` and `kei.shop`
share one `MarketApi` instance so that exactly one background expiry sweep runs
(SPEC §9.3).

---

## 4. `@keicoin/market` — the additions

### 4.1 The directory (`directory.ts`)

```ts
interface AccountDirectory { accounts(): readonly string[] | Promise<readonly string[]> }
type AccountSource = string | readonly string[] | AccountDirectory
createDirectory({ limit = 128, accounts }): MutableDirectory
```

`ListOptions.from` and `TradeOptions.from` are widened from
`string | readonly string[]` to `AccountSource`. **Purely additive** — every
existing call site still compiles and still means the same thing.

`AccountDirectory` is one method so a world that already has a player table
implements it in four lines and never touches `createDirectory`. `MutableDirectory`
is the in-memory LRU both applications wrote:

- `watch(address)` returns `false` for anything that is not an address rather
  than throwing, because it is normally fed straight from an unauthenticated
  route.
- Re-announcing moves an address to the newest end of the eviction order.
- The default `limit` is **128**, and the reasoning is `world-of-wonder`'s: a
  walk is one `account_swaps` per account, so this is a ceiling of ~128 node
  calls per read. It is chosen against what a walk costs, not against how many
  players a world might have.
- Evictions are **counted** and surface as `Coverage.dropped` (§4.2). A bound
  that silently loses listings is a bound that reads as "nobody is selling".

**Nothing read through a directory is trusted.** Every offer it leads to is
re-read from the chain, and `accept({ expect })` (§4.5) checks the terms against
that read before signing. A wrong directory can hide a stall; it cannot move an
asset.

### 4.2 The book (`book.ts`)

```ts
market.book({ from, asset?, quote = KEI, limit = 100, includeExpired, includeMine }): Promise<Book>
```

Two properties that hand-written versions kept missing:

**One walk, not two.** Asks and bids are a local partition of one
`accountSwaps(account, { state: 'open' })` per account. Both applications made
two calls per account per refresh for a set of blocks the node already returned
once.

**Coverage is data, not a comment.**

```ts
interface Coverage {
  asked: number                                        // accounts in the walk
  read: number                                         // accounts that answered
  failed: { account: string; reason: string }[]        // per-chain read errors
  truncated: string[]                                  // chains that filled their page
  dropped: number                                      // evicted by a bounded directory
  skipped: string[]                                    // entries that were not addresses
  complete: boolean                                    // true only if none of the above
}
```

A failed chain read is a **gap**, not the end of the walk: the book returns what
it has and names what it lost. A page that blanks whenever one node call times
out reads as "the market closed", which it is not.

Leaving `asset` out reads the whole shelf against `quote` — every open offer
against the world's currency, whatever it is selling. That is the query a bazaar
asks, and doing it per asset is one walk per asset. `asset === quote` is refused,
because a book of a thing against itself has no two sides.

Sorting is ascending on both sides, for two reasons that happen to agree: an
ask's `price` is quote-per-unit so smallest is cheapest, and a bid gives quote
and wants the asset so its `price` is asset-units-per-quote and the bid paying
most is the smallest number. `bidPrice(offer)` inverts a bid for display, which
is the arithmetic both applications did by hand.

### 4.3 Series, candles, and the price index (`series.ts`)

```ts
toSeries(trades, { asset, quote?, last? }): Series          // pure
toCandles(trades, { ...,  every, fill? }): Candle[]         // pure
priceIndex(trades, { quote?, assets? }): Map<AssetId, PriceSummary>   // pure
market.series(...) / market.candles(...) / market.prices(...)         // read then compute
```

All three take trades and do arithmetic, so a view that already has the trades
draws a chart and a table from one walk.

`priceIndex` is `world-of-wonder`'s `summarise()`: fifteen archetypes on a board
means fifteen `market.price()` calls re-reading the same chains fifteen times.
Grouping once is the same set of trades and one walk.

#### The honesty contract — read this before shipping a chart

This is the single most load-bearing paragraph in the document, because the gap
it describes is invisible until somebody argues about a price.

**Consensus, identical on every node, forever:** that a trade happened, the two
parties, the assets, the units, and therefore the price. Every statistic derived
from those numbers alone — median, low, high, volume, count, and the OHLC *of a
given set of trades* — is a fact anybody can recompute.

**Not consensus: when.** The block-lattice has no clock (SPEC §5.5), and that is
deliberate: every deadline in the design was replaced by a signed act by the
party whose asset was at stake, precisely so no block type carries a time anybody
must agree on. `settledAt` and `seenAt` are the node's own first-seen times —
what Nano's `local_timestamp` is. Two nodes disagree; a restarted node forgets.

**Ordering is the consequence.** A settled trade is an offer block on one chain
and an accept block on another. `height` orders blocks *within* one chain and
says nothing across two, so there is no total order over trades. A series must
pick one, and this picks advisory time. It says so **in the returned value**:

```ts
series.ordering  // { by: 'advisory-time', exact: boolean, estimated: number, note: string }
```

`estimated` counts the points whose time fell back to `seenAt`, so a chart drawn
from a node that forgot half its timestamps can admit it. A candle is the same
bargain with a bucket around it: the OHLC of a bucket is exact, and *which*
trades are in it is advisory. A point with no time at all is dropped from
`toCandles` rather than bucketed at the epoch.

There is deliberately no `sequence` field claiming a global order. Inventing one
would be inventing consensus time in a field name, which is the change SPEC §5.5
calls the most dangerous thing this project could add.

### 4.4 Lifecycle and reconciliation (`lifecycle.ts`)

```ts
type OfferLife = 'live' | 'reserved' | 'stale' | 'taken' | 'cancelled'
classify(offer, { viewer?, now? }): OfferLife
settleable(life): boolean                        // 'live' | 'stale'
market.lifeOf(offer): OfferLife
market.reconcile(snapshot): Promise<Reconciliation>
```

`stale` is the one that matters: **open, past its advisory expiry, and still
settleable.** Hiding it is a client's choice; the SDK's background sweep is what
actually removes it (SPEC §9.3). Collapsing `taken` and `cancelled` into one
"gone" loses the only two facts a player wants — who got it, or whether it is
coming back.

`reconcile` reads one offer per hash, because an offer's state lives in the lock
it created rather than in any one chain's history. It returns `live`, `stale`,
`gone` (each with a sentence), `changed` (before/after, when the snapshot carried
objects rather than hashes), and `unknown`.

### 4.5 Verification before signing

```ts
market.accept(offer, { expect: Expectation })
verify(offer, expected): Verification
assertMatches(offer, expected): void
expectationFrom(offer): Expectation
```

`Expectation` covers the hash, the seller, both legs' asset and amount, and the
reserved buyer. Every field given is checked; fields left out are not. The check
runs against the chain's copy, immediately before the accept block is signed, and
after every other refusal — so the message a caller gets is the most specific one
available.

The failure names both values on every mismatched field:

> Offer 4A2… is not the trade that was shown to you: what you receive was shown
> as SWORD… and the chain says RUSTY_NAIL…; how much you pay was shown as 5 and
> the chain says 500. An index is a list of where to look and never an authority
> (SPEC §9.4), so this wallet signs the ledger's numbers and refuses anybody
> else's. Refresh the listing and look again.

### 4.6 Compatibility and the version

**`@keicoin/market` 0.1.1 → 0.2.0. A minor bump, and no breaking change.**

Every addition is additive:

- New exports. No export removed or renamed.
- `accept(offer)` gains an optional second parameter.
- `ListOptions.from` and `TradeOptions.from` are **widened**, which every
  existing argument still satisfies.
- `BookOptions.asset` is optional, on a type that did not previously exist.

Two changes are worth naming rather than hiding:

1. **`MarketApi` gained methods.** Anyone *implementing* `MarketApi` by hand
   would break. Nobody does — it is a return type produced by `createMarket`, and
   the one place in the tree that accepts one (`EconomyOptions.market`) receives
   the real thing. The minor bump covers it under 0.x semantics, and a major bump
   for a type nobody implements would cost every consumer a migration to buy
   nothing.
2. **`MarketContext` gained a required `toOffer`.** It is exported for the same
   reason `LegMeta` is — so the internals are readable — and it is constructed in
   exactly one place, inside `createMarket`. No consumer builds one.

A new major was considered and rejected: there is no behaviour change to any
existing call, so a `1.0` here would signal a migration that does not exist and
would strand `@keicoin/economy` and `kei-transaction` on a range bump for no
reason.

`readTrades` gained one behaviour change that is a **fix**, not a break: a chain
whose read throws is now skipped rather than failing the whole query, matching
`book()`. A price summary missing one seller's trades is wrong by omission; one
that throws is a chart that disappears whenever a node call times out.

---

## 5. `@keicoin/player-economy` — the shape

```ts
const shop = createPlayerEconomy(client, { currency, catalogue, directory, market })
// or, bundled:
const kei = await Kei.start({ shop: { currency, catalogue, directory } })
kei.shop
```

### 5.1 The surface

| Call | What it does |
|---|---|
| `list({ item, qty?, each? \| price?, to?, expiresIn? })` | One `swap_offer`. The ledger locks the goods. |
| `cancel(listing \| hash)` | One `swap_cancel`. Only the author can. |
| `mine({ includeExpired? })` | This wallet's stall, off its own chain. |
| `browse({ item?, from?, includeMine?, includeExpired?, limit? })` | Every stall on the directory's chains, grouped by seller, cheapest per unit first, with `coverage`. |
| `shelfOf(address)` | One seller's stall. |
| `buy(listing \| hash, { verify? })` | One `swap_accept`, verified against the rendered row first. |
| `gift({ to, kei \| item \| asset, amount? })` | One send or one transfer. No offer, no accept, no price. |
| `funds(asset?)` | confirmed / incoming / committed / spendable / projected, decimal **and** raw. |
| `pending()` / `on('change')` / `on('settled')` | What this wallet has signed and not read back. |
| `sync()` | Collect arrivals, re-read the stall, report what left. |
| `history({ item })` / `candles({ item, every })` | What it sold for, ready to draw. |

### 5.2 `each` versus `price`

Exactly one is required, and naming both or neither is refused with both
meanings spelled out. This exists because it is the most expensive mistake made
against this package so far: `carpet-markets` computes `amount * unitPrice` by
hand with a comment warning that getting it backwards is "several orders of
magnitude" on a coin like this.

The multiplication is done in **raw integers** (`toRaw(each) * BigInt(qty)`),
never in a JS number, and the offer is published from the exact decimal string.
A number does the multiplication wrong at eighteen decimal places, and a rounded
price is a listing that does not say what the seller meant.

### 5.3 The three balances

`Funds` carries all five numbers, each in decimals **and** raw:

```
confirmed   what the chain says is spendable
incoming    owed and not yet signed for (SPEC §5.6.3)
committed   signed by this process and not yet read back
spendable   confirmed - committed, floored at zero
projected   confirmed + incoming + everything in flight
```

Only `spendable` is ever compared against a spend. Credits in flight are **never**
netted off a spend and only appear in `projected`, because money arriving does
not fund a spend until it has arrived. The raw integer is the one a comparison
uses; the decimal number is for display, and at eighteen places it rounds.

A `funds()` read whose node call throws returns zeroes rather than rejecting: a
purse that blanks is wrong in a way a view can see, and a thrown promise is wrong
in a way it cannot. Neither is a spend, and `canSpend` refuses both.

### 5.4 Pending, and what it is not

Every write goes through one wrapper that registers a `Pending` entry **before**
the block is signed and removes it once the action has finished. While it is up
it is a debt, so two actions started in the same second cannot each be checked
against the same units.

A refusal that happens *before* anything is signed — not enough gold, unknown
ware, both prices given — writes no pending entry at all, because nothing was
ever in flight. A failure *during* the action leaves a `settled` event whose
`state` is `'failed'` and whose `error` is the SDK's own sentence, unrewritten.

**This is not an order book, a queue, or a retry mechanism.** It is arithmetic
over this process's own unsettled writes, it holds no value, it survives no
reload, and losing it costs one accurate balance for one poll.

### 5.5 `sync()` and the departure diff

`market.mine({ state: 'open' })` cannot answer "what left", because a listing
that was taken is no longer open and so is no longer returned. Departures are
therefore a diff: the shop tracks the hashes it has seen open on its own chain,
`sync()` reconciles that set, reports each departure **exactly once**, and then
forgets it. A `gone` list that repeats itself every poll is a list a view learns
to ignore.

### 5.6 The catalogue

Maps a game's word (`'sword'`) to an asset id, both ways. An unknown key is
refused **by name, with the list of known keys**, because "this world does not
deal in 'sword'" with no list sends somebody reading source for the right
spelling. A value that is not a key and looks like an asset id is treated as one,
so trading something the world never declared needs no ceremony. An asset with no
catalogue entry still trades and comes back as an unnamed listing.

### 5.7 What is deliberately absent

- **No memo on a gift.** No block type carries one yet, so a `memo` option would
  be a field that always throws, and an asset transfer has nowhere to put one
  even after Kei sends can. The hash a gift returns is exact, which is what a
  note would have been used to correlate.
- **No caching or single-flight.** Both applications wrote one, and both wrote a
  *different* one — 3s with generation-based invalidation, 4s per-coin with
  stale-on-failure. The correct TTL depends on the view, and a cache in the SDK
  would be a second source of truth about what the chain says. The book is one
  call; wrapping it is four lines the application already knows how to write.
- **No auto-refresh loop.** Polling cadence is a UI decision.

---

## 6. Acceptance criteria

Each is a test. The file and the name are given so a reviewer can find it.

### `@keicoin/market`

| # | Criterion | Where |
|---|---|---|
| M1 | A directory refuses non-addresses, bounds itself, evicts least-recently-heard-from, and counts evictions | `market/test/aggregation.test.ts` — "the account directory" |
| M2 | `from` accepts an address, a list, or any object with `accounts()` | same — "a from can be an address, a list, or any directory" |
| M3 | A book returns asks ascending, bids best-first, `bestAsk`/`bestBid`/`spread`, one read per account | `kei/test/market-aggregation.test.ts` — "asks and bids come off one read per account" |
| M4 | A chain whose read throws is recorded in `coverage.failed` and does not fail the book | same — "an unreachable chain is a gap" |
| M5 | A chain that fills its page is recorded in `coverage.truncated` | same — "a full page says so" |
| M6 | A bounded directory's evictions surface as `coverage.dropped`, `complete: false` | same — "a bounded directory reports what it dropped" |
| M7 | A malformed address is skipped and counted, not thrown on | same — "an address that is not an address is skipped" |
| M8 | Omitting `asset` reads the whole shelf against one quote; `spread` is null | same — "leaving the asset out" |
| M9 | `asset === quote` is refused by name | same — "a book of an asset against itself" |
| M10 | A series is oldest-first, indexed, with `first`/`last`/`change`/`changeRatio` | `market/test/aggregation.test.ts` — "points come back oldest first" |
| M11 | `price` is per unit, so a lot of ten is not ten times the price | same — "the price is per unit" |
| M12 | `ordering` reports `by`, `exact`, `estimated`, and a note saying it is not consensus | same — "the ordering says what it is worth" |
| M13 | Median/low/high/count/volume are computed over exactly the kept trades | same — "the statistics over it" |
| M14 | An asset that never traded gives an empty series and a null summary, never zero | same — "an asset that never traded" |
| M15 | Candles bucket exactly and carry `every`; `fill` emits flat zero-volume buckets | same — "candles bucket exactly", "fill evens the axis" |
| M16 | `priceIndex` summarises every asset from one set of trades, and omits the quote | same — "priceIndex summarises every asset" |
| M17 | `classify` distinguishes live / reserved / stale / taken / cancelled; `settleable` is true for stale | same — "stale is open, past its expiry, and still settleable" |
| M18 | `verify` checks every field given and names both values; the same price on a different asset is caught | same — "verify" block |
| M19 | `reconcile` returns taken and cancelled as different sentences, reports `changed`, and `unknown` for a hash nobody knows | `kei/test/market-aggregation.test.ts` — "reconcile" block |
| M20 | An expired listing reconciles as `stale` and the ledger still settles it | same — "an expired listing is stale" |
| M21 | `accept({ expect })` refuses a repriced or item-swapped offer before anything is signed, and the balance does not move | same — "accept({ expect })" block |
| M22 | `series`/`candles`/`prices` read from the chain and agree with the pure functions | same — "series and candles, read from the chain" |

### `@keicoin/player-economy`

| # | Criterion | Where |
|---|---|---|
| P1 | The five balances are computed correctly, credits never fund a spend, raw is exact at 18 places | `player-economy/test/funds.test.ts` |
| P2 | `list` is one call; the goods leave the spendable balance because the ledger locked them | `kei/test/player-economy.test.ts` — "one call, and the goods are locked" |
| P3 | `each` and `price` mean different things; both or neither is refused with both spelled out | same — "`each` is per unit", "naming both, or neither" |
| P4 | Over-listing names what is locked in this wallet's own listings and points at `cancel` | same — "listing more than you hold" |
| P5 | An unknown ware is refused with the list of known ones | same — "a ware this world does not deal in" |
| P6 | Two stalls browse as two shelves, ordered by unit price, with complete coverage | same — "browse groups by seller" |
| P7 | `buy` moves both legs and both balances land | same — "one call moves the sword one way" |
| P8 | A listing whose displayed terms differ from the chain is refused and nothing moves | same — "a listing repriced between the read and the click" |
| P9 | Own listing, taken listing, cancelled listing, and reserved listing each give their own sentence | same — "buying" block |
| P10 | `{ verify: true }` on a bare hash is refused rather than silently doing nothing | same — "a bare hash with { verify: true }" |
| P11 | `cancel` returns the goods; somebody else's listing cannot be cancelled | same — "cancelling" block |
| P12 | `gift` moves an item, a token, or Kei in one call; two things at once is refused | same — "gifting" block |
| P13 | A pre-signing refusal writes no pending entry; a mid-flight failure emits `failed` with its own sentence and no debt | same — "pending and reconciliation" |
| P14 | `sync` collects arrivals, re-reads the stall, and reports departures once with a reason | same — "sync collects arrivals" |
| P15 | `incoming` is visible, not spendable, and included in `projected` | same — "incoming is real, owed, and not spendable" |
| P16 | An expired listing is hidden by default, shows as `stale` on request, and still settles | same — "stale and dead entries" |
| P17 | A seller nobody announced is invisible; one `watch` fixes it; coverage does not pretend | same — "partial discovery" |
| P18 | `list` announces this wallet so the next reader can see the stall | same — "listing announces this wallet" |
| P19 | An empty directory answers empty with `coverage.asked === 0`, not an error | same — "a shop with nobody in its directory" |
| P20 | History is ordered, summarised, and carries the sequence caveat; a never-sold ware draws nothing | same — "price history" |
| P21 | The game's own server cannot cancel a player's listing | same — "the boundaries this package keeps" |
| P22 | A listing priced in another currency is not this shop's to show | same |
| P23 | The whole flow works over HTTP between clients sharing only a URL | `kei/test/player-economy-over-http.test.ts` |
| P24 | A wrong directory hides a stall and cannot move an item | same — "a wrong directory hides a stall" |
| P25 | The sixty-second example runs to completion with no arguments and no network | `kei/test/player-shops-example.test.ts` |

---

## 7. Before and after

The two flows the brief names, measured against the code the applications
actually shipped.

### Listing an item for the world's currency

`world-of-wonder/src/client/Controllers/Wallet.ts`, `list()` — **31 lines**,
and the concepts a developer has to hold: catalogue lookup, integer validation
for two different fields, a refresh before reading, an inventory count, `give`/
`want` legs by asset id, an announce call, a second refresh, and a mapping back
into the app's own `Listing` shape with a failure path when the catalogue no
longer recognises what was just listed.

```js
await shop.list({ item: 'sword', qty: 2, each: 120 })
```

**1 line.** Catalogue lookup, quantity and price validation, the balance check
against *spendable* rather than confirmed, raw-integer multiplication, the offer
block, the announce, and the mapping back are all inside. Concepts: the item, how
many, what each one costs.

### Buying one

`world-of-wonder`, `accept()` — **22 lines**: a mine check, `market.get`, a state
check, a catalogue lookup, `offerMatchesDisplay` (itself 15 lines in a shared
file both halves import), `market.accept`, two announces, a refresh.

```js
await shop.buy(listing)
```

**1 line**, and it does strictly more: it also checks the spendable balance
first, verifies the seller and the reserved buyer as well as the item, price and
quantity, and tracks the spend as in-flight while it settles.

### The drawing of a book

`carpet-markets/server/registry.ts`, `book()` — four concurrent calls
(`offers` twice, `trades`, `price`), two sorts, a bespoke comparator, plus a
`traders` set, a summary cache, and a paragraph of comments about what the rows
do and do not represent.

```js
const book = await market.book({ from: directory, asset: sword })
```

**1 line**, one read per chain instead of two, and `book.coverage` says in data
what that paragraph said in prose.

---

## 8. Honest remaining gaps

Stated here rather than discovered.

1. **No cache, no single-flight, no poll.** §5.7. An application still writes
   these, and both existing ones will keep their own.
2. **`browse()` with no `item` costs one `account_swaps` per chain and filters
   locally.** There is no server-side filter for "offers wanting asset X"
   because `account_swaps` does not have one. A world with a large roster should
   pass `item` or bound the directory.
3. **A `Listing` carries its `Offer`, which is a chain read.** Verification is
   built from the *displayed* fields for exactly that reason, but an application
   that reads `listing.offer.want.amount` instead of `listing.price` has stepped
   outside the check. This is documented, not enforced.
4. **`Coverage.truncated` says a chain may have more; nothing pages it.** A
   seller with more than `limit` open listings has some hidden. Raising `limit`
   is the only lever today.
5. **`sync()`'s departure set lives in memory.** A reload loses it, and a
   listing that was taken while the tab was closed is simply absent from `mine()`
   rather than reported as gone. Persisting it would be an off-chain store, which
   §2 refuses; reconstructing it would need the chain walk §4.2 already bounds.
6. **Advisory time is still advisory.** §4.3. No amount of API design fixes
   this, and nothing here pretends to.
7. **`priceIndex` and `series` read `settledAt` from one node.** Two players
   looking at the same market can see the same trades in a different order. The
   numbers agree; the sequence may not.
8. **The mock ledger is the only chain this has run against.** M3's HTTP
   transport is exercised (`player-economy-over-http.test.ts`) but against the
   mock RPC handler unless `KEI_NODE_URL` is set. Nothing here has been run
   against the public testnet.
9. **`shop.buy` does not retry a lost race.** SPEC §9.2 conflict 4 says losing
   an accept/cancel race is normal; `@keicoin/economy` retries across a shelf of
   matching offers because a recipe defines what "matching" means. A shop has no
   such definition — the next listing is a different listing at a different price
   — so it reports the race and lets the caller choose.
