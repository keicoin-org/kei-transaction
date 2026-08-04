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

## Atomic mock-ledger rejections

`MockLedger.process()` validates a complete transition before committing it.
When a block is rejected, account state, receivables, asset supply and holdings,
claim status, indexes, and notifications all remain unchanged, so a corrected
same-instance retry observes the same authority as a fresh process would.

## Bounded node requests

`HttpNode` bounds the complete request, including reading the response body, to
30 seconds by default. A custom positive finite timeout is explicit:

```js
import { HttpNode } from '@keicoin/core'

const node = new HttpNode({
  url: 'https://testnet.keicoin.org/rpc',
  requestTimeout: 15_000,
})
```

A deadline fails with `KeiError` code `node-timeout`; invalid timeout options
fail with `bad-request-timeout`. Receivable polling keeps one request in flight,
backs off after failures, and cancellation stops its active request. Errors name
the node without repeating URL credentials, query strings, fragments, or opaque
credential-like path segments.

## Status

**M3 of eleven.** The public API now uses a real node at
`https://testnet.keicoin.org/rpc`; `MockNode` remains the hermetic reference
implementation. The testnet is one best-effort node with weak consensus and
**nothing there holds value.**

See the [full documentation](https://github.com/keicoin-org/kei-transaction/blob/master/README.md).

MIT.
