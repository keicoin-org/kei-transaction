/**
 * M3's public evidence test. It intentionally has no `.test` suffix so the
 * normal hermetic suite never depends on the internet. Run `npm run test:m3-live`.
 */
import { expect, test } from 'bun:test'
import { Kei, randomSeed } from 'kei-transaction'

test('the default client faucets, receives, and sends on the public testnet', async () => {
  const payer = await Kei.start({ seed: randomSeed() })
  const payee = await Kei.start({ seed: randomSeed() })
  try {
    expect(payer.network).toBe('testnet')
    await payer.faucet(1)
    expect(await payer.balance()).toBe(1)

    const sent = await payer.send(payee.address, 0.001)
    expect(sent.hash).toMatch(/^[0-9A-F]{64}$/)
    await payee.sync()
    expect(await payee.balance()).toBe(0.001)
  } finally {
    payer.close()
    payee.close()
  }
}, 120_000)

test('SPEC §6.2, run verbatim against the public testnet', async () => {
  // The sixty-second test is `Kei.start()` with no arguments at all — no node,
  // no seed, no network. Its hermetic twin passes an explicit mock so the normal
  // suite stays offline, which leaves this the only place the literal snippet
  // from the README is executed against a real chain. Acceptance criterion 1.
  const kei = await Kei.start()
  const payee = await Kei.start({ seed: randomSeed() })
  try {
    expect(kei.network).toBe('testnet')
    await kei.faucet()
    expect(await kei.balance()).toBeGreaterThan(0)

    const receipt = await kei.send(payee.address, 0.001)
    expect(receipt.to).toBe(payee.address)
    expect(receipt.amount).toBe(0.001)
  } finally {
    kei.close()
    payee.close()
  }
}, 120_000)
