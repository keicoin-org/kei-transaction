# @keicoin/tokens

Native tokens and items: issue, mint, burn, transfer, `balanceOf`, policy flags, commits.

> Part of [`kei-transaction`](https://www.npmjs.com/package/kei-transaction) — real currencies and items
> for browser games. **Install `kei-transaction` instead unless you are counting
> bytes**; these sub-packages exist for bundle size, not as a puzzle you have to
> solve.

```sh
bun add @keicoin/tokens     # or npm / pnpm / yarn
```

## What is in here

A currency in one call, and an item that is just a token with supply 1:

```js
const gems = await game.token.issue({
  name: 'Gems', symbol: 'GEM', decimals: 0, maxSupply: 1_000_000,
  transfer: 'open',   // 'open' | 'issuer-only' | 'none' — enforced by the chain
  swap: 'one-way',
})

await gems.mint(playerAddress, 500)
await gems.balanceOf(playerAddress)   // 500 — one call
```

`transfer` is immutable and protocol-enforced: it is the only real mechanism for a
closed economy. Issuing burns 1,000 Kei, because an asset record is permanent state
on every node forever — transactions stay free.

## Status

**M1 of eleven.** The API is real and runs end to end, and the [Button demo](https://keicoin.org) is
playable against it. The chain underneath is still a mock — served over HTTP, so the
SDK already talks to a node across a URL, and M3 changes what is behind that URL
without the API moving.

There is no testnet yet and **nothing here holds value.**

See the [full documentation](https://github.com/keicoin-org/kei-transaction/blob/master/README.md).

MIT.
