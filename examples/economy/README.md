# A game economy, end to end

```sh
bun examples/economy/shop.js
```

No network, no keys, no setup: it runs against `Kei.mock()`, an in-process
chain that enforces the real ledger rules. To point it at the public testnet,
change one line — the node — and give the server a seed from the environment.

## What is in here

| | |
|---|---|
| [`recipes.js`](recipes.js) | The shared file. Imported by both halves, frozen, and it reads no chain. |
| [`shop.js`](shop.js) | The two halves: `server()` holds the game's seed, `browser()` holds the player's. |

The example walks a single day of a small economy:

1. **A reward.** The game mints 50 gold to a player. Only the issuer can, and
   the browser's attempt is refused with a sentence naming the half that can.
2. **A sink.** The player burns 20 gold — their own block, their own signature,
   no issuer round trip — and the circulating supply actually falls.
3. **An empty shop.** The plan is not `ok`, and the problem names
   `economy.stock()` and whose job it is.
4. **Stocking it.** Three swords, three offer blocks on the issuer's chain.
5. **A craft.** Thirty scrap and one sword move in the *same* block, or neither
   moves (SPEC §9.2). The shelf goes from three to two.
6. **A gate.** A soulbound guild sigil the player does not hold blocks a recipe,
   is granted, and then does not.

Every number printed at the end comes from `kei.wallet.summary()`, which reads
the ledger. Nothing in the example stores a balance, an order, or a pending
anything.

## What it is not

It is not a template — `npm create kei-game` is, and it lives in
[`create-kei-game`](https://github.com/keicoin-org/create-kei-game). This is a
single file you can read in one sitting and copy lines out of.
