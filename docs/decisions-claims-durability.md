# Claim-bundle durability decisions

SPEC §5.5 says a player may claim later — “next login is fine” — but a Merkle
root cannot reproduce the off-chain sibling path needed to do that. [Issue #83][#83]
therefore adds an SDK storage boundary for pending `ClaimBundle` values. It does
not change consensus, RPC, blocks, proofs, seed custody, or issuer custody.

## 1. The boundary is root-addressable and caller-owned

`ClaimStore` keeps its legacy list/read/write/remove surface and adds two
optional capability methods: atomically retain-and-admit exact bytes, and read
only bytes carrying that adapter-level admission authority. Every operation receives
`{ network, address }`; the root is the logical record key. The browser adapter
stores one versioned, bounded namespace value at
`kei:claim-store:v1:<network>:<address>`, while a database adapter can map the
same identity to its own primary key.

The default is a fresh memory store, preserving the old process-local behaviour
and reporting `durability: 'session'`. Reload recovery is opt-in through
`Kei.start({ claimStore })`; `createBrowserClaimStore(localStorage)` is the
included durable adapter. Node and server callers can supply their own adapter.
The SDK never uploads proofs or takes custody on an issuer's behalf.

## 2. Retention is established before signing

Every signing entry point, including direct `claims.claim(bundle)`, validates
and bounds a bundle, then asks the adapter to atomically retain and admit its
exact bytes. The SDK reads those bytes back through the separate admitted-only
surface before signing. A refusal or mismatch is a typed `KeiError` and no claim is signed. A successful claim is
confirmed by the node before the stored record is removed, and removal is read
back too.

This ordering leaves a safe duplicate after a crash between ledger acceptance
and deletion. On the next start, `hasClaimed(address, root)` proves that no new
signature is needed and reconciliation removes the record. Closed and missing
roots are removed the same way. Multi-tab submissions may race; ledger
idempotency and later reconciliation remain the authority for submissions.

## 3. Stored input is versioned, bounded, and fail-closed

Each value is JSON `{ version: 3, state, bundle, integrity }`. The
domain-separated BLAKE2b-256 digest detects accidental corruption; it is not a
keyed authenticator and does not grant admission. Hydration reads only values
the adapter reports through `readAdmitted`. A rejected or mismatched raw value
therefore remains non-signable even if it is internally valid and recomputes
its own digest. The SDK does not delete such a value during failure cleanup,
because another wallet instance may have admitted the same root concurrently.
The public finite limits are:

| Limit | Value |
|---|---:|
| Pending roots per wallet/network | `MAX_PENDING_CLAIMS = 128` |
| Serialised bytes per record | `MAX_CLAIM_RECORD_BYTES = 16,384` |
| Sibling hashes per proof | `MAX_CLAIM_PROOF_LENGTH = 128` |
| Decimal digits in a raw amount | `MAX_CLAIM_AMOUNT_DIGITS = 39` (unsigned 128-bit) |

Amount length, proof count, and every fixed-size hash are checked before the
envelope is serialised, so the record ceiling is also an allocation ceiling.
Hydration asks for at most 129 roots so overflow is observable without loading
an unbounded set. Roots deduplicate before reads. Malformed roots, JSON,
envelopes, bundles, unsupported versions, oversized records, and excessive
counts are not placed in the signing set. Diagnostics are themselves bounded to
32 and contain codes, roots, and fixed remediation sentences — never raw stored
values, seeds, keys, signatures, or adapter exception text.

`claims.storageStatus()` is the honest typed report. It includes the adapter's
`'persistent' | 'session'` declaration, the active namespace, and diagnostics.
A custom store is trusted code about whether its backing service really
survives a restart and whether its optional admission capability is atomic.
Persistent custom adapters without both capability methods fail closed before
mutation with `claim-store-admission-unsupported`. The SDK does not claim
protection from an adapter that violates the capability contract.

The browser adapter encodes all records for one wallet/network in a single
localStorage value and serialises every read, write, admission, and removal for
that namespace through the origin-wide Web Locks API. Admission reloads
the latest snapshot while holding the exclusive lock: at 127 records, two tabs
adding different roots cannot both report success and later lose one. One write
reaches 128; the other receives a typed refusal with capacity/concurrency
guidance. A later writer cannot publish a stale namespace over an acknowledged
proof.

Browser namespace schema v2 stores the admission marker separately from the
envelope bytes. Schema-v1 records and claim-envelope v1/v2 records have no such
authority and are never signed automatically. Their raw bytes remain available
for an explicit re-add of the original bundle, which rewrites and admits the v3
record safely.

`createBrowserClaimStore(localStorage)` discovers `navigator.locks`. Browsers
without Web Locks fail closed: records are not hydrated or signed, writes are
refused, and `storageStatus()` reports a bounded diagnostic. Tests and embedded
browser runtimes can inject one shared `ClaimWebLockManager`; separate managers
do not coordinate and are not a valid persistent adapter configuration.

## 4. Startup retries without making a transient node error fatal

The umbrella starts its client, awaits claim hydration, reconciles dead records,
and attempts retained claims when `autoClaim` is enabled. A node or adapter
failure leaves the bundle stored and adds `claim-retry-failed`; wallet startup
still succeeds so the caller can inspect status and call `claims.claimAll()`
after recovery. With `autoClaim: false`, startup hydrates and reconciles but
leaves live entitlements in `pending()`.

## 5. Privacy and scope

A bundle contains asset, amount, root, and proof metadata. It is not a signing
secret and only the committed account can use its leaf, but it can reveal what a
player was awarded. Browser storage is therefore a recovery mechanism, not a
backup, and applications should choose a store consistent with their privacy
model. No seed or private key crosses this boundary, and the seed store is not
overloaded with claim JSON.

This source PR changes no package version and publishes nothing. Release
coordination remains separate.

[#83]: https://github.com/keicoin-org/kei-transaction/issues/83
