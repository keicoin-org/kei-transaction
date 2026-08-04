# @keicoin/market

Offers, atomic settlement, and price history — read straight off account chains.
No listing table, no matching engine, no server.

> Part of [`kei-transaction`](https://www.npmjs.com/package/kei-transaction) — real currencies and items
> for browser games. **Install `kei-transaction` instead unless you are counting
> bytes**; these sub-packages exist for bundle size, not as a puzzle you have to
> solve.

```sh
bun add @keicoin/market     # or npm / pnpm / yarn
```

## What is in here

An offer *is* a `swap_offer` block (SPEC §9.3): `sell()` locks the seller's own
asset, `accept()` writes one block that moves both legs or neither, and
`cancel()` writes the block that gives it back.

```js
// Seller: locks the item, asks 5 Kei
const offer = await market.sell({ asset: sword, price: 5 })

// Buyer: one block moves both legs, or neither
await market.accept(offer)

// Anyone: price history is transaction history, with read coverage attached
const price = await market.price(sword, { window: '7d' })
price?.median
price?.coverage
```

Only the offerer ever locks anything, and it is their own asset — the same
sword cannot be listed twice, because after the first offer it is not in the
seller's spendable balance to offer again. Accept and cancel race for that one
locked entry, and either can win; a lost race is a normal outcome, not a bug.

`expiresAt` is advisory only, because the chain has no clock: an expired offer
still settles if somebody accepts it, and what actually clears it off the
ledger is the offerer's own cancel — which this package writes in the
background by default.

`offers({ from })` and `trades({ from })` read a bounded walk of the accounts
you name. There is no network-wide listing index (SPEC §9.4): Kei moves and
records assets, and does not run a matching engine.

## The headless pieces above that

Everything below reads chains and does arithmetic. None of it holds a balance,
caches anything, or depends on a framework.

### A directory: which chains to read

An offer lives on its author's chain, so somebody has to remember which accounts
are worth asking. That is a list of addresses, and it is bounded because `watch`
is usually reachable from an unauthenticated route.

```js
const directory = createDirectory({ limit: 128 })   // LRU; evictions are counted
directory.watch(playerAddress)

// Or implement the interface over your own player table. It is one method:
const remote = { accounts: () => fetch('/players').then(r => r.json()) }
```

Anywhere a `from` is taken, an address, a list, or a directory all work. **Nothing
read through one is trusted** — every offer it leads to is re-read from the chain
before anything is signed.

### A book, and an honest account of what it could not see

```js
const book = await market.book({ from: directory, asset: sword })
book.asks[0].unitPrice  // quote units per sword; cheapest ask first
book.bids[0].unitPrice  // the same units; highest bid first
book.asks[0].side       // 'ask'; each level also names `base` and `quote`
book.spread             // bestAsk.unitPrice - bestBid.unitPrice
book.coverage    // { asked, read, failed, truncated, dropped, skipped, complete }
```

One `account_swaps` per chain, not two: the asks and the bids are a local
partition of one read. A chain whose read fails is a **gap** — the book returns
what it has and names what it lost, because a page that blanks on one timeout
reads as "the market closed".

Book rows are `BookLevel`s: oriented offers whose `base`, `quote`, `side`, and
`unitPrice` make the units explicit. Raw values returned by `get()`, `offers()`,
`mine()`, and `trades()` remain bare directional offers: their compatible
`price` is always `want.amount / give.amount`, because those reads do not choose
a book orientation. In a whole-shelf book, each row uses the non-quote asset as
its base, so these fields keep the same meaning across every stall.

`coverage` is the part worth using. A book over a roster is a *floor*, never a
census, and `complete: false` says which of the four reasons applies. Leave
`asset` out for the whole shelf against one currency.

### Bounded, cancellable reads

Every API that walks account chains accepts the same controls:

```js
const controller = new AbortController()
const trades = await market.trades({
  from: directory,
  concurrency: 8,
  signal: controller.signal,
})

trades.coverage  // the same asked/read/failed/truncated contract as a book
controller.abort()
```

The default is eight concurrent chains and can be set as the per-call default
with `createMarket(client, { concurrency })` or overridden on a call. The bound
is per walk: overlapping reads each have their own allowance, so abort or
serialise polls when you need one aggregate request budget. Values must be whole
numbers from 1 through 32. Results keep request order even when responses arrive
out of order. Aborting rejects with the typed `read-aborted` market error, stops
new chain reads from starting, and does not claim to cancel a node request
already in flight.

Each walk reads at most `limit` rows from each account, 100 by default. A limit
must be a positive safe whole number; an invalid value rejects with
`bad-limit` before the node read starts. That validation prevents coercion and
unbounded numeric values, but it is not a small resource ceiling: callers can
still choose a large valid page. Keep it at or below the node's documented cap
and at a size the client can afford.

`offers()`, `mine()` and `trades()` remain arrays; their non-enumerable
`coverage` property does not change iteration or JSON output. Array transforms
such as `.map()` return a new plain array, so read coverage before transforming
or use `coverageOf(rows)`. Series, candles, price summaries and price indexes
carry the same provenance so a chart cannot silently present a partial walk as
a complete market.

`mergeCoverage()` is only for multiple reads over the same logical,
deduplicated account scope. It validates every part at runtime before reading
it, including values supplied by JavaScript or deserialised data. Counts must be
non-negative safe integers, every unread account must have one unique failure
entry, arrays must have their documented shapes, and `complete: true` may not
contradict any gap. Invalid values and unequal `asked` counts reject with the
typed `coverage-mismatch` error rather than producing partial arithmetic.
Coverage intentionally stores counts instead of the account roster, so
equal-sized parts from different rosters must still be kept separate by the
caller.

`medianPrice()` remains as a scalar compatibility shortcut. Because a number
cannot carry provenance, use `price()` whenever the difference between a
complete and partial roster affects the decision being made.

Catch stable refusal codes without parsing player-facing prose:

```js
try {
  await market.accept(offer)
} catch (error) {
  if (isMarketError(error, 'offer-taken', 'offer-cancelled')) showNextListing()
  else throw error
}
```

### Price history a chart can draw

```js
const series  = await market.series({ asset: sword, from: directory })
const candles = await market.candles({ asset: sword, from: directory, every: '1h' })
const prices  = await market.prices({ from: directory })   // every asset, one walk
```

**Read this before shipping a chart.** The prices, units, medians, ranges and
volumes are consensus — every node computes the same ones. The *order* is not:
the block-lattice has no clock (SPEC §5.5), so `settledAt` is the node's own
first-seen time, two nodes will disagree, and a restarted node forgets. The
series says so in the value rather than in a comment:

```js
series.ordering   // { by: 'advisory-time', exact: false, estimated: 2, note: '…not consensus…' }
```

A candle's OHLC is exact for the trades in its bucket; *which* trades are in it is
advisory.

### Lifecycle, reconciliation, and not trusting an index

```js
market.lifeOf(offer)          // 'live' | 'reserved' | 'stale' | 'taken' | 'cancelled'
await market.reconcile(shown) // what became of a snapshot: live, stale, gone, changed, unknown
```

`stale` is open, past its advisory expiry, and **still settleable** — hiding it is
your choice, and the background cancel is what actually removes it. `taken` and
`cancelled` stay separate because they are different sentences to a player.

If a background sweep cannot read the node, it retries after 30,000 ms. The
`sweepInterval` option can change that cadence to a whole number of milliseconds
from 1 through 2,147,483,647. Invalid, fractional, or timer-overflow values throw
`KeiError('bad-sweep-interval')` when the market is created, before a sweep or
network read can start; omit the option to keep the 30-second default.

Before signing, check the chain against what you rendered:

```js
await market.accept(offer, {
  expect: { hash, seller, give: { asset: sword.id, amount: 1 }, want: { asset: KEI_ASSET, amount: 5 } },
})
```

Matching the price and quantity alone is **not enough**: an index could attach
the hash of a different item at the same price. Every field you give is checked,
against the chain's copy, immediately before the block is signed.

Player-facing shops built on all of this are
[`@keicoin/player-economy`](https://www.npmjs.com/package/@keicoin/player-economy).

## Status

**M5 of eleven.** The API is real and runs end to end against the mock ledger,
which enforces the self-locking rule and the accept-vs-cancel race the same way
the real node will. See
[`docs/decisions-m5.md`](https://github.com/keicoin-org/kei-transaction/blob/master/docs/decisions-m5.md)
for the wire layout this package proposes and what the mock can and cannot
prove about the race, and
[`docs/decisions-player-economy.md`](https://github.com/keicoin-org/kei-transaction/blob/master/docs/decisions-player-economy.md)
for why the aggregation layer above exists, what it refuses, and the gaps it
still has.

There is no testnet yet and **nothing here holds value.**

See the [full documentation](https://github.com/keicoin-org/kei-transaction/blob/master/README.md).

MIT.
