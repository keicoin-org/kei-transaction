# Wallet durability decisions

SPEC §6.4 says the player's seed is generated client-side and persisted in
browser storage, and that "cleared site data must not silently destroy a
player's holdings". The first implementation did the first half and swallowed
the second: `BrowserSeedStore.write()` caught every `setItem()` failure and
returned `void`, and `Kei.start()` derived a usable wallet from a seed nothing
had kept. Private browsing, disabled storage, a full quota, and browser policy
all reach that path, and the cost is not a warning — it is a funded address that
the next reload replaces with a different one.

This records what closing [#34] decided, and what was deliberately not done.

Nothing here touches consensus, custody, or the wire contract. No block, hash,
or RPC changes; every decision below is in the SDK's own surface.

[#34]: https://github.com/keicoin-org/kei-transaction/issues/34

---

## 1. A write reports what it was worth, and is verified by reading it back

`SeedStore.write()` now returns `SeedWriteResult | void`. Returning a result is
how a store says a write did not land; returning nothing still works, and the
seed is read back and compared instead.

Both halves are load-bearing:

- **The result** is the only way an in-memory store can be honest. A memory map
  reads back perfectly, so read-after-write alone would call it durable — which
  is exactly the fallback that made this bug reload-lossy in the first place.
- **The read-back** is the only way a browser store can be trusted. `setItem()`
  can return without throwing and still not have stored anything, and the seed
  compared out of `getItem()` is the cheapest possible proof that it did.

`status?()` covers the third case, a seed *read* rather than written: restoring
from process memory is a session wallet, restoring from `localStorage` is not,
and the store is the only thing that knows which.

A custom store is trusted code at this boundary: the SDK can verify that its
current `write()` is immediately readable and can honour a session-only
`status()`, but it cannot prove what the store's backing service will do after a
process restart. Even a write that reports `persistent` is read back; a custom
store cannot bypass that observable check merely by returning the result it
wants.

**Backward compatible on purpose.** `write(): void` is still a valid
implementation and the existing `{ read, write }` object literal in
`sixty-seconds.test.ts` — the shape a game would have copied — still typechecks
and still works. A store that cannot survive a reload opts into saying so.

## 2. `Kei.start()` reports, and refuses only when asked

`kei.custody` is `{ durability, origin, reason?, message }`:

| | |
|---|---|
| `durability` | `'persistent'` — written and read back. `'session'` — memory only. `'supplied'` — the caller's seed, and the SDK stored nothing |
| `origin` | `'generated'`, `'restored'`, `'supplied'`, `'environment'` |
| `reason` | why it is session-only: `no-browser-storage`, `storage-write-refused`, `storage-unreadable`, `store-session-only` |
| `message` | one sentence stating the fix, built from the codes and never from the seed |

**`'supplied'` is a third durability value rather than a boolean beside two.**
The issue sketched `{ durability: 'persistent' | 'session' }`, and a caller-
supplied seed fits neither: it is not stored by the SDK, so calling it
persistent is a claim about somebody else's disk, and calling it session is a
warning about a seed the caller already holds. The distinction is also an
acceptance criterion in its own right — a supplied seed must be distinguishable
from an auto-generated one — so it belongs in the type rather than in prose
about `origin`.

**Throwing is opt-in (`requireDurableSeed`), not the default.** A session-only
wallet is still the right outcome for a demo, a test, a Node process, and a
player in private browsing; the defect was never that it exists but that it was
indistinguishable from a saved one. Making it throw by default would break every
one of those callers to fix a reporting problem. So the default reports, the
panel warns, and a game whose wallet is meant to hold something asks for the
refusal explicitly — where the error arrives before the address does, rather
than after it was funded.

## 3. A seed browser storage refused is kept for the rest of the session

This is the smallest fix in the change and the one that saves the most money.
Before it, a failed write left the seed only in a local variable: a second
`Kei.start()` on the same page — two components, a re-mount, a router — generated
a *second* wallet and quietly abandoned whatever the first had been sent, inside
one session, with no reload involved.

`BrowserSeedStore` now copies a seed it could not save into a session map scoped
to that storage object and store key (§7) and reports `'session'` anyway. Stable
identity and honest durability are separate properties, and this buys the first
without claiming the second.

## 4. The panel warns first, and carries the backup path inside the warning

SPEC §6.4 asks for a backup prompt "once a wallet holds meaningful value". The
panel cannot see value arrive before it arrives, and a warning shown after the
first payment is a warning shown too late — so the session-only notice renders
unconditionally, as the panel's first child, with `role="alert"` and no dismiss
control.

The seed-reveal section is **moved into** the notice rather than duplicated
beside it, so the sentence naming the risk and the control answering it are one
thing. The §6.6 friction is unchanged inside it: confirm, then press-and-hold,
and the seed is in the DOM only while the hold lasts.

`reveal: 'never'` is the case worth naming: there is no backup path to offer, so
the notice says the wallet cannot be saved at all and should be kept empty until
the game turns backup on. That is the §6.6 trade-off — "the player cannot take
their assets anywhere else" — arriving where it actually bites.

`panel.element.dataset.durability` carries the same fact for a game that draws
its own UI or wants to disable its own buy button. The panel deliberately does
not gate the balance display: hiding a balance a player owns is not a safety
feature, and the panel has no "accept value" action of its own to block.

**`WalletPanelKei.custody` is optional.** `@keicoin/wallet` depends on
`@keicoin/core` and not on the umbrella, so the type is declared structurally,
and making it required would break every hand-assembled object typed as
`WalletPanelKei`. Absent custody renders nothing, because a panel that cannot
see the fact must not invent it.

## 5. `wallet.summary()` does not carry it, and should not

The headless summary is a read of the chain, refreshed on every block this
wallet writes or collects. Durability is none of those things: it is fixed the
moment `Kei.start()` resolves and cannot change while the page is open. Putting
it in the summary would make one fact live in two places, one of them behind an
`await` and a change event, for no gain — `kei.custody` is synchronous, always
present, and the panel already reads it.

## 6. No seed anywhere in any of it

Every message is composed from `origin` and `reason` alone — there is no
interpolation of a seed, a key, or an address into any of them, and
`KeiError` scrubbing (`registerSecret`, called for every seed a `KeiClient` is
built with) remains the backstop rather than the mechanism.

`durability.test.ts` asserts it directly: `containsSecret()` over
`custody.message`, over `JSON.stringify(custody)`, over the thrown error's
message and stack, and over everything `console` was handed during the failing
start. The panel suite asserts the same over the rendered DOM and every
attribute in it, before and after a reveal.

## 7. The seed kept for a refused write is scoped by storage *and* key

A page can hold wallets for more than one network, and the store key is
`kei:seed:<network>`. A single module-level seed-and-reason pair would let
`kei:seed:mock` failing a write decide what `kei:seed:testnet` reports about
itself — the wrong wallet returned from a read, and the wrong `reason` on a
custody record. The session copy is therefore a `Map` from store key to
`{ seed, reason }`: one entry, so identity and durability travel together and
neither crosses a key.

A key alone is not an identity, though. Two stores over the *same*
`localStorage` object are one page and have to share what neither could save —
that is the whole point, and it is what keeps a second `Kei.start()` on one
address. Two stores over *different* storage objects are not one page, and
nothing about storage `A` refusing `kei:seed:testnet` says anything about
storage `B`; handing `B` the seed `A` could not keep would be inventing a wallet
for it. So the maps hang off a `WeakMap` keyed by the storage object itself, and
a store gets the map its own storage owns. Weak because a storage object that
goes away should take its kept seeds with it, and because the thing a reload
actually is — a fresh runtime — starts with none of this.

The same argument is why `readDurability` treats a `status()` that *throws*
differently from one that is absent. Absent is the older store shape, and the
read-back stands behind it. A `status()` that throws is a store that meant to
answer and could not, so it is reported as session: on a data-loss boundary the
unverifiable case has to fail towards the warning, not towards the promise.

`globalThis.localStorage` is read inside the `try` for the same class of reason:
where browser policy blocks site data for an origin, the *property access*
throws a `SecurityError` before any method on it is called, so guarding only
`getItem`/`setItem` would let a `Kei.start()` throw out of `defaultSeedStore()`.
Blocked storage is the `no-browser-storage` case, and nothing is written
anywhere.

## 8. This is source, docs and tests — no version moves here

This decision PR changed no package version or dependency range and published
nothing. At that point `@keicoin/wallet` remained at `0.4.2` and the umbrella at
`@keicoin/wallet@^0.4.2`; the panel's `custody` field was optional, so those
published artifacts still satisfied each other. The follow-up coordinated
release later published this work in `@keicoin/wallet@0.5.0` and
`kei-transaction@0.7.0` on 4 August 2026. Keeping that move in its own release PR,
the way [#32] was followed by [#33], avoided claiming a version while the
feature branch was still open.

[#32]: https://github.com/keicoin-org/kei-transaction/pull/32
[#33]: https://github.com/keicoin-org/kei-transaction/pull/33
