/**
 * SPEC §6.2 — the primary design constraint. After install: a working payment,
 * no signup, no API key, no wallet extension, no dashboard.
 */

import { describe, expect, test } from 'bun:test'
import { Kei, randomSeed } from 'kei-transaction'

describe('the sixty-second test', () => {
  test('start, then pay, with no infrastructure setup in the public API', async () => {
    const node = await Kei.mock()
    const kei = await Kei.start({ node })
    const other = await Kei.start({ node: kei.client.node, seed: randomSeed() })

    await kei.faucet()
    expect(await kei.balance()).toBeGreaterThan(0)

    const receipt = await kei.send(other.address, 0.001)
    expect(receipt.amount).toBe(0.001)
    expect(receipt.hash).toMatch(/^[0-9A-F]{64}$/)

    kei.close()
    other.close()
  })

  test('the recipient never calls receive — it just arrives', async () => {
    const node = await Kei.mock()
    const payer = await Kei.start({ node })
    const payee = await Kei.start({ node, seed: randomSeed() })

    const arrived = new Promise<{ from: string; amount: number }>((resolve) => {
      payee.on('received', resolve)
    })

    await payer.faucet()
    await payer.send(payee.address, 0.25)

    const payment = await arrived
    expect(payment.from).toBe(payer.address)
    expect(payment.amount).toBe(0.25)
    expect(await payee.balance()).toBe(0.25)

    payer.close()
    payee.close()
  })

  test('sub-cent amounts work, and cost nothing', async () => {
    const node = await Kei.mock()
    const payer = await Kei.start({ node })
    const payee = await Kei.start({ node, seed: randomSeed() })

    await payer.faucet(1)
    const before = await payer.balance()
    for (let i = 0; i < 10; i++) await payer.send(payee.address, 0.001)

    expect(await payer.balance()).toBe(before - 0.01)
    // The background collector would get there on its own; sync() just makes the
    // assertion deterministic rather than timing-dependent.
    await payee.sync()
    expect(await payee.balance()).toBe(0.01)

    payer.close()
    payee.close()
  })

  test('a wallet persists across restarts through its store', async () => {
    const node = await Kei.mock()
    const storage = new Map<string, string>()
    const store = {
      read: (key: string) => storage.get(key) ?? null,
      write: (key: string, seed: string) => void storage.set(key, seed),
    }

    const first = await Kei.start({ node, storage: store })
    await first.faucet()
    first.close()

    const second = await Kei.start({ node, storage: store })
    expect(second.address).toBe(first.address)
    expect(await second.balance()).toBeGreaterThan(0)
    second.close()
  })

  test('not enough Kei is a sentence with both numbers in it', async () => {
    const node = await Kei.mock()
    const kei = await Kei.start({ node })
    const other = await Kei.start({ node, seed: randomSeed() })
    await kei.faucet(0.4)

    await expect(kei.send(other.address, 1.2)).rejects.toThrow(
      'Not enough Kei — balance is 0.4, tried to send 1.2.',
    )
    kei.close()
    other.close()
  })
})
