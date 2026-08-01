# M3 — the transport swap

M3 changes the default behind `Kei.start()` from a private `MockNode` to
`HttpNode` at `https://testnet.keicoin.org/rpc`. The public methods, types,
amounts, signing boundary, and wire contract do not move. `Kei.mock()` and
`network: 'mock'` remain explicit, hermetic choices for tests and offline work.

The public node is one best-effort Hetzner testnet node. It has weak consensus,
no uptime promise, and no monetary value. A gateway keeps the node's inherited
control RPC on loopback, allowlists the SDK actions, rate-limits requests, and
caps public faucet grants. See kei-node's `docs/decisions-m3.md` for that
operational boundary.

## Proof, without making every unit test depend on the internet

The normal suite asserts that no-argument `Kei.start()` resolves to the canonical
testnet `HttpNode`, while all ledger tests continue to use an explicit mock.
`packages/kei/test/m3-live.ts` is the public evidence test and is deliberately
not discovered by a normal `bun test`. Run it with:

```sh
npm run test:m3-live
```

It creates fresh payer and payee keys, calls the public faucet, receives the
grant, sends 0.001 Kei, and receives it at the second account. The existing exact
M2 suites can be run against the same endpoint by setting only `KEI_NODE_URL`,
which is the unchanged conformance rule established by M2.
