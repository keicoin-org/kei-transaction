# @keicoin/claims

Merkle-rooted claims: root building, proofs, and player-signed claim blocks.

> Part of [`kei-transaction`](https://www.npmjs.com/package/kei-transaction) — real currencies and items
> for browser games. **Install `kei-transaction` instead unless you are counting
> bytes**; these sub-packages exist for bundle size, not as a puzzle you have to
> solve.

```sh
bun add @keicoin/claims     # or npm / pnpm / yarn
```

## What is in here

A thousand loot drops in one block. Minting per drop makes the issuer's account a
global write lock, so the issuer publishes **one root** and each player writes their
own claim from their own chain, in parallel.

```js
const drop = await gems.commit([
  { to: playerA, amount: 500 },
  { to: playerB, amount: 120 },
  // ...thousands more
])
send(playerA, drop.proofFor(playerA))   // plain JSON

await kei.claims.add(bundle)            // player side
```

The default claim store is memory-only, matching earlier releases. To make a
browser wallet recover the proof after recreation, inject the provided adapter:

```js
import { Kei, createBrowserClaimStore } from 'kei-transaction'

const kei = await Kei.start({
  claimStore: createBrowserClaimStore(localStorage),
})

const status = await kei.claims.storageStatus()
status.durability       // 'persistent' after opting into this adapter
status.diagnostics      // typed, bounded remediation records; never secrets
```

Records are namespaced by network, wallet address, and root. A validated write
is read back before automatic claiming, successful/already-claimed/closed roots
are removed durably, and startup retries retained claims. The finite public
limits are 128 records per wallet/network, 16,384 serialised bytes per record,
and 128 sibling hashes per proof. Unsupported versions and malformed or
over-budget records are diagnosed and never signed.

Bundles reveal award metadata even though they contain no seed, key, or server
credential. Browser storage is recovery, not a backup; inject a store whose
privacy and durability fit the application. A Node process can implement the
same small `ClaimStore` interface without making the game or issuer a custodian.

A forged proof, a forged amount, or a second claim from the same account is rejected
by the ledger, not by the SDK. Roots are salted, so two identical batches are two
distinct drops.

The salt is a leaf like any other, and `drop.saltProof` is its path to the root.
Nothing claims against it — a salt is not an entitlement — but it is space in the
tree the root already commits to, and a caller that puts something meaningful in
the salt can prove it is there afterwards. `@keicoin/economy` uses exactly that to
bind a loot table's digest to the batch published for it. For a random salt the
path proves only that the salt is this root's, which is true and uninteresting.

## Status

**M3 of eleven.** The public API now uses a real node at
`https://testnet.keicoin.org/rpc`; `MockNode` remains the hermetic reference
implementation. The testnet is one best-effort node with weak consensus and
**nothing there holds value.**

See the [full documentation](https://github.com/keicoin-org/kei-transaction/blob/master/README.md).
The storage design and failure ordering are recorded in
[`docs/decisions-claims-durability.md`](../../docs/decisions-claims-durability.md).

MIT.
