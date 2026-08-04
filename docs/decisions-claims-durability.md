# Claim-bundle durability decisions

SPEC §5.5 says a player may claim later — “next login is fine” — but a Merkle
root cannot reproduce the off-chain sibling path needed to do that. [Issue #83][#83]
therefore adds an SDK storage boundary for pending `ClaimBundle` values. It does
not change consensus, RPC, blocks, proofs, seed custody, or issuer custody.

## 1. The boundary is root-addressable and caller-owned

`ClaimStore` has four deliberately small operations: list roots, read one raw
record, write one raw record, and remove one raw record. Every operation receives
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

`claims.add()` validates and serialises a bundle, writes it, then reads the exact
bytes back before automatic claiming begins. A refusal or mismatch is a typed
`KeiError` and no claim is signed. A successful claim is confirmed by the node
before the stored record is removed, and removal is read back too.

This ordering leaves a safe duplicate after a crash between ledger acceptance
and deletion. On the next start, `hasClaimed(address, root)` proves that no new
signature is needed and reconciliation removes the record. Closed and missing
roots are removed the same way. Multi-tab submissions may race; ledger
idempotency and later reconciliation remain the authority for submissions.

## 3. Stored input is versioned, bounded, and fail-closed

Each value is JSON `{ version: 1, bundle }`. The public finite limits are:

| Limit | Value |
|---|---:|
| Pending roots per wallet/network | `MAX_PENDING_CLAIMS = 128` |
| Serialised bytes per record | `MAX_CLAIM_RECORD_BYTES = 16,384` |
| Sibling hashes per proof | `MAX_CLAIM_PROOF_LENGTH = 128` |

Hydration asks for at most 129 roots so overflow is observable without loading
an unbounded set. Roots deduplicate before reads. Malformed roots, JSON,
envelopes, bundles, unsupported versions, oversized records, and excessive
counts are not placed in the signing set. Diagnostics are themselves bounded to
32 and contain codes, roots, and fixed remediation sentences — never raw stored
values, seeds, keys, signatures, or adapter exception text.

`claims.storageStatus()` is the honest typed report. It includes the adapter's
`'persistent' | 'session'` declaration, the active namespace, and diagnostics.
A custom store is trusted code about whether its backing service really
survives a restart; the SDK can verify immediate read-back, not a future disk.

The browser adapter encodes all records for one wallet/network in a single
localStorage value and serialises every read, write, and removal for that
namespace through the origin-wide Web Locks API. A mutation therefore reloads
the latest snapshot while holding the exclusive lock: at 127 records, two tabs
adding different roots cannot both report success and later lose one. One write
reaches 128; the other receives a typed refusal with capacity/concurrency
guidance. A later writer cannot publish a stale namespace over an acknowledged
proof.

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
