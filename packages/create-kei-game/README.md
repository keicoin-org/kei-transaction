# create-kei-game

Scaffolds a browser game with a real currency, a real item, and a wallet the
player owns.

```sh
npm create kei-game
```

It asks two things — what the project is called and what the currency is called
— and writes a working game: a 3D scene, a currency your server issues, an item
players buy for a fraction of a cent, and an in-memory Kei node to develop
against. Then it exits.

```sh
npm create kei-game star-clicker -- --currency "Gold Pieces"
bun create kei-game star-clicker --currency "Gold Pieces"
```

| Option | |
|---|---|
| `--currency <name>` | What the in-game currency is called. Default: `Coins` |
| `--yes`, `-y` | Take the defaults and ask nothing. For CI and agents. |
| `--force` | Write into a directory that already has files in it. |
| `--help`, `-h` | The above. |

## What you get

```
star-clicker/
├── src/economy.ts     every line of Kei in the browser
├── src/world.ts       the Babylon.js scene — knows nothing about Kei
├── src/main.ts        joins the two
├── server/game.ts     the whole backend: issues the currency, sells the item
├── server/main.ts     bun run dev — node, issuer, and client in one process
├── shared/game.ts     the price list
├── index.html
├── package.json
└── tsconfig.json
```

```sh
cd star-clicker
bun install
bun run dev
```

## Two prompts, and no more

Every question a scaffolder asks is a decision the developer has to make before
they have any information with which to make it. So this one asks about the
project and the currency, and decides the rest:

- **The renderer is Babylon.js**, and `src/world.ts` documents how to replace
  it. The SDK is framework-agnostic; the game does its own rendering.
- **The ticker is derived** from the currency name — `Gold Pieces` becomes
  `GOLD` — and printed before anything is written. It is one line in
  `shared/game.ts`.
- **It is single-player**, because a game that is only fun when someone else is
  online is the wrong thing to start from. The generated README explains adding
  Colyseus, and where the boundary is when you do.

## It is not a framework

The generated project does not import this package, does not depend on it, and
does not know it exists. Delete `create-kei-game` from your machine and the game
still builds and still runs — that is the test, and it has one.

It has a harder one too: `bun test` writes the project out, imports both halves,
and buys the item, so an SDK change that breaks the emitted code fails here
rather than in somebody's brand-new project.

This package installs nothing of its own, either. It is a program that writes
files, and the first thing you wait for is your game's dependencies.

---

Part of [`kei-transaction`](https://keicoin.org). SPEC §11.3.
