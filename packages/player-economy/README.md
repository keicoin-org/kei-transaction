# @keicoin/player-economy

Shops that belong to the players, not the game. Listing, buying, cancelling and
gifting through the player's own wallet, with no server in the middle and
nothing holding anybody's money.

> Part of [`kei-transaction`](https://www.npmjs.com/package/kei-transaction) — real currencies and items
> for browser games. **Install `kei-transaction` instead unless you are counting
> bytes**; these sub-packages exist for bundle size, not as a puzzle you have to
> solve.

```sh
bun add @keicoin/player-economy     # or npm / pnpm / yarn
```

## Sixty seconds

```js
import { Kei } from 'kei-transaction'

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

There is a runnable version in
[`examples/player-shops`](https://github.com/keicoin-org/kei-transaction/tree/master/examples/player-shops).

## What it is

`@keicoin/economy` is the issuer's half of an economy: recipes the game
declares, stocked from the game's own account. This is the player's half, and
the difference is who signs.

|  | `@keicoin/economy` | `@keicoin/player-economy` |
|---|---|---|
| Whose account | the issuer's | the player's |
| Where stock comes from | `stock()`, which will mint it | never mints — you list what you hold |
| Who sets the price | the recipe both halves import | the seller, per listing |
| Runs in | server, for stocking | the browser |

**Nothing here is custodial and nothing is stored.** A stall is a set of
`swap_offer` blocks on one player's own chain; a sale is one `swap_accept` that
moves both legs or neither (SPEC §9.2). The world it is embedded in cannot list,
cancel, buy, or gift for anybody, because it has no key for their account — and
there is no API that pretends otherwise.

## The directory is the whole backend

An offer lives on its author's chain and Kei ships no indexer (SPEC §9.4), so
something has to remember which chains are worth reading. That is a list of
addresses:

```js
import { createDirectory } from 'kei-transaction'

const directory = createDirectory()      // bounded LRU, default 128
directory.watch(playerAddress)           // a `watch` route, or your player table
```

Or implement the interface over whatever you already have — it is one method:

```js
const directory = { accounts: () => fetch('/players').then(r => r.json()) }
```

A wrong directory can **hide a stall**. It cannot move an item: every listing is
re-read from the chain and checked field by field against the row you rendered
before anything is signed.

```js
const shelves = await kei.shop.browse()
shelves.coverage   // { asked, read, failed, truncated, dropped, skipped, complete }
```

A shop over a roster is a floor, never a census, and `coverage` is how a view
says so instead of implying nobody is selling.

## `each` is not `price`

```js
await shop.list({ item: 'sword', qty: 10, each: 12 })   // 120 for the lot
await shop.list({ item: 'sword', qty: 10, price: 12 })  // 12 for the lot
```

Exactly one, and naming both or neither is refused with both meanings spelled
out. The multiplication happens in raw integers, so a currency with real decimal
places is not listed at a rounded price.

## Three balances, not one

```js
const funds = await shop.funds()
funds.confirmed   // what the chain says is spendable
funds.incoming    // owed to you and not yet signed for (SPEC §5.6.3)
funds.committed   // signed a moment ago and not yet read back
funds.spendable   // confirmed - committed. The only one a spend is checked against
funds.projected   // what it becomes if everything lands
```

Showing only `confirmed` makes a shop look stuck for a second after every
action. Adding the others in makes it offer money the ledger will refuse. Each
comes with its raw integer beside it, because a JS number cannot hold eighteen
decimal places and a balance comparison must not round.

```js
await shop.sync()      // collect arrivals, re-read your stall, report what left
shop.pending()         // what this wallet has signed and not read back
shop.on('change', ({ pending }) => redraw())
```

`sync()` reports a departure **once**, with a sentence saying whether somebody
bought it or the seller took it back — those are different facts to a player.

## Price history

```js
const series  = await shop.history({ item: 'sword' })
const candles = await shop.candles({ item: 'sword', every: '1h' })
```

The prices and every statistic over them are consensus. The **order** is not:
the block-lattice has no clock (SPEC §5.5), so the sequence is the node's own
first-seen time and `series.ordering` says exactly that rather than leaving you
to find out. See
[`@keicoin/market`](https://www.npmjs.com/package/@keicoin/market) for the full
contract.

## Status

**Built on M5's market, against the mock ledger and over M3's HTTP transport.**
The design record — what this refuses, what it costs, and what it still cannot
do — is
[`docs/decisions-player-economy.md`](https://github.com/keicoin-org/kei-transaction/blob/master/docs/decisions-player-economy.md).

There is no mainnet and **nothing here holds value.**

See the [full documentation](https://github.com/keicoin-org/kei-transaction/blob/master/README.md).

MIT.
