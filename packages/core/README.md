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

**M3 of eleven.** The public API now uses a real node at
`https://testnet.keicoin.org/rpc`; `MockNode` remains the hermetic reference
implementation. The testnet is one best-effort node with weak consensus and
**nothing there holds value.**

See the [full documentation](https://github.com/keicoin-org/kei-transaction/blob/master/README.md).

MIT.
