# M1 decisions

M0 built the API against an in-process mock. M1 put a game in a browser in front
of it, and a browser is where assumptions go to die: three of these entries are
bugs that no amount of test-suite green would have caught, because Node and Bun
do not care about the things a browser cares about.

As with [`decisions-m0.md`](decisions-m0.md), nothing here overrides SPEC.md.

---

## 1. The mock node is served over HTTP

**New: `mockRpcHandler` in `@kei/core`.**

SPEC §6.3 puts the player in a browser and forbids the issuer seed from ever
reaching one, so a real game is *always* two processes. Two processes cannot
share a `MockNode` object. They can share a URL.

`mockRpcHandler({ node })` is a plain `Request → Response` function implementing
[`docs/rpc.md`](rpc.md), and it starts no server itself — no `Bun.serve`, no
`node:http` — so `@kei/core` stays runtime-agnostic and the caller decides what
listens. It answers browser preflight and sets `access-control-allow-origin: *`,
because a mock node exists to be reached from a game on some other dev port.

The gain beyond the demo: docs/rpc.md is now **executed** rather than described.
`packages/core/test/mock-server.test.ts` drives `HttpNode` against it, and
`packages/kei/test/over-http.test.ts` runs the whole economy — issue, top-up,
mint, transfer, item, commit, parallel claims — between two clients that share
nothing but a URL. That is the M3 rehearsal, and it means M3 changes what is
behind the URL and nothing above it.

## 2. `network` accepts `'mock'`

`StartOptions.network` was `'testnet' | 'mainnet'`. Once a mock can be served, a
client pointed at one has to be able to say so — calling it `'testnet'` would
undo decisions-m0 §11, whose whole point is that a mock is never invisible.

Nothing checks this against the node. **M3 owes a `version`-style action** so the
SDK can ask a node what it is rather than taking the developer's word for it;
that belongs with the milestone where a real testnet exists to disagree with.

## 3. `HttpNode` binds `fetch` — a browser-only bug

`this.fetchImpl = impl` and then `this.fetchImpl(...)` works in Node and Bun and
throws `Illegal invocation` in a browser, because a browser's `fetch` insists on
being called with `window` as its receiver. It surfaced as
`Could not reach the Kei node at …`, which is a maximally misleading error for a
node that is answering perfectly.

Fixed with `impl.bind(globalThis)`, and there is now a test asserting the
receiver. Worth stating plainly: **110 passing tests did not catch this**, and
the only reason it was caught at all is that M1 drove the game in a real browser
rather than trusting the suite.

## 4. Commits are salted, so two identical batches are two drops

**This is the important one.**

A commit root was a pure function of who is owed what. So a game that pays the
same player the same amount twice — which is not an edge case, it is a clicker's
Tuesday — builds the same tree twice, and the ledger rejects the second with
`Root … has already been published`.

`buildCommit` now adds a **salt leaf**: 32 random bytes, domain-separated with
its own tag, appended as an extra leaf. Consequences:

- Two identical batches produce different roots. Both claim normally.
- **The node is unaffected.** It verifies the claimant's leaf against the root
  and never enumerates the others, so a salt leaf is just another sibling in a
  proof. No protocol change, and nothing for M2 to implement.
- Nothing can claim it: a salt leaf is a hash of 32 bytes under tag `0x02`, not
  of `pubkey ‖ asset ‖ amount` under tag `0x00`.
- `count` and `total` still describe recipients, because the salt is not an
  entitlement.
- `salt` is exposed on the built commit, and can be passed in to reproduce a
  specific root.

Random by default was chosen over opt-in: a root that collides is a failure the
developer cannot see coming, and determinism bought nothing, since the ledger
rejects a duplicate root anyway.

## 5. What "playable single-player" required

The milestone is *"Button playable single-player with fake money"*, and single
player still means two processes (§6.3). `button/` therefore runs one `bun run dev`
that serves three things on distinct paths — the mock node at `/rpc`, the issuer
at `/game/*`, the client at `/` — which is one process because it is one command,
not because they belong together. The browser reaches the node directly and signs
everything it writes; the game server never sees a player's key.

Two things the demo settles that the SDK does not:

- **Presses are banked, not minted.** Minting per press would put every reward on
  the issuer's chain and make it a global write lock. The server batches every
  player who banked in the same window into one `commit`, and each player claims
  from their own chain (SPEC §5.5). With one player it is a batch of one and the
  code is identical, which is the property worth having.
- **Buying is order-then-arrival.** An asset transfer carries no memo
  (decisions-m0 §4), so the shop records the intent, then matches the arrival to
  it, and delivers only once the chain says the coins landed.

The client counts its own presses, because in single-player nothing else can see
them. There is a rate ceiling and it is not a fix — M8's Colyseus layer makes
presses observed. It is written down in `button/README.md` rather than hidden.

## 6. Babylon.js 9 needs its extensions asked for by name

Not a Kei decision, but it cost an afternoon and the next person should not pay
it again.

Babylon 9 is assembled from pure modules plus `Register*` functions that attach
them. Its `sideEffects` list does not cover all of them, so a bundler legitimately
drops a bare side-effect import — **including the barrel's**. The failures are
silent-ish and far from the cause:

| Missing | Symptom |
|---|---|
| `RegisterFullEngineExtensions` | every light dies on `createUniformBuffer is not a function` |
| `RegisterShadowGeneratorSceneComponent(ShadowGenerator)` | `createRenderTargetTexture is not a function` |
| `RegisterRay` | **`scene.pick` silently misses every mesh** — nothing in the world is clickable, and nothing throws |

`button/src/world.ts` imports from `@babylonjs/core/pure.js` and calls the three
registrars inside `createWorld()`, not at module scope: the bundler orders
top-level calls before the classes they patch have finished initialising.

---

## What M2 inherits from M1

- Serve [`docs/rpc.md`](rpc.md) exactly. `mockRpcHandler` is the reference
  implementation, and the two test files above are the conformance suite.
- Nothing new for claims: the salt is an SDK-side tree construction and the
  verification rule is unchanged.
- A `version`-style action for a node to report its own network (§2 above).
