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

// Anyone: price history is transaction history, already there
await market.medianPrice(sword, { window: '7d' })
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

## Status

**M5 of eleven.** The API is real and runs end to end against the mock ledger,
which enforces the self-locking rule and the accept-vs-cancel race the same way
the real node will. See
[`docs/decisions-m5.md`](https://github.com/keicoin-org/kei-transaction/blob/master/docs/decisions-m5.md)
for the wire layout this package proposes and what the mock can and cannot
prove about the race.

There is no testnet yet and **nothing here holds value.**

See the [full documentation](https://github.com/keicoin-org/kei-transaction/blob/master/README.md).

MIT.
