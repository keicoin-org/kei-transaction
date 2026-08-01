/**
 * Atomic swaps (SPEC §9.2), tested at the node boundary — these are the
 * invariants the real node fork has to reproduce at M5, the same way
 * ledger.test.ts pins §5.6.
 *
 * Three things this file exists to prove, adversarially rather than just on the
 * happy path:
 *
 *   - Only the offerer ever locks anything, and it is their own asset — so the
 *     same sword cannot be offered twice, and nobody but the offerer can free it.
 *   - Accept and cancel race for one locked entry across two different chains,
 *     and whichever the node processes first wins outright — the loser's block
 *     changes nothing, not even partially.
 *   - Resubmitting a block the node already applied — the shape a client sees
 *     after a dropped connection or a restart — is a no-op, not a double-spend.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  KEI_ASSET,
  MOCK_THRESHOLDS,
  MockNode,
  ZERO_HASH,
  deriveAssetId,
  generateWork,
  hashBlock,
  issuanceBurn,
  keyPairFromSeed,
  publicKeyFromAddress,
  signHash,
  tierFor,
  workRoot,
  type Block,
  type BlockBody,
  type KeyPair,
  type TransferPolicy,
} from '@keicoin/core'

let node: MockNode
let issuer: KeyPair
let alice: KeyPair
let bob: KeyPair
let eve: KeyPair

/** Signs and submits a body as `keys`, filling in work for its tier. */
async function submit(keys: KeyPair, body: BlockBody): Promise<string> {
  const hash = hashBlock(body)
  const block: Block = {
    ...body,
    work: generateWork(workRoot(body), BigInt(MOCK_THRESHOLDS[tierFor(body)])),
    signature: await signHash(keys.privateKey, hash),
  }
  const result = await node.process(block)
  return result.hash
}

async function draft(keys: KeyPair): Promise<{ previous: string; balance: string; representative: string }> {
  const info = await node.accountInfo(keys.address)
  return {
    previous: info?.frontier ?? ZERO_HASH,
    balance: info?.balance ?? '0',
    representative: info?.representative ?? keys.address,
  }
}

async function fund(keys: KeyPair, kei: number): Promise<void> {
  await node.faucet(keys.address, (BigInt(kei) * 10n ** 18n).toString())
  for (const receivable of await node.receivables(keys.address)) {
    const context = await draft(keys)
    await submit(keys, {
      type: 'state',
      subtype: context.previous === ZERO_HASH ? 'open' : 'receive',
      account: keys.address,
      previous: context.previous,
      representative: context.representative,
      balance: (BigInt(context.balance) + BigInt(receivable.amount)).toString(),
      link: receivable.hash,
    })
  }
}

let symbolCounter = 0

/** Issues a fresh asset from `issuer`, one unique symbol per call. */
async function issueAsset(transfer: TransferPolicy): Promise<string> {
  symbolCounter += 1
  const symbol = `S${symbolCounter}`
  const context = await draft(issuer)
  const info = await node.accountInfo(issuer.address)
  const ordinal = (info?.issuedCount ?? 0) + 1
  await submit(issuer, {
    type: 'asset',
    account: issuer.address,
    previous: context.previous,
    representative: context.representative,
    balance: (BigInt(context.balance) - issuanceBurn(ordinal - 1)).toString(),
    op: { kind: 'issue', name: symbol, symbol, decimals: 0, maxSupply: null, transfer, swap: 'off' },
  })
  return deriveAssetId(issuer.publicKey, symbol)
}

async function mint(asset: string, to: string, amount: string): Promise<void> {
  const context = await draft(issuer)
  await submit(issuer, {
    type: 'asset',
    account: issuer.address,
    previous: context.previous,
    representative: context.representative,
    balance: context.balance,
    op: { kind: 'mint', asset, to, amount },
  })
}

/** Collects every pending receivable of `asset` into `keys`'s spendable balance. */
async function receiveAsset(keys: KeyPair, asset: string): Promise<void> {
  for (const receivable of await node.receivables(keys.address)) {
    if (receivable.asset !== asset) continue
    const context = await draft(keys)
    await submit(keys, {
      type: 'asset',
      account: keys.address,
      previous: context.previous,
      representative: context.representative,
      balance: context.balance,
      op: { kind: 'asset_receive', link: receivable.hash },
    })
  }
}

/** Collects every pending Kei receivable into `keys`'s spendable balance. */
async function receiveKei(keys: KeyPair): Promise<void> {
  for (const receivable of await node.receivables(keys.address)) {
    if (receivable.asset !== KEI_ASSET) continue
    const context = await draft(keys)
    await submit(keys, {
      type: 'state',
      subtype: context.previous === ZERO_HASH ? 'open' : 'receive',
      account: keys.address,
      previous: context.previous,
      representative: context.representative,
      balance: (BigInt(context.balance) + BigInt(receivable.amount)).toString(),
      link: receivable.hash,
    })
  }
}

async function offerSword(owner: KeyPair, asset: string, wantAmount: string, extra: Record<string, unknown> = {}) {
  const context = await draft(owner)
  return submit(owner, {
    type: 'asset',
    account: owner.address,
    previous: context.previous,
    representative: context.representative,
    balance: context.balance,
    op: { kind: 'swap_offer', asset, amount: '1', wantAsset: KEI_ASSET, wantAmount, ...extra },
  })
}

async function acceptOffer(taker: KeyPair, offer: string, pay: bigint) {
  const context = await draft(taker)
  return submit(taker, {
    type: 'asset',
    account: taker.address,
    previous: context.previous,
    representative: context.representative,
    balance: (BigInt(context.balance) - pay).toString(),
    op: { kind: 'swap_accept', offer },
  })
}

async function cancelOffer(owner: KeyPair, offer: string) {
  const context = await draft(owner)
  const locked = await node.swapOffer(offer)
  const refund = locked?.asset === KEI_ASSET ? BigInt(locked.amount) : 0n
  return submit(owner, {
    type: 'asset',
    account: owner.address,
    previous: context.previous,
    representative: context.representative,
    balance: (BigInt(context.balance) + refund).toString(),
    op: { kind: 'swap_cancel', offer },
  })
}

beforeEach(async () => {
  node = await MockNode.create()
  issuer = await keyPairFromSeed('A1'.repeat(32))
  alice = await keyPairFromSeed('B2'.repeat(32))
  bob = await keyPairFromSeed('C3'.repeat(32))
  eve = await keyPairFromSeed('D4'.repeat(32))
  await fund(issuer, 2_000)
  await fund(alice, 2_000)
  await fund(bob, 2_000)
  await fund(eve, 2_000)
})

async function swordForAlice(transfer: TransferPolicy = 'open'): Promise<string> {
  const asset = await issueAsset(transfer)
  await mint(asset, alice.address, '1')
  await receiveAsset(alice, asset)
  return asset
}

describe('locking is the offerer\'s own asset, and only the offerer\'s (SPEC §9.2, problem 1)', () => {
  test('offering Kei debits it out of the spendable balance immediately', async () => {
    const asset = await swordForAlice()
    const lockAmount = 10n ** 18n
    const context = await draft(bob)
    await submit(bob, {
      type: 'asset',
      account: bob.address,
      previous: context.previous,
      representative: context.representative,
      balance: (BigInt(context.balance) - lockAmount).toString(),
      op: { kind: 'swap_offer', asset: KEI_ASSET, amount: lockAmount.toString(), wantAsset: asset, wantAmount: '1' },
    })
    const after = await node.accountInfo(bob.address)
    expect(BigInt(after?.balance ?? '0')).toBe(2_000n * 10n ** 18n - lockAmount)
  })

  test('a block that understates the Kei lock is rejected — the balance is asserted, not trusted', async () => {
    const asset = await swordForAlice()
    const context = await draft(bob)
    await expect(
      submit(bob, {
        type: 'asset',
        account: bob.address,
        previous: context.previous,
        representative: context.representative,
        // Declares locking 1 Kei but leaves the balance untouched.
        balance: context.balance,
        op: { kind: 'swap_offer', asset: KEI_ASSET, amount: (10n ** 18n).toString(), wantAsset: asset, wantAmount: '1' },
      }),
    ).rejects.toThrow(/must leave a Kei balance of/)
  })

  test('offering an asset moves it out of holdings, not just a promise to move it', async () => {
    const asset = await swordForAlice()
    expect(await node.holderBalance(asset, alice.address)).toBe('1')
    await offerSword(alice, asset, (10n ** 18n).toString())
    expect(await node.holderBalance(asset, alice.address)).toBe('0')
    expect(await node.holdings(alice.address)).toEqual([])
  })

  test('the same sword cannot be offered twice — it is not in the spendable balance the second time', async () => {
    const asset = await swordForAlice()
    await offerSword(alice, asset, (10n ** 18n).toString())
    await expect(offerSword(alice, asset, (10n ** 18n).toString())).rejects.toThrow(/insufficient|balance/i)
  })

  test('an offer names its own author as counterparty is refused up front', async () => {
    const asset = await swordForAlice()
    await expect(
      offerSword(alice, asset, (10n ** 18n).toString(), { counterparty: alice.address }),
    ).rejects.toThrow(/own address|self-swap|cannot name its own author/i)
  })
})

describe('transfer policy gates a swap leg exactly as it gates a transfer (SPEC §5.4)', () => {
  test('a soulbound asset can never be offered', async () => {
    const asset = await swordForAlice('none')
    await expect(offerSword(alice, asset, (10n ** 18n).toString())).rejects.toThrow(/soulbound|cannot be transferred/i)
  })

  test('an issuer-only asset can only settle with the issuer as one side', async () => {
    const asset = await swordForAlice('issuer-only')
    await expect(offerSword(alice, asset, (10n ** 18n).toString())).rejects.toThrow(/issuer-only/i)
    // Naming the issuer as the counterparty is the one shape that could settle.
    const hash = await offerSword(alice, asset, (10n ** 18n).toString(), { counterparty: issuer.address })
    expect(hash).toHaveLength(64)
  })
})

describe('settlement moves both legs in one block, or neither (SPEC §9.2, problem 1)', () => {
  test('accept credits the offerer with the price and the accepter with the asset', async () => {
    const asset = await swordForAlice()
    const price = 5n * 10n ** 18n
    const offer = await offerSword(alice, asset, price.toString())
    await acceptOffer(bob, offer, price)

    await receiveKei(alice)
    await receiveAsset(bob, asset)
    expect(await node.holderBalance(asset, bob.address)).toBe('1')
    expect(await node.holderBalance(asset, alice.address)).toBe('0')
    const aliceInfo = await node.accountInfo(alice.address)
    // 2000 Kei funded, nothing spent as the offerer — the price arrives on top.
    expect(BigInt(aliceInfo?.balance ?? '0')).toBe(2_000n * 10n ** 18n + price)
  })

  test('an offer settles exactly once — a second accept is rejected outright', async () => {
    const asset = await swordForAlice()
    const price = 5n * 10n ** 18n
    const offer = await offerSword(alice, asset, price.toString())
    await acceptOffer(bob, offer, price)
    await expect(acceptOffer(eve, offer, price)).rejects.toThrow(/already accepted|offer-taken/i)
  })

  test('the offerer cannot accept their own offer', async () => {
    const asset = await swordForAlice()
    const offer = await offerSword(alice, asset, (5n * 10n ** 18n).toString())
    await expect(acceptOffer(alice, offer, 5n * 10n ** 18n)).rejects.toThrow(/this account's own/i)
  })

  test('an offer reserved for one counterparty refuses everybody else (SPEC §9.2)', async () => {
    const asset = await swordForAlice()
    const price = 5n * 10n ** 18n
    const offer = await offerSword(alice, asset, price.toString(), { counterparty: bob.address })
    await expect(acceptOffer(eve, offer, price)).rejects.toThrow(/reserved for|not-the-counterparty/i)
    // The named counterparty still can.
    await expect(acceptOffer(bob, offer, price)).resolves.toHaveLength(64)
  })

  test('an accepter who cannot cover the price is told the number, not just "no"', async () => {
    const asset = await swordForAlice()
    const price = 50_000n * 10n ** 18n
    const offer = await offerSword(alice, asset, price.toString())
    const context = await draft(bob)
    // A real client would never reach this far — market.accept() checks the
    // balance first (§9.2's SDK layer) — but the ledger must refuse it too,
    // and it must refuse on the "not enough Kei" business check rather than on
    // a malformed block, so declare an honest (unchanged) balance.
    await expect(
      submit(bob, {
        type: 'asset',
        account: bob.address,
        previous: context.previous,
        representative: context.representative,
        balance: context.balance,
        op: { kind: 'swap_accept', offer },
      }),
    ).rejects.toThrow(/not enough kei/i)
  })
})

describe('cancellation returns exactly what was locked (SPEC §9.2)', () => {
  test('cancelling a Kei offer returns it to the spendable balance', async () => {
    const asset = await swordForAlice()
    const context = await draft(bob)
    const lockAmount = 10n ** 18n
    const offer = await submit(bob, {
      type: 'asset',
      account: bob.address,
      previous: context.previous,
      representative: context.representative,
      balance: (BigInt(context.balance) - lockAmount).toString(),
      op: { kind: 'swap_offer', asset: KEI_ASSET, amount: lockAmount.toString(), wantAsset: asset, wantAmount: '1' },
    })
    const locked = await node.accountInfo(bob.address)
    expect(BigInt(locked?.balance ?? '0')).toBe(2_000n * 10n ** 18n - lockAmount)
    await cancelOffer(bob, offer)
    const after = await node.accountInfo(bob.address)
    expect(BigInt(after?.balance ?? '0')).toBe(2_000n * 10n ** 18n)
  })

  test('cancelling an item offer returns the item to holdings', async () => {
    const asset = await swordForAlice()
    const offer = await offerSword(alice, asset, (10n ** 18n).toString())
    expect(await node.holderBalance(asset, alice.address)).toBe('0')
    await cancelOffer(alice, offer)
    expect(await node.holderBalance(asset, alice.address)).toBe('1')
  })

  test('only the offer\'s own author can cancel it', async () => {
    const asset = await swordForAlice()
    const offer = await offerSword(alice, asset, (10n ** 18n).toString())
    await expect(cancelOffer(eve, offer)).rejects.toThrow(/only its author|not-your-offer/i)
    await expect(cancelOffer(bob, offer)).rejects.toThrow(/only its author|not-your-offer/i)
  })

  test('cancelling twice fails the second time, naming what already happened', async () => {
    const asset = await swordForAlice()
    const offer = await offerSword(alice, asset, (10n ** 18n).toString())
    await cancelOffer(alice, offer)
    await expect(cancelOffer(alice, offer)).rejects.toThrow(/already cancelled/i)
  })

  test('referencing a hash that is not an offer at all says so', async () => {
    await expect(cancelOffer(alice, ZERO_HASH.replace(/0/g, '1'))).rejects.toThrow(/no offer with hash/i)
  })
})

describe('the accept-vs-cancel race — the one new consensus rule (SPEC §9.2, conflict 4)', () => {
  test('accept first: the offerer\'s later cancel loses outright, nothing rolls back partially', async () => {
    const asset = await swordForAlice()
    const price = 5n * 10n ** 18n
    const offer = await offerSword(alice, asset, price.toString())
    await acceptOffer(bob, offer, price)

    // Alice races a cancel in after losing. It must fail, and it must not
    // return anything to her — she has nothing locked here any more.
    const beforeCancelAttempt = await node.accountInfo(alice.address)
    await expect(cancelOffer(alice, offer)).rejects.toThrow(/was accepted by/i)
    const afterCancelAttempt = await node.accountInfo(alice.address)
    expect(afterCancelAttempt?.balance).toBe(beforeCancelAttempt?.balance)
    expect(afterCancelAttempt?.height).toBe(beforeCancelAttempt?.height)

    // And the trade is final: the payment is genuinely hers to receive.
    await receiveKei(alice)
    expect(BigInt((await node.accountInfo(alice.address))?.balance ?? '0')).toBe(2_000n * 10n ** 18n + price)
  })

  test('cancel first: the accepter\'s later accept loses outright, and pays nothing', async () => {
    const asset = await swordForAlice()
    const price = 5n * 10n ** 18n
    const offer = await offerSword(alice, asset, price.toString())
    await cancelOffer(alice, offer)

    const beforeAcceptAttempt = await node.accountInfo(bob.address)
    await expect(acceptOffer(bob, offer, price)).rejects.toThrow(/cancelled|offer-cancelled/i)
    const afterAcceptAttempt = await node.accountInfo(bob.address)
    expect(afterAcceptAttempt?.balance).toBe(beforeAcceptAttempt?.balance)
    expect(afterAcceptAttempt?.height).toBe(beforeAcceptAttempt?.height)

    // The sword is genuinely back with Alice — nobody's asset moved.
    expect(await node.holderBalance(asset, alice.address)).toBe('1')
    expect(await node.holderBalance(asset, bob.address)).toBe('0')
  })

  test('two accepters racing the same open offer: exactly one wins, deterministically by arrival order', async () => {
    const asset = await swordForAlice()
    const price = 5n * 10n ** 18n
    const offer = await offerSword(alice, asset, price.toString())

    const results = await Promise.allSettled([acceptOffer(bob, offer, price), acceptOffer(eve, offer, price)])
    const settled = results.filter((result) => result.status === 'fulfilled')
    const failed = results.filter((result) => result.status === 'rejected')
    expect(settled).toHaveLength(1)
    expect(failed).toHaveLength(1)

    const info = await node.swapOffer(offer)
    expect(info?.state).toBe('accepted')
    // Whoever's block landed is exactly who the read model says accepted it.
    const winner = info?.acceptedBy === bob.address ? bob : eve
    const loser = winner === bob ? eve : bob
    expect(await node.holderBalance(asset, winner.address)).toBe('0') // still receivable
    await receiveAsset(winner, asset)
    expect(await node.holderBalance(asset, winner.address)).toBe('1')
    expect(await node.holderBalance(asset, loser.address)).toBe('0')
  })
})

describe('resubmission after a dropped connection or a restart is a no-op (docs/rpc.md: process is idempotent)', () => {
  test('the exact same signed swap_offer block twice does not double-lock', async () => {
    const asset = await swordForAlice()
    const context = await draft(alice)
    const body: BlockBody = {
      type: 'asset',
      account: alice.address,
      previous: context.previous,
      representative: context.representative,
      balance: context.balance,
      op: { kind: 'swap_offer', asset, amount: '1', wantAsset: KEI_ASSET, wantAmount: (5n * 10n ** 18n).toString() },
    }
    const block: Block = {
      ...body,
      work: generateWork(workRoot(body), BigInt(MOCK_THRESHOLDS[tierFor(body)])),
      signature: await signHash(alice.privateKey, hashBlock(body)),
    }
    const first = await node.process(block)
    const second = await node.process(block)
    expect(second.hash).toBe(first.hash)
    // One lock, not two: the sword left holdings exactly once.
    expect(await node.holderBalance(asset, alice.address)).toBe('0')
    expect((await node.accountInfo(alice.address))?.height).toBe(3) // fund open + receive + this offer
  })

  test('the exact same signed swap_accept block twice does not double-pay', async () => {
    const asset = await swordForAlice()
    const price = 5n * 10n ** 18n
    const offer = await offerSword(alice, asset, price.toString())
    const context = await draft(bob)
    const body: BlockBody = {
      type: 'asset',
      account: bob.address,
      previous: context.previous,
      representative: context.representative,
      balance: (BigInt(context.balance) - price).toString(),
      op: { kind: 'swap_accept', offer },
    }
    const block: Block = {
      ...body,
      work: generateWork(workRoot(body), BigInt(MOCK_THRESHOLDS[tierFor(body)])),
      signature: await signHash(bob.privateKey, hashBlock(body)),
    }
    const first = await node.process(block)
    const second = await node.process(block)
    expect(second.hash).toBe(first.hash)
    expect(BigInt((await node.accountInfo(bob.address))?.balance ?? '0')).toBe(2_000n * 10n ** 18n - price)
  })
})

describe('work tier B, like every other swap and send (SPEC §5.6.4)', () => {
  test('swap_offer, swap_accept, swap_cancel all price at tier B', () => {
    const base = { account: 'kei_x', previous: 'a'.repeat(64), representative: 'kei_y', balance: '0' } as const
    expect(
      tierFor({
        ...base,
        type: 'asset',
        op: { kind: 'swap_offer', asset: 'a'.repeat(64), amount: '1', wantAsset: KEI_ASSET, wantAmount: '1' },
      }),
    ).toBe('B')
    expect(tierFor({ ...base, type: 'asset', op: { kind: 'swap_accept', offer: 'a'.repeat(64) } })).toBe('B')
    expect(tierFor({ ...base, type: 'asset', op: { kind: 'swap_cancel', offer: 'a'.repeat(64) } })).toBe('B')
  })

  test('a swap_offer under tier B difficulty is rejected, naming the tier', async () => {
    const asset = await swordForAlice()
    const context = await draft(alice)
    const body: BlockBody = {
      type: 'asset',
      account: alice.address,
      previous: context.previous,
      representative: context.representative,
      balance: context.balance,
      op: { kind: 'swap_offer', asset, amount: '1', wantAsset: KEI_ASSET, wantAmount: (5n * 10n ** 18n).toString() },
    }
    const bad: Block = {
      ...body,
      work: '0000000000000000',
      signature: await signHash(alice.privateKey, hashBlock(body)),
    }
    await expect(node.process(bad)).rejects.toThrow(/tier B difficulty/)
  })
})

describe('the market read model (SPEC §9.1)', () => {
  test('swapsOf is a bounded, newest-first walk of one account\'s own offers', async () => {
    const asset1 = await swordForAlice()
    const asset2 = await issueAsset('open')
    await mint(asset2, alice.address, '1')
    await receiveAsset(alice, asset2)

    const first = await offerSword(alice, asset1, (1n * 10n ** 18n).toString())
    const second = await offerSword(alice, asset2, (2n * 10n ** 18n).toString())

    const offers = await node.accountSwaps(alice.address)
    expect(offers.map((offer) => offer.hash)).toEqual([second, first])
  })

  test('accountSwaps filters by state', async () => {
    const asset = await swordForAlice()
    const offer = await offerSword(alice, asset, (1n * 10n ** 18n).toString())
    await cancelOffer(alice, offer)

    expect(await node.accountSwaps(alice.address, { state: 'open' })).toEqual([])
    const cancelled = await node.accountSwaps(alice.address, { state: 'cancelled' })
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]?.hash).toBe(offer)
  })

  test('an unknown offer hash reads back null rather than throwing (docs/rpc.md convention)', async () => {
    expect(await node.swapOffer('1'.repeat(64))).toBeNull()
  })
})
