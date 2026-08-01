# M3 — the transport swap

M3 changes the default behind `Kei.start()` from a private `MockNode` to
`HttpNode` at `https://testnet.keicoin.org/rpc`. The public methods, types,
amounts, signing boundary, and wire contract do not move. `Kei.mock()` and
`network: 'mock'` remain explicit, hermetic choices for tests and offline work.

The public node is one best-effort Hetzner testnet node. It has weak consensus,
no uptime promise, and no monetary value. A gateway keeps the node's inherited
control RPC on loopback, allowlists the SDK actions, rate-limits requests, and
caps public faucet grants; the node also refuses control itself, so the
allowlist is not the only barrier. See kei-node's `docs/decisions-m3.md` for
that operational boundary.

It is a **dev-network** chain, because that is the only network kei-node can
start today — beta and live genesis are still placeholders and the node refuses
to run on them rather than inventing a production key. Every dev key derives
from a published phrase, so anyone can fund or reset this chain. That is fine
for M3 and not fine for M9, which opens the network to external developers and
needs the beta ceremony first.

## What did not move

The transport swap must not be visible in the API, so this is the list a reader
should be able to check:

- `Kei.start()`, `Kei.server()` and `Kei.mock()` keep their signatures and
  every `StartOptions` field keeps its meaning. The one behavioural change is
  which node `resolveNode()` returns when no `node` is given.
- `kei.network` still reports what it is actually talking to — `'testnet'` for
  the default, `'mock'` for `network: 'mock'` — so the swap is never invisible.
- Amounts stay plain decimal numbers, errors stay sentences, and the wire
  contract in `docs/rpc.md` is unchanged. M2's suites are the proof: the same
  files, the same assertions, `KEI_NODE_URL` the only switch.

## Proof, without making every unit test depend on the internet

The normal suite asserts that no-argument `Kei.start()` resolves to the canonical
testnet `HttpNode`, while all ledger tests continue to use an explicit mock.
`packages/kei/test/m3-live.ts` is the public evidence test and is deliberately
not discovered by a normal `bun test`. Run it with:

```sh
npm run test:m3-live
```

It creates fresh payer and payee keys, calls the public faucet, receives the
grant, sends 0.001 Kei, and receives it at the second account. It then runs
SPEC §6.2 verbatim — `Kei.start()` with no arguments at all — because the
hermetic twin of the sixty-second test now passes an explicit mock to stay
offline, which would otherwise leave acceptance criterion 1 asserted against no
real chain anywhere.

The existing exact M2 suites run against the same endpoint by setting only
`KEI_NODE_URL`, which is the unchanged conformance rule established by M2:

```sh
KEI_NODE_URL=https://testnet.keicoin.org/rpc bun test \
  packages/core/test/m2-node.test.ts packages/kei/test/over-http.test.ts
```

Those files needed one change to survive the third distance. A mock answers in
microseconds and a loopback node in milliseconds, but the first request to a
public endpoint pays for DNS, TCP and TLS at once — 8 s, measured, against a 5 s
default timeout — so the suite failed before asserting anything. The timeout now
follows the transport, the reachability probe moved out of `beforeAll` (which
takes no timeout) into a test that has one, and the live poll interval went from
50 ms to 250 ms: 20 requests a second is the gateway's entire per-edge budget,
so the old value would have rate-limited a second wallet doing the same thing.
