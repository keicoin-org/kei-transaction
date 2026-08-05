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

## Checking that a client controls the address it claims

The server half of `kei.wallet.signOwnershipChallenge()`. It needs the address
and no key, so a game server that holds no Kei wallet can still import it.

```js
import { createNonceStore, randomChallengeNonce, verifyOwnershipProof } from '@keicoin/core'

const nonces = createNonceStore()             // one use per nonce

const challenge = {
  domain: 'example.com/my-game/session/v1',   // your namespace, versioned
  address: claimedAddress,
  nonce: randomChallengeNonce(),
  context: { roomId, sessionId },             // bounded, and all of it signed
}

// ...send the challenge, receive { address, signature, challenge } back...

const ok = await verifyOwnershipProof(proof, { ...challenge, nonces })
```

It returns `false` for anything a client could have got wrong — bad signature,
another challenge, an unknown field, a replayed nonce — and never puts the proof
in an error. It throws only when your own expectation is malformed, which is
your bug rather than theirs.

A challenge is signed under a fixed `kei-ownership-challenge-v1` domain followed
by canonical JSON, where a block is hashed under `blake2b-256("kei-block-v1")`
or `kei-block-local-v0`. So a proof is not a transaction and a transaction is
not a proof, and your own `domain` is inside the signed JSON rather than in
front of it, where no value you choose could move those leading bytes. Replay is
the nonce's job: one per challenge, retired on the first success.
`createNonceStore` is bounded and per process; a fleet wants one shared store
implementing `NonceStore`.

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
