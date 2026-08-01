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
number, and `test/scaffold.test.ts` parses everything it emits on every `bun test`.

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

The generated shop is one `kei.pay({ …, memo })` and one `kei.onPayment` handler,
which is §6.7's headline flow and the shortest honest purchase in the SDK: the
player signs the payment, the issuer signs the delivery, and the memo says what
was ordered.

Charging in the game's own currency is the other obvious choice and it is
strictly more code, because a token transfer carries no memo (decisions-m0 §4) —
the intent has to be recorded first and matched to the arrival, which is what
Button's shop does. The generated README says how to switch and why it costs more
lines. Starting with the two-signature payment also puts the sub-cent
micropayment — the thing a card processor cannot do at all — in the first thing a
developer reads.

Clicks are paid by `commit` rather than `mint`, even though the batch is always
one player. Minting per player makes the issuer's chain a global write lock
(SPEC §5.5), and the point of writing it this way in a scaffold is that the code
does not change when there are a thousand claimants instead of one.

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
