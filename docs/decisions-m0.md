# M0 decisions

SPEC.md is the brief, and it settles a great deal. It does not settle
everything, and a few things it leaves open had to be fixed for M0 to run at
all. Each one is recorded here with what was chosen and why, so that M2 (the
node fork) inherits a decision rather than a surprise.

Nothing here overrides SPEC.md. Where a decision is provisional, it says so.

---

## 1. Kei has 18 decimal places

**Unstated in the spec.** Nano uses 10^30 raw per unit, Banano 10^29, and both
sit inside a 128-bit balance because their supplies are small enough. Kei's
supply is 1 trillion, so 10^30 raw per Kei would need 10^42 raw in total and
would not fit in 128 bits.

18 decimals gives a total supply of 10^30 raw — comfortably inside 128 bits,
familiar to anyone who has touched a token before, and far finer than the
sub-cent payments the pitch rests on (0.001 Kei is 10^15 raw).

**Provisional: this is the genesis block's number to fix at M2.** It lives in one
place (`KEI_DECIMALS` in `@keicoin/core`) precisely so changing it is one edit.

## 2. Block hashing is canonical JSON under a versioned preamble

`hashBlock()` hashes `blake2b-256("kei-block-v0\n" + canonicalJson(body))`.

This is **not** a wire format, and it is not proposed as one. The byte layout of
`asset` blocks is a consensus decision belonging to the node fork, and inventing
one here would mean inventing it twice. What M0 needs is a hash that is
deterministic, injective over the fields, and impossible to confuse with a later
version — the preamble carries the version so `v1` blocks can never collide with
these.

**M2 replaces this** with the real serialisation. The SDK touches hashing in
exactly one function.

## 3. `asset_receive` is an operation the spec's table does not name

SPEC §5.3 lists the asset operations; SPEC §5.6.3 then requires that assets
arrive as *receivable* and are collected by the recipient's own signed block.
That collection needs an operation, and §5.3's table has none.

Added: `asset_receive`, tier C, the asset-side twin of the inherited `receive`.
It is the mechanism §5.6.3 describes, not a new capability.

## 4. Memos ride on the send block

SPEC §6.7's purchase flow passes a `memo` and the issuer reads it in
`onPayment`. Nano-family state blocks have no memo field, and §5.6.8 asks that
inherited block types keep their semantics and their RPC shapes.

M0 carries an optional `memo` on send blocks in the mock. **M2 must choose**, and
the recommendation is (a):

- **(a)** carry memos on a new `asset`-family send block, leaving inherited
  `state` blocks untouched and wire-compatible; or
- **(b)** deliver memos out of band, and accept that the issuer correlates
  payments by amount and timing instead.

Whichever is chosen, the SDK surface does not move.

## 5. `transferPolicy`, not `transfer`, on returned tokens

SPEC §6.7 spells the issuance option `transfer: 'open'` *and* the player method
`gems.transfer(to, 120)`. Both cannot be the same property.

The method keeps the spec's name, because that is the call site a developer
writes. The policy is exposed as `transferPolicy` on token and item objects. The
option passed to `issue()` and `items.create()` is still `transfer`, exactly as
written in the spec.

## 6. `totalSupply` is a property *and* a method

SPEC §6.7 writes `gems.totalSupply` as a property. A property cannot re-read the
chain, and a stale number about money is a footgun — a player claim mints supply
without the issuer writing anything.

Both exist: `gems.totalSupply` is the last known value (refreshed after every
operation this issuer performs), and `await gems.supply()` re-reads it. The
property's staleness is documented at the point of use.

## 7. Claims need a bundle the player is handed

SPEC §5.5 says the player submits a proof and §6.7 shows `kei.claims.pending()`.
Nothing on-chain can tell a player what they are owed: a root is one hash, and
the entitlement behind it lives in the batch the issuer built.

So `drop.proofFor(address)` returns a **bundle** — `{ root, asset, amount, proof }`,
plain JSON a game server can post to its client — and the player's SDK takes it
with `kei.claims.add(bundle)`. From there claiming is automatic (SPEC §5.5,
cost 3). `pending()` lists bundles this wallet holds and has not yet claimed,
dropping any whose root has been closed.

Bundles are held in memory for M0. Persisting them across reloads is a wallet
concern and lands with M6; losing one is not fatal, because the game can send it
again.

## 8. Item symbols are derived from item names

Asset ids are `H(issuer_pubkey || symbol)` (SPEC §5.6.1), so an item needs a
symbol. `items.create({ name })` derives one: a slug of the name, truncated,
plus a short digest of the full name so two long names sharing a prefix do not
collide into one asset.

The consequence is a good one: `items.create()` is idempotent per (issuer, name)
for the same structural reason `token.issue()` is idempotent per (issuer,
symbol). Pass `symbol` explicitly to override.

## 9. A `kind` hint in metadata separates items from currency

The chain cannot tell a sword from a coin, and SPEC §7 is explicit that it
should not try: "group them in the SDK if grouping is needed for UI."

`items.create()` writes `kind: 'item'` into the asset's metadata. The wallet uses
it to split `tokens` from `items` in its summary, falling back to "0 decimals and
an image" for assets issued without the hint. It is a convention in metadata, not
a protocol rule, and nothing validates it.

## 10. IPFS is stubbed until M4

`items.create({ image })` needs somewhere to put the image. M0 ships
`MockIpfsUploader`, which computes a stable content address without a network
(`bafkmock…`) and passes through anything already shaped like a CID or a URL.
Pass your own `uploader` to `Kei.server({ uploader })`; the interface is one
method.

## 11. `Kei.start()` with no node runs against an in-process mock

There is no public testnet until M3. Rather than fail, an unconfigured client
gets a private in-memory chain — which is what makes the sixty-second test
(SPEC §6.2) real today rather than aspirational.

This is never invisible: `kei.network` reports `'mock'`, not `'testnet'`. Pass
the same `MockNode` to several clients to have them share one ledger, which is
what the tests and the demo do:

```js
const node = await Kei.mock()
const game = await Kei.server({ seed: process.env.KEI_SEED, node })
const player = await Kei.start({ node })
```

`network: 'mainnet'` without a node URL throws, because mainnet does not exist.

## 12. `kei.sync()` exists

Not in the spec. Auto-receive is asynchronous by design, so a test or a server
job that wants a settled balance *right now* needs a way to say so. `sync()`
drains pending receivables and returns how many it collected. Nothing in a game
loop needs it.

## 13. Mock genesis uses fixed, public seeds

`MockLedger` builds the SPEC §5.7 allocation at startup — 900B reserve, 100B
circulating across grants, community, bounty, and team — and asserts the
circulating allocations sum to exactly 100,000,000,000 (a mismatch is a launch
blocker, so it throws).

The five accounts derive from fixed seeds (`'1'.repeat(64)` and friends). They
are public on purpose: this is a mock, and tests need a funded faucet. M2
replaces them with a real genesis block, at which point the reserve's seed is
never a literal anywhere.

The reserve rules are enforced from day one even in the mock: reserve accounts
must name the null representative, reserve sends are rejected outright (the vote
that would authorise one is not built), and `ledger.weights()` derives weight
from Kei balances only, excluding the reserve entirely.

## 14. Governance is not in M0

SPEC §5.7's proposal, vote, quorum, and release mechanism is new protocol work
and the spec budgets it as the second-largest node item after tokens. M0 has no
proposals. The mock's stance is the spec's failure mode: **nothing moves.**

---

## Package boundaries, and the one exception

SPEC §10.1: `@keicoin/core` depends on nothing else in the tree, and every other
package depends on core and ideally nothing else. Two packages depend on more:

- **`@keicoin/tokens` → `@keicoin/claims`**, because `gems.commit()` is a token
  operation whose implementation is Merkle machinery.
- **`@keicoin/wallet` → `@keicoin/tokens` and `@keicoin/claims`**, because a wallet panel
  shows balances, inventory, and pending claims (SPEC §6.5).

Both are the intended shape rather than a leak. `@keicoin/core` still depends on
nothing, which is the rule that matters.

`@keicoin/market` does not exist yet: offers and settlement are M5.
