# M9 decisions — the harness

M9 is `npm create kei-game` working, skills complete, the package published, and
the testnet public (SPEC §13). **This covers the harness only.** The other three
are not started, and the last two are not this repository's to finish.

SPEC §11.3 settles what the harness does and what it must not become. What it
does not say is where it lives, what it emits, or what a developer needs
installed before the generated game runs. Those are here.

As with [`decisions-m0.md`](decisions-m0.md) and [`decisions-m1.md`](decisions-m1.md),
nothing here overrides SPEC.md.

---

## 1. The harness lives in this repository

**New: `packages/create-kei-game`.**

SPEC §10 enumerates five repositories and the harness is not one of them, so it
was not going to get a sixth without a spec change. Of the five, this is the one
whose audience ("game developers") and cadence ("fast") match, and there is a
harder reason than fit: the harness emits code written against the §6.7 API. When
that API moves, the emitted code is wrong, and it is wrong silently — a
scaffolder that generates against last month's surface produces a project that
fails on `bun install` rather than on a type error anyone would notice here.

Living in the tree means it moves with the API and inherits §10.1's one version
number, and every `bun test` both parses everything it emits (`test/scaffold.test.ts`)
and runs the game it emits against the SDK next door (`test/purchase.test.ts`, §8).

It is still not part of the SDK. It is not published under `@keicoin/`, it is not
re-exported by the umbrella, and it appears in the packages table under its own
heading — because `npm create kei-game` requires the package to be called
`create-kei-game`, unscoped, and because nothing a developer installs should ever
have it in the dependency graph.

## 2. It has no dependencies of its own

`node:readline`, `node:fs`, `node:path`. No prompt library, no colour library, no
spinner. A program that runs once and writes eleven files does not get to add
three supply-chain risks, and the first thing a developer waits for should be
their game's dependencies rather than the scaffolder's.

The one cost is the ticker rule: `symbolFor` copies the pattern out of
`normalizeSymbol` in `@keicoin/core` rather than importing it, so that installing
the harness does not install the SDK and `@bananocoin/bananojs` behind it. A copy
drifts, so `test/naming.test.ts` checks every symbol the harness derives against
the real `normalizeSymbol` — the SDK is a devDependency, present exactly where
drift would be caught and absent from what ships.

`kei-transaction` is a devDependency for the same reason: §8's test runs the
generated game, which needs the umbrella package the generated game imports. Both
are dev-only, `files` ships `dist`, `src`, and `templates`, and nothing a
developer installs has either in its graph.

## 3. Two prompts, and every prompt has a flag

SPEC §11.3 allows exactly two questions. It does not say what happens when there
is nobody to ask, and SPEC §12 expects most integrations to be driven by an
agent — which cannot answer a prompt at all.

So: `create-kei-game <project> --currency <name>` answers both up front, `--yes`
takes the defaults, and every failure exits non-zero with a sentence. If stdin is
not a TTY and an answer is missing, it says so and names the flags that would
have answered it rather than hanging on a prompt nothing will type into.

## 4. The ticker is derived, and shown before anything is written

Two questions means the currency's symbol cannot be a third. `Gold Pieces`
becomes `GOLD`: the first word, uppercased, alphanumerics only, five characters
at most.

Running the words together gives tickers nobody would pick (`GOLDP`) and initials
give tickers nobody recognises (`GP`), so it is the first word or nothing. The
derived ticker is printed in the closing message, because a currency's symbol is
fixed on the chain the moment it is issued and discovering yours by reading the
generated source is too late to change your mind cheaply.

## 5. The generated game needs Bun, and that is the whole build tooling

`bun run dev` is one process that serves the client, bundles it with `Bun.build`,
and runs a `MockNode` behind `mockRpcHandler` — the same shape as
[Button](../../button), for the same reason M1 found: the issuer seed cannot
reach a browser, so a real game is always two halves, and a dev server is the
smallest thing that can be both.

The alternative was Node plus a bundler, which is a bundler dependency, a bundler
config, and a bundler version to keep working — for a project whose defining
property is that every file in it is plain and editable. §11.3 forbids a build
plugin; this way there is no build step to plug into.

The cost is real and is not hidden: a developer without Bun gets a project they
cannot run. The harness checks for it and, if it is missing, says where to get it
and that nothing else is needed. The harness itself runs anywhere Node 20 does,
so `npm create kei-game` works either way.

## 6. The item is bought with Kei, not with the game's currency

The generated shop is one `kei.pay()` and one `kei.onPayment` handler, which is
§6.7's headline flow and the shortest honest purchase in the SDK: the player
signs the payment, the issuer signs the delivery, and neither can sign for the
other.

Charging in the game's own currency is the other obvious choice, and it needs the
same out-of-band correlation §6.1 below describes, plus a second asset to
denominate the price in. The generated README says how to switch. Starting with
the two-signature Kei payment also puts the sub-cent micropayment — the thing a
card processor cannot do at all — in the first thing a developer reads.

Clicks are paid by `commit` rather than `mint`, even though the batch is always
one player. Minting per player makes the issuer's chain a global write lock
(SPEC §5.5), and the point of writing it this way in a scaffold is that the code
does not change when there are a thousand claimants instead of one.

## 6.1 The purchase is correlated by hash, out of band

**Changed: this shop was written against `kei.pay({ memo })`, which no longer
exists.**

decisions-m2 §17 settled that a Kei send has no wire field for a memo and that
the SDK refuses one up front rather than building a block the node would silently
strip it from. That closed a real hole and it broke this scaffold: the generated
client passed `memo: LANTERN_MEMO`, the generated server matched on it, and the
first thing a developer bought threw `no-memo-yet`. Nothing in the harness
noticed, which is §8 below.

What replaces it is the correlator the SDK's own error names. `kei.pay()` returns
the hash of the block the player just signed. That hash identifies one payment
and nothing else, and at the moment of paying the player is the only party
holding it. So the browser posts `{ address, hash }` to `/game/lantern` after
paying, and the server delivers only if it has watched that exact payment arrive,
from that address, for at least the price.

Three properties are worth stating, because they are what makes this honest
rather than a memo with extra steps:

- **It is a claim only the payer can make.** A memo was a string anyone could
  copy into their own payment; a hash is evidence of a specific signed block.
- **It is retryable and it is exactly once.** Deliveries are filed under the
  hash, so a lost response, a second tab, or a refresh gets the first answer back
  instead of a second lantern. The player can recover the hash from their own
  account history, which is why the client prints it when the post fails.
- **Money first, order second.** The payment is final before the game hears about
  it. If the browser dies in between, nothing is lost that a retry cannot fix,
  and the game never holds money for a thing it did not deliver — the one case it
  cannot deliver (the player already owns a lantern) refunds.

The cost is an HTTP round trip the memo version did not need, and a server that
has to remember something. Both are real; neither is avoidable while a Kei send
has nowhere to put an intent. M4 may give memos a wire representation, and if it
does, this stays as it is: the hash is exact where a memo would only ever have
narrowed a guess.

The one piece of plumbing worth flagging is that `onPayment` reports the *receive*
block this account wrote, not the send the payer holds — a receive names the send
it collects in its `link`, so the server reads that back with `blockInfo` to file
the payment under the name the player knows it by. That is the SDK's shape, not
the game's, and it is the one line of this scaffold that reaches past `Kei` into
`kei.client.node`.

## 6.2 The answer to a hash is written down before it is given

**New: `templates/server/orders.ts`, and one file the generated server keeps.**

§6.1 leaves the shop exactly-once *in one process*: deliveries are filed under
the hash in a `Map`, and the map dies with the process. Restarting exposes three
holes at once — a payment that arrived while the game was down is never
announced to anybody, a repost of a delivered payment finds nothing and times
out, and if the payment is rediscovered while the delivery is not, the "you
already have a lantern" branch refunds the price of a lantern the player kept.
The third one makes the item free.

The chain answers the first two on its own: reading the issuer's account history
back at startup finds every payment ever collected, including the ones collected
inside `Kei.server()` before anything was listening. It does not answer the
third, and this is the part worth being precise about, because there is an
attractive wrong answer.

**Counting does not work.** The issuer's chain shows how many answers went to a
wallet — mints of the item to it, Kei sent to it — so it is tempting to answer a
payment whenever a wallet's payments outnumber its answers. That statement is
true and it names nothing. Take one wallet, payments A and B, and one answer:
replaying the *answered* A finds "one answer is still owed", takes the refund
branch, and hands back the price of the lantern A already bought — while B, the
payment that really was owed, is now recorded as settled and can never be
redeemed. One hash answered twice, one stranded, and the game out an item.
Aggregates are not attribution, and nothing on the chain attributes: a mint says
who, a refund says who, neither says *which payment*.

**So the local record is a write-ahead log, and the chain only confirms.** Every
purchase is four steps, in this order:

1. read the issuer's frontier
2. append an `intent` naming the hash, the plan, and that frontier — fsync
3. write the block (mint or refund)
4. append a `done` naming the hash and the outcome — fsync

`settle()` holds a mutex across all four, and startup closes every intent it
finds before it serves anything. So at most one intent is ever open, and that is
what makes step 3 recoverable *exactly*: while an intent is open the only blocks
this issuer can write are the receives it collects by itself and the one action
that intent is for. A mint of the item to that address after that frontier is
that intent's delivery. A Kei send to that address after it is that intent's
refund. Nothing else could have put either there. A crash at any of the seven
points in that sequence lands on one of three states, and each is decided rather
than guessed: no intent (nothing happened), an intent with no matching block
(nothing happened — write a `void` and let a repost answer normally), an intent
with its block (that is the answer — write the `done` it never got to write).

A torn last line is the same three states. A half-written `done` leaves its
`intent` open and the chain says what that intent did; a half-written `intent`
was never followed by an action at all, because the action comes strictly after
the write that tore.

**The chain's second job is catching the file going missing.** Answers to one
wallet are countable even though they are not attributable, so if the file holds
fewer answers for a wallet than the chain shows, records were lost — and every
hash for that wallet that is not on file becomes unanswerable. That is a
refusal, and it is deliberate: the two things the game could do instead are mint
a second lantern or refund one the player is still holding. The blast radius is
one wallet, and a wallet with no answers yet is unaffected.

Three costs, recorded rather than hidden:

- **A wiped disk strands unanswered payments.** Not money the game can take
  twice, but money a player cannot spend. It is the right way round and it is
  still a loss, and it is why the generated README says to back the file up.
- **Startup reads the whole issuer chain**, and refuses to start if it cannot
  reach the beginning of it. A partial read cannot tell a record this file lost
  from one written before the window began, so `historyLimit` is a ceiling the
  error names rather than a window that quietly narrows the audit.
- **Any Kei the issuer sends a player counts as a refund.** Give the game a
  second reason to send Kei and real purchases from that wallet get refused as
  unattributable. Safe direction, still a bug; `answerIn()` is where the fix
  goes, and it says so.

A game past its first thousand players replaces this file with a table keyed by
hash and drops the audit entirely, which is a database and one `INSERT` before
the mint. The point of writing it as a file is that the ordering is the whole
design and it is legible in forty lines.

## 7. A deploy pointed at testnet is refused, not warned

**New: `Kei.server()` fails with `testnet-in-deployment`.**

M9 makes the testnet public, which is the first point at which a developer can
ship a game against a real Kei network — and the first point at which they can
ship one against the *wrong* real Kei network. Testnet Kei is worth nothing and
that chain can be reset without notice (SPEC §5.9), so a game that reaches
players there has an economy with an expiry date nobody chose.

The signal is the environment rather than the code: `NODE_ENV=production`, or a
variable the platform sets by itself — `FLY_APP_NAME`, `RAILWAY_ENVIRONMENT`,
`K_SERVICE`, and the rest. The platform markers are the ones that matter, because
a developer who never set `NODE_ENV` is exactly the developer this is for. The
message names whichever one tripped it: a guard that fires for undisclosed
reasons gets switched off rather than read.

It refuses rather than warns because a warning here is a line in a startup log
during the one minute nobody is reading startup logs, and because the cost of
being wrong is asymmetric — a false refusal costs one environment variable, and a
false pass costs every coin a player earned. It runs at boot, on the server half,
before the seed is touched, which is the last moment the fix is still one word.

Two things it does not block. A mock, deployed or not, because a mock never
pretended to be money. And `KEI_ALLOW_TESTNET=1` for a public testnet demo
somebody meant to run — read from the environment rather than an option in code,
because it is a property of a deployment and not of a game.

The move it names is `network: 'mainnet'`, which does not work yet: mainnet is
blocked on validator distribution, threshold modelling, and the legal
conversation (SPEC §15). So the pair of errors has to be read together — the
refusal says move to mainnet, and `no-mainnet` says when mainnet arrives and what
to do until then. Pointing at a network that is not open is uncomfortable and it
is the honest state of the project; the alternative is a guard that says nothing
and lets the shipping happen.

## 8. The generated game is run, not just parsed

**New: `test/purchase.test.ts`.**

`test/scaffold.test.ts` reads every file the harness emits, parses the TypeScript,
and checks that nothing points back at the harness. All of that passed on the day
the shop stopped working, because a call that throws at runtime parses perfectly
and `templates/` is not in any `tsconfig` — the generated project type-checks in
the developer's directory, which is exactly one step too late.

So the harness now writes the project out, imports both halves of it, puts an
HTTP server between them, and buys the lantern: clicks are banked, the payment is
made, the hash is posted, the item arrives, and the click rate doubles. The same
file covers the rules that make hash correlation safe — one payment buys one
lantern however many times it is posted, somebody else's hash buys nothing, and a
hash nobody paid is refused rather than guessed at.

`test/restart.test.ts` runs it again after killing it. It restarts the generated
game against the same node and the same seed the way `bun run dev` does after a
crash, and it stages on the disk exactly what a crash at each step of §6.2's four
writes leaves behind: no intent, a torn intent, an intent with no block, an
intent whose block landed, a torn `done`, and a refund crash whose window must
not swallow the delivery before it. It also stands up a node that keeps a block
and then throws, which is the one failure a caller cannot tell from "it never
landed". The case worth naming is `one wallet, two payments, and a log that lost
its last line`: it is green here and it fails with a *refund* against the
counting design §6.2 rejects, which is the bug being paid for.

It writes into `packages/create-kei-game/.generated/` rather than a temp
directory, because the generated code has to resolve `kei-transaction` the way a
real project does: by walking up to a `node_modules` that has it. Here that is
the workspace link, so the emitted code is exercised against the SDK in this tree
rather than against whatever is on npm. `kei-transaction` is a devDependency of
the harness for that reason and ships in nothing.

Two gaps it does not close, recorded rather than hidden. The generated
`server/main.ts` cannot be imported, because it bundles the Babylon.js client at
startup and that dependency belongs to the generated project; its `/game/*`
routes are mirrored in the test and a last assertion fails if the two stop
agreeing. And the generated sources are still not type-checked anywhere — running
them catches what they do, not what they claim. Type-checking the emitted project
needs Babylon in this tree, which is a heavier trade than it looks and is M10's to
make.

## What is left of M9

- **Publishing — done.** All seven are on npm at `0.1.0`: `kei-transaction`,
  `create-kei-game`, and the five `@keicoin/*`. `npm create kei-game` now works
  for anybody, from the registry rather than from a checkout.

  It is worth recording how narrow the remaining door was, because the next
  release has to go through it too. npm refuses a plain token publish, and an
  account whose second factor is a security key has no six-digit code to pass —
  npm answers that challenge in a browser, so the CLI has to be attached to an
  interactive terminal or it fails with `EOTP` no matter how the account is
  configured. Setting 2FA to authorization-only does not exempt publishing. What
  worked was a granular access token with the 2FA bypass enabled, which npm is
  [retiring](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/):
  account operations in August 2026, direct publishing around January 2027.

  So this route has an expiry date. Trusted publishing (OIDC) is the successor
  and could not have done this first publish — npm requires a package to exist
  before a trusted publisher can be configured for it — but now that all seven
  exist, it can do every publish after this one, and configuring it is the
  cheapest thing M10 can do for itself.

  One trap for whoever runs `scripts/publish.sh` next: npm's public read replica
  lags its write path by minutes, so a package can be published, refuse to be
  published again, and still 404 for anyone reading. The script's
  already-published check passes `--prefer-online` because the cached 404 from
  before the first publish is otherwise believed.
- **Skills** (§11.2) — one per task, distributed alongside `AGENTS.md` and
  `llms.txt`. Not started.
- **The public testnet** — M2 and M3, and not this repository's.
