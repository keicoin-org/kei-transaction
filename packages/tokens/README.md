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

An item is a token with supply 1, and it can carry stats:

```js
const sword = await game.items.create({ name: 'Iron Sword', stats: { attack: 10, weight: 3 } })

// With stats, the player is minted a variant of the sword rather than the sword.
const drop = await game.items.mint(sword.id, playerAddress, {
  label: 'Flaming', stats: { attack: 17, element: 'fire' },
})
drop.stats   // { attack: 17, weight: 3, element: 'fire' }
```

Stats are flat, on-chain, and part of the item's id, so the same roll always
derives the same asset — the hundredth Flaming Sword costs no extra issuance
burn. A bounded table of rolls is cheap; a random roll per drop is not.

`transfer` is immutable and protocol-enforced: it is the only real mechanism for a
closed economy. Issuing burns n Kei for an account's nth asset — 1 for its first —
because an asset record is permanent state on every node forever, and because the
cost has to land on a large catalogue rather than on a first token. Transactions
stay free.

## Status

**M3 of eleven.** The public API now uses a real node at
`https://testnet.keicoin.org/rpc`; `MockNode` remains the hermetic reference
implementation. The testnet is one best-effort node with weak consensus and
**nothing there holds value.**

See the [full documentation](https://github.com/keicoin-org/kei-transaction/blob/master/README.md).

MIT.
