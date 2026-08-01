# @keicoin/work

Proof-of-work for Kei blocks: difficulty tiers, local generation, work-server client.

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

**M3 of eleven.** The public API now uses a real node at
`https://testnet.keicoin.org/rpc`; `MockNode` remains the hermetic reference
implementation. The testnet is one best-effort node with weak consensus and
**nothing there holds value.**

See the [full documentation](https://github.com/keicoin-org/kei-transaction/blob/master/README.md).

MIT.
