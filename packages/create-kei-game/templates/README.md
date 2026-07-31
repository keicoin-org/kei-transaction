# __PROJECT_TITLE__

A crystal on a plinth. Click it to earn __CURRENCY_NAME__, and buy a lantern
that doubles what a click is worth. Every coin and the lantern itself are on a
chain, in a wallet the player owns.

```sh
bun install
bun run dev          # http://localhost:7777
```

> The chain underneath is an in-memory mock, served by the same process. It dies
> when you stop the server, and nothing on it is worth anything. That is the
> right way to build: the API you are writing against is the one a real node
> serves, so swapping this for a real node later changes a URL and nothing else.

This project is yours. Nothing in it depends on the tool that generated it —
delete `create-kei-game` from your machine and everything here still builds and
still runs.

## What is where

| File | What it is |
|---|---|
| `src/economy.ts` | Every line of Kei in the browser. Start here. |
| `src/world.ts` | The Babylon.js scene. Knows nothing about Kei. |
| `src/main.ts` | Joins the two. Decides what a click means. |
| `server/game.ts` | The whole backend. Issues the currency, sells the lantern. |
| `server/main.ts` | `bun run dev`: the node, the issuer, and the client, one process. |
| `shared/game.ts` | The price list. What things cost, what a click pays. |

## The part worth understanding

**There is no database.** No `players` table, no `balances` table, no
`inventory` table, and no save file. The server has no persistent storage of any
kind. Stop it, start it, and a player's coins and lantern are still theirs,
because they were never the server's to hold.

**The browser holds a key and signs its own transactions.** There is no session
and no login. The game server never sees a player's key and cannot move their
money — which also means it cannot lose it.

**A purchase is two signed halves.** The player signs the payment; your server
signs the delivery. There is no `charge(player, …)` in this SDK and there never
will be: a game cannot sign for a wallet it does not have the key to.

**Clicks are paid by a commit, not a mint.** One block from your issuer
underwrites a claim that each player writes from their own account, in parallel.
With one player that is a batch of one and the code is identical — which is the
point, because nothing has to be rewritten when there are a thousand.

## Making it yours

**Rename the currency.** `shared/game.ts`, top of the file. The ticker is what
the chain knows it by and it is fixed once issued, so change it before you have
players. Restarting with a new ticker issues a new currency; the old one still
exists.

**Change what things cost.** Also `shared/game.ts`. Prices are your business,
not the chain's — that file is the only place they live.

**Sell something else.** `server/game.ts` creates one item with
`kei.items.create()` and mints it on payment. Add a second the same way. Items
are supply-limited native tokens: they show up in any Kei wallet, and a player
can hold or trade them whether or not this game is running.

**Charge in your own currency instead of Kei.** The lantern is bought with Kei,
because a fraction of a cent is the demo. To charge in __CURRENCY_SYMBOL__
instead, take a token transfer rather than a payment — token transfers carry no
memo, so record the order first and match it to the arrival.

**Replace the renderer.** `src/world.ts` is Babylon.js and nothing else, and the
SDK is not tied to it. Swap in Three.js, PlayCanvas, or a flat 2D canvas: keep
the `World` interface at the top of the file and the other two files do not
change.

## Adding multiplayer

This is single-player on purpose, and it should stay fun that way — most of the
time nobody else will be online. When you do want other people in the world,
add [Colyseus](https://colyseus.io):

```sh
bun add colyseus @colyseus/core
```

Run a room alongside the server in `server/main.ts`, and let it own presence and
position — where players are, what they are doing, who is in the room.

**Do not let it own money.** Balances live on the chain, and the game server
must never be the source of truth for them. The one thing multiplayer genuinely
improves here is trust: right now the browser counts its own clicks and the
server caps the rate, because in single-player nothing else can see them. A room
that observes clicks closes that hole.

## When there is a testnet

Everything above runs against a mock node. When there is a public testnet, point
at it and delete the mock:

```ts
// server/main.ts
const game = await startGame({ seed: process.env.GAME_SEED!, node: 'https://…', network: 'testnet' })
```

```ts
// src/economy.ts
const kei = await Kei.start({ node: 'https://…', network: 'testnet' })
```

Nothing else changes. That is the whole point of building against the mock.

## Shipping it

Testnet is where you build and the wrong place to finish. Its Kei is worth
nothing and that chain can be reset without notice, so a game that reaches real
players on testnet has an economy with an expiry date nobody chose.

`Kei.server()` knows the difference. On a host that looks like a deployment —
`NODE_ENV=production`, or a platform variable like `FLY_APP_NAME` — it refuses
to start against testnet and tells you to move to mainnet:

```ts
const game = await startGame({ seed: process.env.GAME_SEED!, node: 'https://…', network: 'mainnet' })
```

Kei mainnet is not open yet, so today that refusal means *not yet*: keep the game
in front of testers who know the money is play money. It opens when enough
independent validators run the chain for value to be safe on it.

Running a public testnet demo on purpose is a real thing to want. Set
`KEI_ALLOW_TESTNET=1` where you deploy — in the deploy's environment rather than
in this repository, so the decision is made where the deploy is.

---

Made with [`create-kei-game`](https://keicoin.org). The SDK is
[`kei-transaction`](https://keicoin.org).
