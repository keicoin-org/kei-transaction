/**
 * The one id both parties hold.
 *
 * A payment writes two blocks on two chains: the payer's send and the payee's
 * receive. `pay()` returns the send hash and the payer attaches it to an order,
 * so the send hash is what the two sides can agree on. `onPayment` reports the
 * receive block it just wrote, which the payer has never seen — so unless the
 * event also carries the send hash, every issuer has to recover it with a
 * `blockInfo` read whose failure silently drops the payment.
 */

import { describe, expect, test } from 'bun:test'
import { Kei, randomSeed } from 'kei-transaction'

describe('correlating a payment across the two chains it touches', () => {
  test('the payee is handed the same send hash pay() returned to the payer', async () => {
    const node = await Kei.mock()
    const payer = await Kei.start({ node })
    const payee = await Kei.start({ node, seed: randomSeed() })

    const arrived = new Promise<{ hash: string; sendHash: string }>((resolve) => {
      payee.on('received', resolve)
    })

    await payer.faucet()
    const receipt = await payer.pay({ to: payee.address, amount: 0.05 })

    const payment = await arrived
    expect(payment.sendHash).toBe(receipt.hash)
    // The receive block stays what it was: repointing `hash` would silently
    // change every existing integration's idempotency key.
    expect(payment.hash).not.toBe(receipt.hash)

    payer.close()
    payee.close()
  })

  test('the send hash names the block the payer actually wrote', async () => {
    const node = await Kei.mock()
    const payer = await Kei.start({ node })
    const payee = await Kei.start({ node, seed: randomSeed() })

    const arrived = new Promise<{ hash: string; sendHash: string }>((resolve) => {
      payee.on('received', resolve)
    })

    await payer.faucet()
    await payer.pay({ to: payee.address, amount: 0.05 })
    const payment = await arrived

    const send = await payee.client.node.blockInfo(payment.sendHash)
    expect(send?.account).toBe(payer.address)
    const receive = await payee.client.node.blockInfo(payment.hash)
    expect(receive?.account).toBe(payee.address)
    // The read every issuer was doing by hand to get back to the send hash.
    expect(receive?.type === 'state' ? receive.link : undefined).toBe(payment.sendHash)

    payer.close()
    payee.close()
  })

  test('an asset transfer carries it too', async () => {
    const node = await Kei.mock()
    const game = await Kei.server({ node, seed: randomSeed() })
    const player = await Kei.start({ node, seed: randomSeed() })

    await game.faucet(2_000)
    const coins = await game.token.issue({
      name: 'Coins', symbol: 'COIN', decimals: 0, maxSupply: 1_000_000,
      transfer: 'open', swap: 'one-way', rate: 1_000,
    })
    await coins.mint(player.address, 50)
    await player.sync()

    const arrived = new Promise<{ hash: string; sendHash: string }>((resolve) => {
      game.client.on('asset-received', resolve)
    })
    const held = await player.token('COIN', game.address)
    const sent = await held.transfer(game.address, 20)
    await game.sync()

    const received = await arrived
    expect(received.sendHash).toBe(sent.hash)
    expect(received.hash).not.toBe(sent.hash)

    game.close()
    player.close()
  })
})
