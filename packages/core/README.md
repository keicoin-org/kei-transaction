# @keicoin/core

Wallet, amounts, addresses, blocks, node clients, and the in-memory mock node.

> Part of [`kei-transaction`](https://www.npmjs.com/package/kei-transaction) — real currencies and items
> for browser games. **Install `kei-transaction` instead unless you are counting
> bytes**; these sub-packages exist for bundle size, not as a puzzle you have to
> solve.

```sh
bun add @keicoin/core     # or npm / pnpm / yarn
```

## What is in here

| | |
|---|---|
| `Wallet` | seed handling, key derivation, signing |
| `HttpNode` | the RPC client every other package talks through |
| `MockNode` / `mockRpcHandler` | a ledger enforcing the real rules, in process or over HTTP |
| amounts, addresses, hashing, Merkle | the primitives, with `kei_` encoding unchanged from Nano/Banano |

`@keicoin/core` depends on nothing else in the tree.

## Status

**M1 of eleven.** The API is real and runs end to end, and the [Button demo](https://keicoin.org) is
playable against it. The chain underneath is still a mock — served over HTTP, so the
SDK already talks to a node across a URL, and M3 changes what is behind that URL
without the API moving.

There is no testnet yet and **nothing here holds value.**

See the [full documentation](https://github.com/keicoin-org/kei-transaction/blob/master/README.md).

MIT.
