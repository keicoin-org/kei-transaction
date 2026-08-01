# @keicoin/work

Proof-of-work for Kei blocks: difficulty tiers, local generation, work-server client.

Run the server beside a node:

```sh
KEI_NODE_URL=http://127.0.0.1:7076 PORT=7077 kei-work-server
```

Set `WORK_SERVER_TOKEN` to require `Authorization: Bearer …`. Clients point
`workServer` at the printed URL; requests use the same `work_generate` JSON API
in local, test, and production deployments.

> Part of [`kei-transaction`](https://www.npmjs.com/package/kei-transaction) — real currencies and items
> for browser games. **Install `kei-transaction` instead unless you are counting
> bytes**; these sub-packages exist for bundle size, not as a puzzle you have to
> solve.

```sh
bun add @keicoin/work     # or npm / pnpm / yarn
```

## What is in here

Anti-spam without fees. Difficulty is tiered by how attractive an operation is to
abuse:

| Tier | Operations |
|---|---|
| **A** (highest) | `issue`, `mint`, `commit`, `commit_close` |
| **B** (standard) | `send`, `transfer`, swap legs |
| **C** (cheap) | `receive`, `claim`, `burn` |

`claim` is deliberately cheap: a thousand players claiming at once must not produce
a visible pause.

## Status

**M4 of eleven.** Native items, rooted claims, and the work server run end to end, and the [Button demo](https://keicoin.org) is
playable against it. The chain underneath is still a mock — served over HTTP, so the
SDK already talks to a node across a URL, and M3 changes what is behind that URL
without the API moving.

There is no testnet yet and **nothing here holds value.**

See the [full documentation](https://github.com/keicoin-org/kei-transaction/blob/master/README.md).

MIT.
