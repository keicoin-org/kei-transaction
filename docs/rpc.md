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

## The market (SPEC §9)

An offer is a `swap_offer` block on the offerer's own chain — there is no
separate listing action to call. `process` already carries all three swap
blocks; `swap_info` and `account_swaps` below are the read model over them.
The op bytes this SDK proposes for the three legs, and why, are recorded in
[`docs/decisions-m5.md`](decisions-m5.md) §1.

### `swap_offer` (via `process`)

Locks `amount` of `asset` out of the offerer's spendable balance — Kei itself
if `asset` is `0000…0000` — into an entry keyed by this block's own hash.
Nothing moves to anyone yet.

```json
{ "type": "asset", "op": { "kind": "swap_offer",
  "asset": "0000...0000", "amount": "1000000000000000000",
  "wantAsset": "A1B2...", "wantAmount": "1",
  "counterparty": "kei_3abc...", "expiresAt": 1735689600000 } }
```

`counterparty` is optional — absent means anyone may accept. `expiresAt` is
optional, advisory, milliseconds since the epoch, and never consensus-enforced
(SPEC §9.3): the chain has no clock, so an expired offer still settles if
somebody accepts it before its owner cancels it.

### `swap_accept` (via `process`)

References the offer by hash, and restates its `wantAsset`/`wantAmount` as
this block's own `asset`/`amount` — the accepter's signature has to cover
what it pays, the same as every other op signs its own cost, rather than
trusting whatever the offer hash currently resolves to. A restatement that
does not match the offer exactly is rejected (`swap-terms-mismatch`). One
block, both legs: debits the accepter for `amount`, and creates two
receivables — `amount` to the offerer, the offer's own locked `amount` to the
accepter. Valid exactly once; a second accept, or an accept after the offer
was cancelled, is rejected.

```json
{ "type": "asset", "op": { "kind": "swap_accept", "offer": "F1E2...D3C4",
  "asset": "0000...0000", "amount": "5000000000000000000" } }
```

### `swap_cancel` (via `process`)

References the offer by hash. Returns the locked amount to the offerer's own
spendable balance. Valid only while the offer is still open — an offer already
settled by an accept cannot be cancelled, and this is the one place a node
sees the accept-vs-cancel race SPEC §9.2 describes: whichever of the two
blocks the node applies first wins outright, and the other is rejected with
nothing partially applied.

```json
{ "type": "asset", "op": { "kind": "swap_cancel", "offer": "F1E2...D3C4" } }
```

### `swap_info`

```json
{ "action": "swap_info", "hash": "F1E2...D3C4" }
```
```json
{ "offer": {
  "hash": "F1E2...D3C4", "from": "kei_3abc...",
  "asset": "A1B2...", "amount": "1",
  "wantAsset": "0000...0000", "wantAmount": "1000000000000000000",
  "counterparty": null, "expiresAt": null,
  "state": "open", "settledBy": null, "acceptedBy": null,
  "height": 4, "seenAt": 1735689600000, "settledAt": null
} }
```

`null` for a hash that is not a `swap_offer` block, per this document's usual
convention. `state` is `"open"`, `"accepted"`, or `"cancelled"`. `seenAt` and
`settledAt` are the *node's own* wall-clock time in milliseconds — not
consensus, and two nodes will disagree — good for hiding old listings, never
for settling a dispute (`decisions-m5.md` §3).

### `account_swaps`

```json
{ "action": "account_swaps", "account": "kei_3abc...", "count": 100, "state": "open" }
```
```json
{ "offers": [ { "hash": "F1E2...D3C4", "...": "..." } ] }
```

Newest first, and bounded to one account's own chain — SPEC §9.1's answer to
"what is on sale": a scan of the accounts a client already cares about, never a
network-wide index (SPEC §9.4 — Kei does not run a matching engine or a
listing service). `state` is optional; omit it for offers in any state. This is
also how price history is read: a settled offer *is* a trade, so
`{ "state": "accepted" }` against the chains you name is the whole of
`@keicoin/market`'s `trades()`.

## Subscriptions

`HttpNode` polls `accounts_receivable` on an interval, because a plain RPC node
has nothing to push with. A node offering a websocket or long-poll can be adopted
by implementing `subscribe()` differently — the SDK only requires that a
notification eventually arrives, not how.
