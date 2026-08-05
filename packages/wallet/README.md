# @keicoin/wallet

In-game wallet: a mountable balance/inventory/claims panel, plus the headless
summary API underneath it.

> Part of [`kei-transaction`](https://www.npmjs.com/package/kei-transaction) — real currencies and items
> for browser games. **Install `kei-transaction` instead unless you are counting
> bytes**; these sub-packages exist for bundle size, not as a puzzle you have to
> solve.

```sh
bun add @keicoin/wallet     # or npm / pnpm / yarn
```

## The mountable panel (M6)

```js
import { WalletPanel } from '@keicoin/wallet'

const handle = WalletPanel.mount('#wallet', {
  kei,
  show: ['balance', 'tokens', 'items', 'claims'],  // default is all four; 'inventory' is an alias for 'items'
  theme: 'dark',                                   // a preset class, or CSS custom properties: { '--kei-wallet-accent': '#7c3aed' }
})

handle.unmount()   // deterministic: removes the DOM, unsubscribes, clears any revealed seed
```

`kei` is whatever `Kei.start()`/`Kei.server()` returned — the panel only needs its
public `address`, `seed`, `client.reveal`, `wallet`, and `custody`
(`WalletPanelKei`), so no adapter is needed. The panel re-renders on
`kei.wallet`'s own `change` event, so balances, tokens, items, and pending claims
stay live with no polling.

### A wallet a reload would lose says so first

Browser storage is not durable, and in private browsing it can refuse a write
outright (SPEC §6.4). When `kei.custody.durability` is `'session'` the panel
renders an undismissable warning **above every number**, and puts the seed-backup
control inside it — the sentence that names the risk and the control that answers
it are one thing, not two places.

```js
kei.custody.durability            // 'persistent' | 'session' | 'supplied'
handle.element.dataset.durability // the same fact, for styling or for disabling your own buy button
```

With `reveal: 'never'` there is no backup control to offer, so the warning says
that too: the wallet cannot be saved at all and should be kept empty until the
game turns backup on. A `kei` object that carries no `custody` mounts as before
and the panel claims nothing.

### Seed reveal, and streamer mode

The panel enforces the `reveal` policy chosen at `Kei.start({ reveal })` (SPEC §6.6):

- **`never`** — no reveal control is ever rendered. There is no path to the seed.
- **`on-request`** (default) — a click surfaces a plain-language risk warning; the
  seed itself is only ever in the DOM for as long as a press-and-hold on a second
  button is active, and is cleared the instant it releases — by mouse, touch,
  keyboard, or losing the pointer off the button entirely.
- **`always`** — shown with no friction, but only while streamer mode is off.
  Development/testing only; never ship it.

```js
import { WalletPanel } from '@keicoin/wallet'

WalletPanel.setStreamerMode(true)   // clears and re-hides the seed on every mounted panel, immediately
```

Streamer mode is a single global switch, on purpose: the failure it defends
against — a seed visible on a stream — does not care which panel is on screen.
Turning it off never auto-reveals anything; `on-request` panels re-arm from the
closed state and require the confirm-then-hold gesture again.

As with the rest of this SDK, none of this is a security boundary against an
attacker — it defends against shoulder-surfing, screenshots, and streaming. Any
XSS on your page reads browser storage regardless of what the UI shows.

## Headless

```js
await kei.wallet.summary()      // { address, kei, tokens, items, pending }
kei.wallet.on('change', s => {})
```

`WalletPanel` is built on this; use it directly if you are drawing your own UI.

## Proving the player controls their address

An address is public, so a game server binding a session to one has to ask for a
signature rather than take the client's word. The key stays inside the SDK, and
this works under every `reveal` policy, `never` included — proving control is
what a wallet does with its key, not something anyone needs its seed for.

```js
const proof = await kei.wallet.signOwnershipChallenge({
  domain: 'example.com/my-game/session/v1',   // the asking server's namespace
  address: kei.address,                       // must be this wallet's own
  nonce,                                      // server-generated, one use
  context: { roomId, sessionId },             // bounded, and all of it signed
})
// { address, signature, challenge }
```

The digest signed is derived here from the parsed challenge. A wallet that
signed a digest it was handed would sign whatever bytes the asker chose, and the
bytes worth choosing are the hash of a send — so a `hash` sent alongside is
checked and refused on disagreement, never signed as given. A challenge naming
another wallet, carrying an unknown field, or arriving as a bare hex string is
refused with a sentence.

`verifyOwnershipProof` in [`@keicoin/core`](https://www.npmjs.com/package/@keicoin/core)
is the other half. It needs the address and no key, so the server checking a
proof does not have to hold a wallet at all.

Games that construct the headless wallet directly can tune immutable asset
metadata reads without changing mutable summary behavior:

```js
import {
  createWallet,
  DEFAULT_ASSET_CACHE_LIMIT,
  DEFAULT_ASSET_CONCURRENCY,
  MAX_ASSET_CACHE_LIMIT,
  MAX_ASSET_CONCURRENCY,
} from '@keicoin/wallet'

const wallet = createWallet(client, {
  claims,
  assetConcurrency: 8,  // default 8; whole number from 1 through 32
  assetCacheLimit: 2048 // default 2,048; whole number from 1 through 8,192
})
```

Those four constants, `createWallet`, and the `WalletOptions` TypeScript type are
also re-exported by the recommended `kei-transaction` umbrella package.

Both limits are the client's, not one wallet's: the cache is shared with
`kei.items.ownedBy()`, so the same asset is fetched once and the concurrency
bound covers overlapping summaries and inventory reads together. Whichever asks
first sizes it, and `createWallet` asks while it is being constructed. The LRU
cache lasts for the client's lifetime and contains issuance metadata only;
balance, holdings, pending claims, and circulating supply are always read
fresh. A custom cache limit below the current holding count is supported, but it
will evict and refetch some metadata between summaries. Invalid limits fail
synchronously with `KeiError('bad-wallet-option')`. If a node answers an asset
lookup with metadata carrying a different asset id, the summary rejects with
`KeiError('asset-info-mismatch')`, caches nothing from that response, and retries
the lookup on the next summary.

Token and item rows are sorted by asset id, independent of node response order.
Every `change` listener shares one client subscription and one refresh loop.
Bursts collapse to the refresh in flight plus one follow-up, listener failures
are isolated, and a listener never receives a snapshot whose read started before
that subscription instance existed.

## Status

**M6 of eleven.** The panel and its seed-reveal friction are real and tested end to
end. The [Button demo](https://keicoin.org) is playable against the headless API.
The public API now uses a real node at `https://testnet.keicoin.org/rpc`;
`MockNode` remains the hermetic reference implementation. The testnet is one
best-effort node with weak consensus and **nothing there holds value.**

See the [full documentation](https://github.com/keicoin-org/kei-transaction/blob/master/README.md).

MIT.
