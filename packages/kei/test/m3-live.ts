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
