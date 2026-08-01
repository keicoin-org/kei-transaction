/**
 * The block hash, against fixed vectors the node asserts too.
 *
 * The node computes these hashes in C++ and this SDK computes them in
 * TypeScript. Nothing in either codebase can check that the two agree, and until
 * something does, a block signed here is not verifiable there — which is
 * definition-of-done (6). `kei-node/util/keihash.py` states the §7/§14 layout a
 * third time and prints these values; `core_test`'s `block.kei_hash_vectors`
 * asserts the same literals against the real node. Both sides are pinned to the
 * bytes rather than to each other.
 *
 * Change a vector only when the node's layout changes, and change it on both
 * sides in the same breath.
 */

import { describe, expect, test } from 'bun:test'
import {
  bytesToHex,
  deriveAssetId,
  hashBlock,
  KEI_ASSET,
  keiBlockDomain,
  nodeLayoutGap,
  type AssetOp,
  type BlockBody,
} from '../src/index.js'

// The inherited dev genesis public key, which keigen.verify() reproduces from
// its private key — a real key rather than a pattern that could hide a
// byte-order mistake.
const ACCOUNT = 'kei_3e3j5tkog48pnny9dmfzj1r16pg8t1e76dz5tmac6iq689wyjfpiij4txtdo'
const DESTINATION = 'kei_3xg8wkiu76w6gp5bg41q6rtnanu4g83b9b7orudyjya36f4ph4ac9mz7pnio'
const DESTINATION_KEY = 'F5C6E4A1B2938475869708172635445362718293A4B5C6D7E8F901234567890A'
const PREVIOUS = '00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF'
const BALANCE = '1234567890123456789012345678'
const AMOUNT = '42000000000000000000'
const ASSET_ID = '3EB956658F4BA3BEF3BFDBC3545121BA1D35CA7DD0C398DFA8FC480641E4BF04'

describe('the Kei hash domain', () => {
  test('is blake2b-256 of the version label', () => {
    // Pinned rather than recomputed from the label here, because recomputing it
    // the same way twice would agree with any label at all. Every vector below
    // starts with these bytes, so a typo in the label already fails four tests —
    // this one says which mistake was made. Not a bare block-type preamble,
    // which is what an inherited block hashes under — decisions-m2.md §14.
    expect(bytesToHex(keiBlockDomain())).toBe(
      '0577ACDDCA6FA57E63163E3EA4A026299EA8C7DBCED04CA839E87AD20E69501D',
    )
    expect(keiBlockDomain()).toHaveLength(32)
  })
})

describe('block hash vectors', () => {
  test('a state send', () => {
    const body: BlockBody = {
      type: 'state',
      subtype: 'send',
      account: ACCOUNT,
      previous: PREVIOUS,
      representative: ACCOUNT,
      balance: BALANCE,
      link: DESTINATION_KEY,
    }
    expect(hashBlock(body)).toBe(
      '44949CB72CF14C61DC6843982B7476722257A65A7B61AAD9C912C78A73BA8649',
    )
  })

  test('the subtype is not hashed, because the node keeps it in the sideband', () => {
    const base = {
      type: 'state',
      account: ACCOUNT,
      previous: PREVIOUS,
      representative: ACCOUNT,
      balance: BALANCE,
      link: DESTINATION_KEY,
    } as const
    expect(hashBlock({ ...base, subtype: 'send' })).toBe(
      hashBlock({ ...base, subtype: 'receive' }),
    )
  })

  test('an asset id is derived from the issuer and the symbol', () => {
    expect(deriveAssetId(
      'B0311EA55708D6A53C75CDBF88300259C6D018522FE3D4D0A242E431F9E8B6D0',
      'GEM',
    )).toBe(ASSET_ID)
  })

  test('an issue', () => {
    const body: BlockBody = {
      type: 'asset',
      account: ACCOUNT,
      previous: PREVIOUS,
      representative: ACCOUNT,
      balance: BALANCE,
      op: {
        kind: 'issue',
        name: 'Test Gem',
        symbol: 'GEM',
        decimals: 2,
        maxSupply: '1000000',
        transfer: 'issuer-only',
        swap: 'two-way',
        metadata: { description: 'A gem for testing', image: 'QmTestCid', kind: 'item' },
      },
    }
    expect(hashBlock(body)).toBe(
      '1F583FFE5EFC7A342901481A2B152AA7D67A89484F0F6E1509C8579D7DCD742F',
    )
  })

  test('a transfer, memo included', () => {
    const body: BlockBody = {
      type: 'asset',
      account: ACCOUNT,
      previous: PREVIOUS,
      representative: ACCOUNT,
      balance: BALANCE,
      op: {
        kind: 'transfer',
        asset: ASSET_ID,
        to: DESTINATION,
        amount: AMOUNT,
        memo: 'thanks',
      },
    }
    expect(hashBlock(body)).toBe(
      '05D77C0F64906C2FC5571B3982223A51A2B376F9D9F6AA259AC438181DBA2345',
    )
  })

  test('the memo is covered, so changing it changes the hash', () => {
    const base = {
      type: 'asset',
      account: ACCOUNT,
      previous: PREVIOUS,
      representative: ACCOUNT,
      balance: BALANCE,
    } as const
    const withMemo = (memo: string): BlockBody => ({
      ...base,
      op: { kind: 'transfer', asset: ASSET_ID, to: DESTINATION, amount: AMOUNT, memo },
    })
    expect(hashBlock(withMemo('thanks'))).not.toBe(hashBlock(withMemo('thanks!')))
  })

  // kei_transfer is not cross-checked against the node's own C++ vectors the
  // way the ones above are — the fork's implementation lands separately and
  // has no compiler here to produce a value to pin against. These assert
  // structure instead of a literal hash; add a pinned vector once
  // core_test.kei_hash_vectors has one to match.
  describe('kei_transfer', () => {
    const base = {
      type: 'asset',
      account: ACCOUNT,
      previous: PREVIOUS,
      representative: ACCOUNT,
      balance: BALANCE,
    } as const

    test('has no node-layout gap', () => {
      const body: BlockBody = {
        ...base,
        op: { kind: 'kei_transfer', to: DESTINATION, amount: AMOUNT, memo: 'thanks' },
      }
      expect(nodeLayoutGap(body)).toBeNull()
    })

    test('is a distinct op from transfer — same fields hash differently', () => {
      const keiTransfer: BlockBody = {
        ...base,
        op: { kind: 'kei_transfer', to: DESTINATION, amount: AMOUNT, memo: 'thanks' },
      }
      const transfer: BlockBody = {
        ...base,
        op: { kind: 'transfer', asset: KEI_ASSET, to: DESTINATION, amount: AMOUNT, memo: 'thanks' },
      }
      expect(hashBlock(keiTransfer)).not.toBe(hashBlock(transfer))
    })

    test('the memo is covered, so changing it changes the hash', () => {
      const withMemo = (memo: string): BlockBody => ({
        ...base,
        op: { kind: 'kei_transfer', to: DESTINATION, amount: AMOUNT, memo },
      })
      expect(hashBlock(withMemo('thanks'))).not.toBe(hashBlock(withMemo('thanks!')))
    })

    test('a memo-less kei_transfer still hashes', () => {
      const noMemo: BlockBody = { ...base, op: { kind: 'kei_transfer', to: DESTINATION, amount: AMOUNT } }
      expect(() => hashBlock(noMemo)).not.toThrow()
    })
  })
})

describe('blocks the node has no layout for', () => {
  const base = {
    type: 'asset',
    account: ACCOUNT,
    previous: PREVIOUS,
    representative: ACCOUNT,
    balance: BALANCE,
  } as const

  test('the M4/M5 operations are named rather than guessed at', () => {
    const deferred: AssetOp[] = [
      { kind: 'commit', root: PREVIOUS, asset: ASSET_ID, count: 2, total: '5' },
      { kind: 'commit_close', root: PREVIOUS },
      { kind: 'claim', root: PREVIOUS, asset: ASSET_ID, amount: '5', proof: [] },
    ]
    for (const op of deferred) {
      const gap = nodeLayoutGap({ ...base, op })
      expect(gap).toContain(op.kind)
      expect(gap).toContain('M4/M5')
    }
  })

  test('a memo on a state block, because §8 puts memos on the asset block', () => {
    const body: BlockBody = {
      type: 'state',
      subtype: 'send',
      account: ACCOUNT,
      previous: PREVIOUS,
      representative: ACCOUNT,
      balance: BALANCE,
      link: DESTINATION_KEY,
      memo: 'for the sword',
    }
    expect(nodeLayoutGap(body)).toContain('memo')
    // It must not collide with the consensus hash of the same block without the
    // memo. A node computes that one, accepts it, and drops the memo silently;
    // hashing them apart is what turns that into a rejected signature instead.
    const { memo: _memo, ...withoutMemo } = body
    expect(hashBlock(body)).not.toBe(hashBlock(withoutMemo as BlockBody))
  })

  test('an ordinary block has no gap', () => {
    expect(nodeLayoutGap({
      ...base,
      op: { kind: 'burn', asset: ASSET_ID, amount: AMOUNT },
    })).toBeNull()
  })
})
