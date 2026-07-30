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

A forged proof, a forged amount, or a second claim from the same account is rejected
by the ledger, not by the SDK. Roots are salted, so two identical batches are two
distinct drops.

## Status

**M1 of eleven.** The API is real and runs end to end, and the [Button demo](https://keicoin.org) is
playable against it. The chain underneath is still a mock — served over HTTP, so the
SDK already talks to a node across a URL, and M3 changes what is behind that URL
without the API moving.

There is no testnet yet and **nothing here holds value.**

See the [full documentation](https://github.com/keicoin-org/kei-transaction/blob/master/README.md).

MIT.
