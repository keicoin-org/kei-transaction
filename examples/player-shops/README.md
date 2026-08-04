# Player shops, end to end

```sh
bun examples/player-shops/bazaar.js
```

No network, no keys, no setup: it runs against `Kei.mock()`, an in-process chain
that enforces the real ledger rules. To point it at the public testnet, change
one line — the node.

## The sixty seconds

Everything a world needs to embed player-owned shops, minus the setup:

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
await kei.shop.cancel(listing)                                 // take it back
```

## What is in here

| | |
|---|---|
| [`bazaar.js`](bazaar.js) | Two players, two stalls, one purchase, one gift, and the two honest limits. |

The example walks a market day:

1. **Two stalls.** Alice lists two swords at 120 gold each; Bob lists four
   potions. Listing writes one `swap_offer` block per stall and the ledger locks
   the goods — Alice's remaining sword count drops immediately, and it is the
   chain that dropped it, not a database.
2. **A browse.** Bob reads both stalls out of the accounts the directory names,
   grouped by seller and ordered by unit price, with a `coverage` report saying
   how many chains answered.
3. **A purchase.** One `swap_accept` moves the swords one way and the gold the
   other, or neither moves (SPEC §9.2). The terms are re-read off the chain and
   checked field by field against the row that was on screen, immediately before
   signing.
4. **A gift.** One call, no offer, no accept, no price.
5. **A cancel.** Only the author can, because only their asset is locked.
6. **Price history.** What swords actually sold for, read from the chain, with
   the ordering caveat printed rather than buried.
7. **The two limits, on purpose.** A seller nobody has announced is invisible
   until somebody announces them — that is SPEC §9.4 showing through, not a bug —
   and the game's own server is refused when it tries to cancel a player's
   listing, because it has no key for that account and there is no API that
   pretends otherwise.

## What it is not

There is no shop server, no listings table, no escrow account, and no moment
where anything holds somebody else's money. The directory is the entire backend,
it is a list of addresses, and nothing read through it is trusted: a wrong
directory can hide a stall and cannot move an item. The last section of the
example demonstrates exactly that.

It is also not a template — `npm create kei-game` is, and it lives in
[`create-kei-game`](https://github.com/keicoin-org/create-kei-game). This is a
single file you can read in one sitting and copy lines out of.

The issuer's half of an economy — rewards, sinks, and shops the *game* stocks —
is [`examples/economy`](../economy) and `@keicoin/economy`. The two are
counterparts and neither replaces the other.
