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

**M3 of eleven.** The public API now uses a real node at
`https://rpc.testnet.keicoin.org/rpc`; `MockNode` remains the hermetic reference
implementation. The testnet is one best-effort node with weak consensus and
**nothing there holds value.**

See the [full documentation](https://github.com/keicoin-org/kei-transaction/blob/master/README.md).

MIT.
