# @keicoin/wallet

In-game wallet: headless balance, inventory and claim summaries.

> Part of [`kei-transaction`](https://www.npmjs.com/package/kei-transaction) — real currencies and items
> for browser games. **Install `kei-transaction` instead unless you are counting
> bytes**; these sub-packages exist for bundle size, not as a puzzle you have to
> solve.

```sh
bun add @keicoin/wallet     # or npm / pnpm / yarn
```

## What is in here

```js
await kei.wallet.summary()      // { address, kei, tokens, items, pending }
kei.wallet.on('change', s => {})
```

The seed lives in browser storage and is never transmitted anywhere. Whether a player
can see it is declared at setup via `reveal: 'on-request' | 'never' | 'always'`.

Hiding the seed in the UI is not a security control — it defends against screenshots
and shoulder-surfing, not against an attacker, because any XSS on your page reads
browser storage whatever the UI does.

**The mountable `WalletPanel` lands at M6.** This package is headless today.

## Status

**M1 of eleven.** The API is real and runs end to end, and the [Button demo](https://keicoin.org) is
playable against it. The chain underneath is still a mock — served over HTTP, so the
SDK already talks to a node across a URL, and M3 changes what is behind that URL
without the API moving.

There is no testnet yet and **nothing here holds value.**

See the [full documentation](https://github.com/keicoin-org/kei-transaction/blob/master/README.md).

MIT.
