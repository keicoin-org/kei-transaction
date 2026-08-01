/**
 * The ledger rules SPEC §5.6 settles, tested at the node boundary rather than
 * through the SDK, because these are the invariants the real node fork has to
 * reproduce at M2.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  issuanceBurn,
  KEI_ASSET,
  MOCK_THRESHOLDS,
  MockNode,
  NULL_REPRESENTATIVE,
  ZERO_HASH,
  deriveAssetId,
  generateWork,
  hashBlock,
  keyPairFromSeed,
  publicKeyFromAddress,
  signHash,
  tierFor,
  workRoot,
  type Block,
  type BlockBody,
  type KeyPair,
} from '@keicoin/core'

let node: MockNode
let issuer: KeyPair
let player: KeyPair

/** Signs and submits a body as `keys`, filling in work. */
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
  const receivables = await node.receivables(keys.address)
  for (const receivable of receivables) {
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

beforeEach(async () => {
  node = await MockNode.create()
  issuer = await keyPairFromSeed('A1'.repeat(32))
  player = await keyPairFromSeed('B2'.repeat(32))
})

describe('one chain per account (SPEC §5.6.1)', () => {
  test('asset operations share the chain with Kei operations', async () => {
    await fund(issuer, 2_000)
    const before = await node.accountInfo(issuer.address)
    const context = await draft(issuer)

    await submit(issuer, {
      type: 'asset',
      account: issuer.address,
      previous: context.previous,
      representative: context.representative,
      balance: (BigInt(context.balance) - issuanceBurn(0)).toString(),
      op: {
        kind: 'issue',
        name: 'Gems',
        symbol: 'GEM',
        decimals: 0,
        maxSupply: null,
        transfer: 'open',
        swap: 'one-way',
      },
    })

    const after = await node.accountInfo(issuer.address)
    expect(after?.height).toBe((before?.height ?? 0) + 1)
    // An asset block carries the Kei balance, so a tool that ignores the asset
    // payload still tracks Kei correctly (SPEC §5.6.8).
    expect(BigInt(after?.balance ?? '0')).toBe(BigInt(before?.balance ?? '0') - issuanceBurn(0))
  })

  test('a block on a stale frontier is a fork, and says how to fix it', async () => {
    await fund(issuer, 2_000)
    const context = await draft(issuer)
    const body: BlockBody = {
      type: 'state',
      subtype: 'send',
      account: issuer.address,
      previous: ZERO_HASH,
      representative: context.representative,
      balance: '0',
      link: publicKeyFromAddress(player.address),
    }
    await expect(submit(issuer, body)).rejects.toThrow(/but this block builds on.*Fetch the current frontier/s)
  })

  test('an asset block may not move Kei (SPEC §5.6.1)', async () => {
    await fund(issuer, 2_000)
    const context = await draft(issuer)
    await submit(issuer, {
      type: 'asset',
      account: issuer.address,
      previous: context.previous,
      representative: context.representative,
      balance: (BigInt(context.balance) - issuanceBurn(0)).toString(),
      op: { kind: 'issue', name: 'Gems', symbol: 'GEM', decimals: 0, maxSupply: null, transfer: 'open', swap: 'off' },
    })

    const next = await draft(issuer)
    await expect(
      submit(issuer, {
        type: 'asset',
        account: issuer.address,
        previous: next.previous,
        representative: next.representative,
        // Trying to smuggle Kei out through an asset block.
        balance: (BigInt(next.balance) - 10n ** 18n).toString(),
        op: {
          kind: 'mint',
          asset: deriveAssetId(issuer.publicKey, 'GEM'),
          to: player.address,
          amount: '1',
        },
      }),
    ).rejects.toThrow(/carry the account's Kei balance unchanged/)
  })
})

describe('assets arrive as receivable (SPEC §5.6.3)', () => {
  test('a mint does not touch the recipient until the recipient signs', async () => {
    await fund(issuer, 2_000)
    const asset = await issueGem()

    await mint(asset, player.address, '5')
    // Nobody can inflate your state but you.
    expect(await node.holdings(player.address)).toEqual([])
    expect(await node.holderBalance(asset, player.address)).toBe('0')
    expect(await node.accountInfo(player.address)).toBeNull()

    const [receivable] = await node.receivables(player.address)
    expect(receivable?.asset).toBe(asset)
    expect(receivable?.amount).toBe('5')

    const context = await draft(player)
    await submit(player, {
      type: 'asset',
      account: player.address,
      previous: context.previous,
      representative: context.representative,
      balance: '0',
      op: { kind: 'asset_receive', link: receivable?.hash ?? '' },
    })
    expect(await node.holderBalance(asset, player.address)).toBe('5')
  })

  test('a receivable can only be collected by its recipient', async () => {
    await fund(issuer, 2_000)
    const asset = await issueGem()
    await mint(asset, player.address, '5')
    const [receivable] = await node.receivables(player.address)

    const thief = await keyPairFromSeed('C3'.repeat(32))
    const context = await draft(thief)
    await expect(
      submit(thief, {
        type: 'asset',
        account: thief.address,
        previous: context.previous,
        representative: context.representative,
        balance: '0',
        op: { kind: 'asset_receive', link: receivable?.hash ?? '' },
      }),
    ).rejects.toThrow(/belongs to/)
  })

  test('incoming Kei is collected by a receive block, not an asset block', async () => {
    await node.faucet(player.address)
    const [receivable] = await node.receivables(player.address)
    expect(receivable?.asset).toBe(KEI_ASSET)

    const context = await draft(player)
    await expect(
      submit(player, {
        type: 'asset',
        account: player.address,
        previous: context.previous,
        representative: context.representative,
        balance: '0',
        op: { kind: 'asset_receive', link: receivable?.hash ?? '' },
      }),
    ).rejects.toThrow(/collected by a receive block/)
  })
})

describe('kei_transfer — memos ride the asset block (decisions-m2.md, kei_transfer)', () => {
  test('a memo cannot ride a state send', async () => {
    await fund(issuer, 2_000)
    const context = await draft(issuer)
    await expect(
      submit(issuer, {
        type: 'state',
        subtype: 'send',
        account: issuer.address,
        previous: context.previous,
        representative: context.representative,
        balance: (BigInt(context.balance) - 10n ** 18n).toString(),
        link: publicKeyFromAddress(player.address),
        memo: 'for the sword',
      }),
    ).rejects.toThrow(/memo cannot ride a state block/)
  })

  test('decrements balance at send time, unlike every other asset op', async () => {
    await fund(issuer, 2_000)
    const before = await node.accountInfo(issuer.address)
    const context = await draft(issuer)
    const amount = 10n ** 18n

    await submit(issuer, {
      type: 'asset',
      account: issuer.address,
      previous: context.previous,
      representative: context.representative,
      balance: (BigInt(context.balance) - amount).toString(),
      op: { kind: 'kei_transfer', to: player.address, amount: amount.toString(), memo: 'thanks' },
    })

    const after = await node.accountInfo(issuer.address)
    expect(BigInt(after?.balance ?? '0')).toBe(BigInt(before?.balance ?? '0') - amount)
  })

  test('the receivable carries the memo, and cannot be collected with receive/open', async () => {
    await fund(issuer, 2_000)
    const context = await draft(issuer)
    const amount = 10n ** 18n
    await submit(issuer, {
      type: 'asset',
      account: issuer.address,
      previous: context.previous,
      representative: context.representative,
      balance: (BigInt(context.balance) - amount).toString(),
      op: { kind: 'kei_transfer', to: player.address, amount: amount.toString(), memo: 'thanks' },
    })

    const [receivable] = await node.receivables(player.address)
    expect(receivable?.asset).toBe(KEI_ASSET)
    expect(receivable?.memo).toBe('thanks')

    await expect(
      submit(player, {
        type: 'state',
        subtype: 'open',
        account: player.address,
        previous: ZERO_HASH,
        representative: player.address,
        balance: amount.toString(),
        link: receivable?.hash ?? '',
      }),
    ).rejects.toThrow(/collect it with asset_receive/)
  })

  test('collecting with asset_receive credits balance, not holdings', async () => {
    await fund(issuer, 2_000)
    const context = await draft(issuer)
    const amount = 10n ** 18n
    await submit(issuer, {
      type: 'asset',
      account: issuer.address,
      previous: context.previous,
      representative: context.representative,
      balance: (BigInt(context.balance) - amount).toString(),
      op: { kind: 'kei_transfer', to: player.address, amount: amount.toString(), memo: 'thanks' },
    })
    const [receivable] = await node.receivables(player.address)

    await submit(player, {
      type: 'asset',
      account: player.address,
      previous: ZERO_HASH,
      representative: player.address,
      balance: amount.toString(),
      op: { kind: 'asset_receive', link: receivable?.hash ?? '' },
    })

    const after = await node.accountInfo(player.address)
    expect(BigInt(after?.balance ?? '0')).toBe(amount)
    // Not a real asset — nothing was ever held in the asset tables for it.
    expect(await node.holdings(player.address)).toEqual([])
  })
})

describe('proof-of-work tiers (SPEC §5.6.4)', () => {
  test('tiers follow the table: mint is A, transfer is B, claim is C', () => {
    const base = { account: 'kei_x', previous: 'a'.repeat(64), representative: 'kei_y', balance: '0' }
    expect(tierFor({ ...base, type: 'state', subtype: 'send', link: '0'.repeat(64) })).toBe('B')
    expect(tierFor({ ...base, type: 'state', subtype: 'receive', link: '0'.repeat(64) })).toBe('C')
    expect(
      tierFor({
        ...base,
        type: 'asset',
        op: { kind: 'issue', name: 'x', symbol: 'X', decimals: 0, maxSupply: null, transfer: 'open', swap: 'off' },
      }),
    ).toBe('A')
    expect(tierFor({ ...base, type: 'asset', op: { kind: 'mint', asset: 'a', to: 'b', amount: '1' } })).toBe('A')
    expect(
      tierFor({ ...base, type: 'asset', op: { kind: 'transfer', asset: 'a', to: 'b', amount: '1' } }),
    ).toBe('B')
    expect(
      tierFor({ ...base, type: 'asset', op: { kind: 'claim', root: 'r', asset: 'a', amount: '1', proof: [] } }),
    ).toBe('C')
    expect(tierFor({ ...base, type: 'asset', op: { kind: 'burn', asset: 'a', amount: '1' } })).toBe('C')
  })

  test('a block with work below its tier is rejected, naming the root to work on', async () => {
    await node.faucet(player.address)
    const [receivable] = await node.receivables(player.address)
    const context = await draft(player)
    const body: BlockBody = {
      type: 'state',
      subtype: 'open',
      account: player.address,
      previous: context.previous,
      representative: context.representative,
      balance: receivable?.amount ?? '0',
      link: receivable?.hash ?? '',
    }
    const bad: Block = {
      ...body,
      work: '0000000000000000',
      signature: await signHash(player.privateKey, hashBlock(body)),
    }
    await expect(node.process(bad)).rejects.toThrow(/tier C difficulty.*root/s)
  })
})

describe('the reserve (SPEC §5.7)', () => {
  test('a reserve account cannot name a real representative', async () => {
    const addresses = node.ledger.genesisAddresses()
    const reserveKeys = await keyPairFromSeed('1'.repeat(64))
    expect(reserveKeys.address).toBe(addresses.reserve)

    const context = await draft(reserveKeys)
    expect(context.representative).toBe(NULL_REPRESENTATIVE)
    await expect(
      submit(reserveKeys, {
        type: 'state',
        subtype: 'change',
        account: reserveKeys.address,
        previous: context.previous,
        representative: player.address,
        balance: context.balance,
        link: ZERO_HASH,
      }),
    ).rejects.toThrow(/null representative/)
  })

  test('reserve Kei cannot be sent without the vote that does not exist yet', async () => {
    const reserveKeys = await keyPairFromSeed('1'.repeat(64))
    const context = await draft(reserveKeys)
    await expect(
      submit(reserveKeys, {
        type: 'state',
        subtype: 'send',
        account: reserveKeys.address,
        previous: context.previous,
        representative: NULL_REPRESENTATIVE,
        balance: (BigInt(context.balance) - 10n ** 18n).toString(),
        link: publicKeyFromAddress(player.address),
      }),
    ).rejects.toThrow(/passed on-chain vote/)
  })
})

describe('idempotent submission', () => {
  test('processing the same block twice is not a fork', async () => {
    await node.faucet(player.address)
    const [receivable] = await node.receivables(player.address)
    const context = await draft(player)
    const body: BlockBody = {
      type: 'state',
      subtype: 'open',
      account: player.address,
      previous: context.previous,
      representative: context.representative,
      balance: receivable?.amount ?? '0',
      link: receivable?.hash ?? '',
    }
    const block: Block = {
      ...body,
      work: generateWork(workRoot(body), BigInt(MOCK_THRESHOLDS.C)),
      signature: await signHash(player.privateKey, hashBlock(body)),
    }
    const first = await node.process(block)
    const second = await node.process(block)
    expect(second.hash).toBe(first.hash)
    expect((await node.accountInfo(player.address))?.height).toBe(1)
  })
})

describe('asset lookup', () => {
  test('by symbol, from the issuer, with no registry to race', async () => {
    await fund(issuer, 2_000)
    const asset = await issueGem()
    const info = await node.assetBySymbol(issuer.address, 'gem')
    expect(info?.id).toBe(asset)
    expect(await node.assetBySymbol(player.address, 'GEM')).toBeNull()
  })
})

async function issueGem(): Promise<string> {
  const context = await draft(issuer)
  await submit(issuer, {
    type: 'asset',
    account: issuer.address,
    previous: context.previous,
    representative: context.representative,
    balance: (BigInt(context.balance) - issuanceBurn(0)).toString(),
    op: { kind: 'issue', name: 'Gems', symbol: 'GEM', decimals: 0, maxSupply: null, transfer: 'open', swap: 'off' },
  })
  return deriveAssetId(issuer.publicKey, 'GEM')
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
