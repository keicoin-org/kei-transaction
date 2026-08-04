# Drop table decisions

SPEC §5.5 names "loot tables as commitments" in one sentence — *publish the root
before the fight, revealing what can drop and with what weights, so drops are
verifiable rather than merely asserted* — and leaves everything about how to a
reader. This records the decisions that sentence needed, so the next person to
touch it inherits an argument rather than a surprise.

Nothing here overrides SPEC.md. No consensus rule is added, changed, or assumed:
every block a drop table writes is a `commit`, a `commit_close`, or a `claim`
the SDK could already write by hand.

---

## 1. The digest binds through the salt, because the salt was already a leaf

The problem is a specific one. A root commits to entitlements, and an
entitlement is `(account, asset, amount)` — nowhere in it is there room for
"and this came from the table with these odds". Adding a field is a node change,
which is the most expensive thing this project can do and out of all proportion
to the feature.

`buildCommit` already appends one extra leaf: a random 32-byte salt, there
because a root is otherwise a pure function of who is owed what, and a game that
drops 20 coins to the same player twice would build a root the ledger has
already seen. That leaf is space in the tree that nothing can claim, that the
node never enumerates, and that the root already commits to.

So the salt stops being random and becomes `H(SALT_DOMAIN ‖ digest ‖ nonce)`. The
nonce is fresh per batch and keeps the uniqueness property the random salt had.
The digest is what the batch is now bound to.

The only new thing this needs is a way to *prove* the salt is in the tree, which
is one more sibling path — `BuiltCommit.saltProof`, added to `@keicoin/claims`.
It is eleven lines and it changes no root, no proof, and no block: an existing
`token.commit()` produces exactly the bytes it produced before, and simply also
hands back a path it was throwing away.

**Rejected: a second `commit` block announcing the table before the fight.** It
was the first idea, and it is what SPEC's wording most literally suggests. It
fails on the ledger's own rules — a `commit` names an asset and a count of at
least one entitlement, so an announcement block is a lie in both fields, and it
creates a root that must then be closed by an issuer who has nothing to close.
Two blocks per encounter also puts the announcement back on the issuer's
sequential chain, which is the bottleneck §5.5 exists to avoid.

## 2. What verification proves, stated as a boundary rather than a feature

Four checks, and it is worth being explicit about which is which, because the
temptation to describe this as "provably fair loot" is real and it would be a
lie:

| Check | Catches |
|---|---|
| the root exists on this network | a proof against a batch nobody published |
| the salt folds to it under this digest | a table rewritten after the batch |
| the player's leaf folds to it | an award drawn for somebody else, or for another amount |
| the pair is declared in the table | a payout the table never listed |

What none of them catch: **a game that does not honour its own weights.** The
roll happens on the game's server, and the chain never sees it. A published 1%
sword that is never rolled is invisible to every check here.

That gap is not closeable inside this SDK. Making the roll checkable needs a
randomness source neither party controls and both can verify after the fact — a
commit-reveal chained across batches, or a beacon. Chained commit-reveal is
implementable on these primitives (batch *k*'s salt commits to the secret that
seeds batch *k+1*'s rolls) and was deliberately not built: it needs a genesis
batch, it breaks if the issuer ever skips a batch, it makes every drop depend on
the integrity of a chain of them, and it buys a property no game currently
shipping on Kei has asked for. It is a coherent thing to add later, on top of
what is here, without changing the shape of `defineDropTable`.

The README and the module header both say the boundary in plain words. SPEC
§12's rule applies with unusual force here: an agent reading "verifiable drops"
cannot ask a follow-up question, and would ship the overstatement into somebody's
game.

### 2a. The table names the issuer, because the batch must not

Found in review of this branch, with a working exploit, before it merged.

The four checks above fold hashes, and hashes say nothing about *which* asset a
symbol meant. `{ symbol: 'GOLD' }` identifies a token only together with an
account (SPEC §5.6.1), and the first draft took that account from
`table.issuer ?? commit.issuer` — falling back to whoever published the batch.

That fallback hands the decision to the attacker. Anyone can read the digest out
of the shared table file, issue their own token called GOLD for 1 Kei, publish a
root whose salt is `dropSalt(digest, theirNonce)` with a leaf for the victim, and
hand over the award. Every one of the four checks passes, because every one of
them is true: the root exists, the salt is this table's, the leaf is the player's,
and the pair is declared. `verifyDrop()` returned `{ symbol: 'GOLD', quantity: 50,
chance: 0.6 }` and the player claimed a worthless lookalike — with the SDK's own
verification vouching for it.

The fix is one line of policy: **at verification the anchor is `table.issuer`
alone.** A table with a bare symbol in it and no issuer is refused
(`unanchored-table`) instead of resolved against a stranger. Publishing keeps its
convenience default — `options.issuer ?? table.issuer ?? client.address` — because
there the fallback is the caller's own key, which is not a party anyone needs
protecting from.

Naming rows by id needs no issuer and keeps working, since an id already is one.

The general shape, worth carrying to the next primitive: a proof is only as
meaningful as the thing it is anchored to, and an anchor taken from the same
message as the proof is not an anchor.

## 3. One roll per address per batch, refused rather than merged

A root commits to at most one entitlement per account (SPEC §5.5), and
`buildCommit` enforces that by merging duplicate recipients into one leaf. For a
drop table that merge is silently wrong: two rolls of 50 GOLD become one leaf for
100 GOLD, and 100 GOLD is not a row any table declares — so the award the player
receives cannot be verified against the table it came from, and the failure
surfaces as `undeclared-drop` on an award that was honestly produced.

`drop()` therefore refuses a duplicate address, names it, and says to roll them
again in the next batch. The alternative — one leaf per (account, row) — is not
available; the leaf hash is the node's, and its shape is the double-claim index's
natural key.

## 4. Headroom is checked before publishing, not discovered during claiming

A claim mints, and minting past `maxSupply` is an invalid block (SPEC §5.6.6). A
batch that commits more than the remaining headroom therefore does not fail as a
batch — it fails one player at a time, whichever of them press claim last, and
there is no way afterwards to tell an unlucky player from a cheated one.

`drop()` sums the batch per asset and refuses the whole thing while it is still a
number in a variable. The check is deliberately conservative and says so in its
own error: entitlements from earlier batches that nobody has claimed yet are not
in circulating supply, so passing this check is not a guarantee, only the removal
of the obvious case. The ledger remains the thing that decides.

## 5. `close()` refuses over unclaimed loot

SPEC §5.5 asks the SDK to publish a close once a root is some batches old and to
"warn before closing a root with substantial unclaimed value". A warning nobody
reads is not the shape that fits here: `close()` walks the batch's recipients,
and if any have not claimed it refuses with their count and a sample, because
closing over an entitlement is not tidying up — it is taking somebody's loot
back. `{ force: true }` is the way to mean it.

The walk is bounded by the batch size and uses `claim_status`, which is the read
the double-claim index already serves.

## 6. `@keicoin/economy` now depends on `@keicoin/claims`

SPEC §10.1 asks that every package depend on `@keicoin/core` and ideally nothing
else. This package already depended on `@keicoin/market`, because a recipe's
exchange shape *is* a swap; it now also depends on `@keicoin/claims`, because a
drop table's shape *is* a commit. Both are the same trade: the economy layer is
where the primitives are composed into what a game designer says, so it is the
one package that is expected to reach across them.

The direction stays correct — nothing in `claims` or `market` knows this package
exists — and the boundary rule that actually matters, that `@keicoin/core`
depends on nothing else in the tree, is untouched.

## 7. Amounts are canonicalised at declaration, and the name is not hashed

The digest is a promise about a serialisation, so two honest copies of the same
table must hash alike. `0.50`, `.5` and `+0.5000` are one number and are
normalised to one spelling before hashing; a JavaScript number that stringifies
into exponent notation is refused outright rather than mangled, because `toRaw`
is not reachable at declaration time — a table is written before the asset it
names exists.

`name` is not part of the digest. It is what a game shows a player, it is the
field most likely to be localised or edited for tone, and none of that changes
what can drop. `id`, every row's asset reference, every amount, every weight, the
row order, and the miss rate are all covered.

Asset references hash as written: a row naming `{ symbol: 'GOLD' }` and one
naming the resolved id are two different declarations and hash differently. That
is correct rather than unfortunate — they are the same asset only once a chain
has been asked, and the digest is the thing the two halves compare before either
of them asks.
