# M5 decisions

SPEC §9 settles what a swap *is*: three block types, only the offerer ever
locks anything, and accept/cancel race for one locked entry with no timeout.
What it leaves to this package is how that reads as an SDK, and a few wire
details the node fork has not published yet. Recorded here so M5-on-the-node
inherits a decision rather than a surprise, the same discipline
decisions-m0.md through decisions-m1.md kept for M0-M4.

Nothing here overrides SPEC.md.

---

## 1. The op bytes are a proposal, and it is pinned to a real reservation

`wire.ts` assigns `swap_offer = 8`, `swap_accept = 9`, `swap_cancel = 10`.
kei-node has not published a swap layout, but it has already reserved the
numbers: `decisions-m2.md §17` (kei-node) records that `§18` "reserves 5/6/7 for
commit/commit_close/claim and 8 upward for the swap legs" — and SPEC §9.2's own
block table lists them in exactly this order: `swap_offer`, `swap_accept`,
`swap_cancel`. This SDK spends 8/9/10 in that order rather than guessing, so a
correctly-ordered node implementation needs no renumbering here. If the node
lands a different order, `wire.ts`'s `ASSET_OP` table is the one place to fix
it — the op byte is hashed, so getting this wrong before the node exists would
mean every swap block signed against this SDK becomes unverifiable the day the
real layout ships (the same risk `decisions-m2.md §18` names for its own
numbering).

The payload layout is this SDK's own proposal, built from the pattern every
other M2/M4 op already follows (§7 header, fixed-width payload appended):

- `swap_offer` reuses the header's three op-dependent fields for the *offered*
  leg — `assetId`, `amount`, and `link` for the optional counterparty — because
  those are exactly the three the header already carries for `transfer`. The
  payload is fixed-width: the wanted asset id (32 bytes), the wanted amount (16
  bytes), and the advisory expiry (8 bytes, big-endian, zero meaning "none").
- `swap_accept` and `swap_cancel` both carry nothing but the offer hash, in
  `link`. Which assets move, in what quantities, and to whom is the offer's
  business — deliberately the same reasoning `decisions-m2.md §10` gives for
  leaving `asset_receive`'s own asset id at zero, and it is what makes it
  structurally impossible for the two legs of a trade to disagree about price.

## 2. The accept-vs-cancel race is resolved by arrival order in the mock, and that is a stand-in for the real rule

SPEC §9.2 conflict 4 is explicit that this is genuine new consensus work: two
nodes can see `swap_accept` and `swap_cancel` in different orders because they
sit on *different* chains, and resolving it needs the node's fork-resolution
path to key on the consumed lock rather than on `previous`.

`MockLedger` cannot implement that — it is one process with no network to
disagree across. What it implements instead is the property the real rule has
to preserve: **whichever of the two blocks the ledger applies first wins, and
the other is rejected outright, with nothing partially applied.**
`swap.test.ts`'s race tests assert exactly this — first-cemented-wins,
loser-changes-nothing — because that is the contract the real ORV-based
resolution has to honour once it exists, not a claim that the mock has done
consensus's job for it. The `offer-taken` / `offer-cancelled` error codes are
part of that contract: a loser gets a named, retryable outcome rather than a
generic conflict, on both the ledger and the `@keicoin/market` layers.

## 3. `SwapOffer.seenAt` / `settledAt` are node-local, on purpose, and the market package inherits the caveat

SPEC §5.5 rules out a consensus clock everywhere, and §9.1 states plainly that
the useful market history has to come from data nobody had to timestamp. There
is no field in a swap block that could carry "when" without inventing
consensus time — the one thing this whole project has refused to add.

`seenAt` and `settledAt` are `MockLedger`'s own wall clock (`Date.now` by
default, replaceable per `LedgerOptions.now` for tests), recorded the moment
this node processes the block. Two nodes will disagree by their processing
order and their local clock skew; a restarted node's `seenAt` history survives
only as long as `MockLedger`'s in-memory `locks` map does, because the mock has
no persistence layer — a real node fork would need to decide separately whether
`local_timestamp`-style fields belong in its own store.

`@keicoin/market`'s `TradeOptions.window` and `Offer.expired` both read these
fields, and the docstrings on `SwapOffer` (`node.ts`) and `Offer`/`Trade`
(`market/src/types.ts`) say so explicitly: good enough to hide last month's
listings or decide a background sweep should fire, never good enough to settle
a dispute or to expect two nodes to agree on an exact instant.

## 4. `@keicoin/market` depends on `@keicoin/core` and nothing else

SPEC §10.1's rule — "if `tokens` needs `market`, the boundary is wrong" — cuts
the other way here too: `@keicoin/market` reads assets, balances, and account
histories entirely through `KeiClient` and `KeiNode`, both `@keicoin/core`
exports, and never imports `@keicoin/tokens`. An `Offer`'s `give`/`want` legs
carry their own `symbol`/`name`/`decimals` (fetched via `asset_info`) rather
than reaching for a `Token` or `Item` object, so a developer can read the
market without installing the tokens package at all — the umbrella
(`kei-transaction`) is what glues `market` to `items`/`tokens` for the common
case (§10.1's "one install" promise), not a dependency between the sub-packages
themselves.

The test suite mirrors this on purpose: `packages/core/test/swap.test.ts` pins
the ledger invariants at the block level, the same way `ledger.test.ts` does
for §5.6; `packages/kei/test/market.test.ts` and `market-over-http.test.ts`
exercise `@keicoin/market` the way a developer actually reaches it, through the
umbrella and (for the HTTP file) across a real request/response boundary —
the M1 rehearsal `decisions-m1.md §1` established, run again for M5's actions.

## 5. An offer's `to` (counterparty) is checked against both possible legs before either is known to be Kei

`requireSwappable` in `MockLedger` runs at `swap_offer` time, before a
counterparty is guaranteed to exist yet — an open offer may never be accepted,
so the ledger cannot wait for an accepter to check transfer policy against.
For `issuer-only` and `none` (soulbound) assets this means the check has to
reason about "any possible counterparty" rather than a concrete one: an
`issuer-only` asset can be offered only if the offerer *or* the (optional)
named counterparty is the issuer, because that is the one shape that could ever
settle. A soulbound asset refuses the offer outright, on either leg, because no
counterparty makes it transferable. `swap_accept` re-checks the policy against
the real, now-concrete pair — belt and braces, and cheap, since by then both
parties are known.

## 6. Items are swap legs like any other asset — the 1,024-asset cap is unaffected

SPEC §7 caps an account at 1,024 distinct held assets, enforced because
locking an item moves it out of `holdings` (§5.6.1's "an account's asset
footprint only ever grows through acts that account signed itself" still
holds: only the offerer's own `swap_offer` can remove one of their own
holdings entries). A `swap_offer` on an item is exactly a §7 holdings-table
delete, and `swap_accept`/`swap_cancel` are exactly a holdings-table insert on
whichever side receives it. No new accounting was needed for the cap; the
existing zero-balance-deletes-the-entry rule already does the right thing for
a locked item, because a locked item is a zero balance until it resolves.
