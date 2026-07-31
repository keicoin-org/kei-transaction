# The Kei node RPC

This is the contract between the SDK and a node. `MockNode` implements it in
memory, `mockRpcHandler` serves that over HTTP, and `HttpNode` speaks it from the
other side. The node fork (M2) has to serve exactly this; M3 changes what is
behind the URL and nothing else.

```js
import { MockNode, mockRpcHandler } from '@keicoin/core'

Bun.serve({ port: 7777, fetch: mockRpcHandler({ node: await MockNode.create() }) })
```

`mockRpcHandler` is a `Request → Response` function and starts no server itself,
so it runs under Bun, Node, a worker, or a test's `fetch`. It answers browser
preflight and sets `access-control-allow-origin: *`, because a mock node exists
to be reached from a game on some other dev port; pass `cors: false` to turn that
off. It is a development tool — it validates nothing that `MockLedger` does not.

Conventions follow Nano and Banano wherever they cost nothing (SPEC §5.6.8), so
existing tooling ports with a constant change rather than a rewrite:

- One POST per call, `content-type: application/json`.
- The request body is `{ "action": "...", ...parameters }`.
- **Every amount is raw, as a decimal string.** Never a number, never scaled.
- Hashes, public keys, and asset ids are 64 uppercase hex characters.
- Addresses carry the `kei_` prefix.
- Kei itself is asset `0000…0000` (64 zeros).
- An error is `{ "error": "..." }` with HTTP 200 or an HTTP error status; either
  is surfaced as a `KeiError` naming the node and the action.

Anything absent is `null` or an empty array, not an error: an account that has
never transacted is `{ "account": null }`, not a 404.

---

## Accounts

### `account_info`

```json
{ "action": "account_info", "account": "kei_3abc..." }
```
```json
{ "account": {
  "address": "kei_3abc...",
  "frontier": "A1B2...",
  "height": 12,
  "balance": "5000000000000000000",
  "representative": "kei_3xyz...",
  "receivableCount": 0,
  "issuedCount": 2
} }
```

`null` for an account with no chain yet.

`issuedCount` is how many assets this account has issued, and it prices the next
one: **the nth asset an account issues burns n Kei** (SPEC §5.6.5). A signer
cannot construct a valid `issue` block without it, because the burn is a balance
decrease the block has to state exactly — so this is a read the SDK makes before
every issuance, not a statistic.

### `account_history`

```json
{ "action": "account_history", "account": "kei_3abc...", "count": 100, "shape": "block" }
```
```json
{ "history": [ { "type": "state", "subtype": "send", "...": "..." } ] }
```

Newest first. Blocks are returned in the same shape `process` accepts, and every
block on the account's chain appears — including `change` blocks, which Nano's
own answer omits.

**`shape` is required**, and it is the one parameter in this document that a Kei
node needs because of its ancestry rather than because of Kei. A Banano-derived
node already answers to `account_history`, with entries it derives from the
blocks rather than the blocks themselves — the subtype in `type`, the
counterparty in `account`. Those two keys collide with a block's own and mean
something else in each, so unlike `accounts_receivable` the two answers cannot
be told apart by reading them, and unlike `block_info` they cannot sit beside
each other under separate keys. Omitting `shape` gets the inherited answer,
which parses cleanly as a block and describes a different one. kei-node's
`docs/decisions-m2.md` §15 records the reasoning; `mockRpcHandler` requires the
parameter it could infer, so that a client which forgets it fails here rather
than against a real node.

### `block_info`

```json
{ "action": "block_info", "hash": "A1B2..." }
```
```json
{ "block": { "type": "asset", "...": "..." } }
```

### `accounts_receivable`

```json
{ "action": "accounts_receivable", "account": "kei_3abc..." }
```
```json
{ "receivables": [
  { "hash": "A1B2...", "from": "kei_3xyz...", "asset": "0000...", "amount": "1000", "memo": "Sword" }
] }
```

Assets arrive as receivable exactly like Kei (SPEC §5.6.3): nothing lands in an
account's state until that account signs for it.

### `process`

```json
{ "action": "process", "block": { "type": "state", "...": "..." } }
```
```json
{ "hash": "A1B2..." }
```

Idempotent: submitting a block the node already has returns its hash rather than
reporting a fork.

### `work_thresholds`

```json
{ "action": "work_thresholds" }
```
```json
{ "thresholds": { "A": "18446739675663040512", "B": "...", "C": "..." } }
```

Tiers per SPEC §5.6.4. A is `issue`/`mint`/`commit`/`commit_close`, B is
`send`/`transfer`/swap blocks, C is `receive`/`claim`/`burn`.

---

## Assets

### `asset_info`

```json
{ "action": "asset_info", "asset": "A1B2..." }
```
```json
{ "asset": {
  "id": "A1B2...",
  "issuer": "kei_3abc...",
  "name": "Gems",
  "symbol": "GEM",
  "decimals": 0,
  "maxSupply": "1000000",
  "transfer": "open",
  "swap": "one-way",
  "description": "...",
  "image": "bafy...",
  "kind": "item",
  "circulating": "4210"
} }
```

`maxSupply` is `null` when uncapped, and caps **circulating** supply, so burning
frees headroom (SPEC §5.6.6). `transfer` is protocol-enforced; `swap` is stored
and never acted on (SPEC §5.4). `kind` is an SDK metadata hint and carries no
protocol meaning.

### `asset_by_symbol`

```json
{ "action": "asset_by_symbol", "issuer": "kei_3abc...", "symbol": "GEM" }
```

Asset ids are derived — `H(issuer_pubkey || symbol)` — so this is a computation
rather than a registry lookup, and nothing can race it.

### `account_holdings`

```json
{ "action": "account_holdings", "account": "kei_3abc..." }
```
```json
{ "holdings": [ { "asset": "A1B2...", "balance": "500" } ] }
```

A prefix scan of the `holdings` table, keyed `(account, asset_id)` (SPEC §7).
Zero balances are absent: entries are deleted, not kept at zero.

### `asset_balance`

```json
{ "action": "asset_balance", "asset": "A1B2...", "account": "kei_3abc..." }
```
```json
{ "balance": "380" }
```

**One lookup in the `holders` table**, keyed `(asset_id, account)`. This is
acceptance criterion 3 — `balanceOf` in a single call — and it is why the same
facts are indexed in both directions.

### `asset_holders`

```json
{ "action": "asset_holders", "asset": "A1B2...", "count": 100 }
```
```json
{ "holders": [ { "account": "kei_3abc...", "balance": "1" } ] }
```

For a supply-1 asset this answers "who owns this item?" in one entry.

---

## Claims

### `commit_info`

```json
{ "action": "commit_info", "root": "A1B2..." }
```
```json
{ "commit": {
  "root": "A1B2...", "issuer": "kei_3abc...", "asset": "C3D4...",
  "count": 1000, "total": "1000", "closed": false
} }
```

`closed` is set by the issuer's `commit_close` block. Closed roots accept no
further claims and become prunable — there is no expiry, because a block-lattice
has no clock (SPEC §5.5).

### `claim_status`

```json
{ "action": "claim_status", "account": "kei_3abc...", "root": "A1B2..." }
```
```json
{ "claimed": true }
```

The double-claim index is keyed `(account, root)`, so the record partitions with
the account that made it and prunes alongside that account's chain (SPEC §5.5).

---

## Testnet only

### `faucet`

```json
{ "action": "faucet", "account": "kei_3abc...", "amount": "10000000000000000000" }
```
```json
{ "hash": "A1B2..." }
```

`amount` is optional. Mainnet nodes must reject this action — an agent's only
human step on mainnet is somebody sending Kei to the printed address (SPEC §12).

---

## Not yet specified here

`swap_offer` / `swap_accept` / `swap_cancel` and the market read model are M5.
They will add actions here; they will not change the ones above.

## Subscriptions

`HttpNode` polls `accounts_receivable` on an interval, because a plain RPC node
has nothing to push with. A node offering a websocket or long-poll can be adopted
by implementing `subscribe()` differently — the SDK only requires that a
notification eventually arrives, not how.
