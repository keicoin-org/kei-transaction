/**
 * The swap read boundary (docs/rpc.md `swap_info`, `account_swaps`).
 *
 * Every case here goes through a real `HttpNode` over a `fetch` stub, because
 * the thing under test is the boundary and not a helper: the SDK used to parse
 * these two answers with a TypeScript assertion, which meant a node — or a
 * proxy, or a cache — could hand a market a forged row and have it treated as a
 * verified fact.
 *
 * Two properties are load-bearing and both are asserted throughout: a bad
 * answer produces exactly one `KeiError('invalid-node-response')` and never a
 * native `TypeError`, `SyntaxError`, `NaN` or `Infinity`; and no refusal
 * repeats a value the node sent (SPEC §6.6).
 */

import { describe, expect, test } from 'bun:test'
import {
  HttpNode,
  KeiError,
  addressFromPublicKey,
  containsSecret,
  parseAccountSwaps,
  parseSwapInfo,
  parseSwapOffer,
  type SwapOffer,
} from '@keicoin/core'

const SELLER = addressFromPublicKey('1'.repeat(64))
const BUYER = addressFromPublicKey('2'.repeat(64))
// The two hashes below are the only fixtures that have to survive into an
// asserted error message, and they are deliberately not runs of one nibble.
// `keyPairFromSeed` registers every seed it is handed as a process-wide secret
// (src/errors.ts), `bun test` shares one process and one module instance across
// every file in the workspace, and nothing ever clears that registry — so a
// fixture hash that some other file also uses as a seed comes back out of a
// `KeiError` as '[redacted]'. Which files have run by then is the order the OS
// hands bun, so the collision fails on Linux and passes on Windows.
// `OFFER` used to be 'E'.repeat(64), which packages/kei/test/trust.test.ts
// seeds a key pair with. `guardedFixtures` below keeps that legible if it
// happens again.
const OFFER = 'C20AC803923E315B3F228CBF5E1CDD119CA35321917D255FF12E07CF5126CA59'
const OTHER_OFFER = '61EAD50DF57CB1BEE15F0107C909713B2E4642D02019A41BBBF0FC81A9C5FEEA'
const SETTLED_BY = 'D'.repeat(64)
const SWORD = 'B'.repeat(64)
const KEI = '0'.repeat(64)

type Row = Record<string, unknown>

const openRow = (): Row => ({
  hash: OFFER,
  from: SELLER,
  asset: SWORD,
  amount: '1',
  wantAsset: KEI,
  wantAmount: '5000000000000000000',
  counterparty: null,
  expiresAt: null,
  state: 'open',
  settledBy: null,
  acceptedBy: null,
  height: 4,
  seenAt: 1_700_000_000_000,
  settledAt: null,
})

const acceptedRow = (): Row => ({
  ...openRow(),
  state: 'accepted',
  settledBy: SETTLED_BY,
  acceptedBy: BUYER,
  settledAt: 1_700_000_050_000,
})

const cancelledRow = (): Row => ({
  ...openRow(),
  state: 'cancelled',
  settledBy: SETTLED_BY,
  settledAt: 1_700_000_050_000,
})

/** A node that answers whatever the test hands it, over the real client. */
function nodeAnswering(answer: (action: string) => unknown): {
  node: HttpNode
  actions: string[]
} {
  const actions: string[] = []
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { action: string }
    actions.push(body.action)
    return new Response(JSON.stringify(answer(body.action)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch
  return { node: new HttpNode({ url: 'https://node.example/rpc', fetch: fetchImpl }), actions }
}

/** The refusal, or a failure saying the call was accepted when it should not have been. */
async function refusal(work: Promise<unknown>): Promise<KeiError> {
  const outcome = await work.then(
    (value) => new Error(`the answer was accepted as ${JSON.stringify(value)}`),
    (reason: unknown) => reason,
  )
  expect(outcome).toBeInstanceOf(KeiError)
  return outcome as KeiError
}

/**
 * Every mutation of a valid row that must be refused, and the field it breaks.
 *
 * Written as data rather than as tests so the same table runs through both
 * actions: a row cannot be valid through `swap_info` and invalid through
 * `account_swaps`, which is exactly what two hand-written validators drift into.
 */
const BAD_ROWS: readonly (readonly [string, Row])[] = [
  ['hash is not hex', { ...openRow(), hash: 'not-a-hash' }],
  ['hash is short', { ...openRow(), hash: 'E'.repeat(63) }],
  ['hash is a number', { ...openRow(), hash: 12 }],
  ['hash is missing', omit(openRow(), 'hash')],
  ['from is not an address', { ...openRow(), from: 'kei_wrong_account' }],
  ['from is null', { ...openRow(), from: null }],
  ['asset is not hex', { ...openRow(), asset: 'A'.repeat(63) }],
  ['wantAsset is a list', { ...openRow(), wantAsset: [] }],
  ['amount is not an integer', { ...openRow(), amount: 'not-an-integer' }],
  ['amount is a number', { ...openRow(), amount: 1 }],
  ['amount is zero', { ...openRow(), amount: '0' }],
  ['amount is negative', { ...openRow(), amount: '-1' }],
  ['amount has a leading zero', { ...openRow(), amount: '01' }],
  ['amount is padded', { ...openRow(), amount: ' 1' }],
  ['amount is exponential', { ...openRow(), amount: '1e3' }],
  ['amount is wider than a block', { ...openRow(), amount: (2n ** 128n).toString() }],
  ['wantAmount is empty', { ...openRow(), wantAmount: '' }],
  ['counterparty is not an address', { ...openRow(), counterparty: 'kei_nobody' }],
  ['counterparty is undefined rather than null', omit(openRow(), 'counterparty')],
  ['expiresAt is negative', { ...openRow(), expiresAt: -1 }],
  ['expiresAt is fractional', { ...openRow(), expiresAt: 1.5 }],
  ['expiresAt is a string', { ...openRow(), expiresAt: '1700000000000' }],
  ['state is not a swap state', { ...openRow(), state: 'settled' }],
  ['state is a number', { ...openRow(), state: 1 }],
  ['height is zero', { ...openRow(), height: 0 }],
  ['height is a string', { ...openRow(), height: '4' }],
  ['seenAt is negative', { ...openRow(), seenAt: -10 }],
  ['seenAt is missing', omit(openRow(), 'seenAt')],
  ['settledBy is not hex', { ...acceptedRow(), settledBy: 'no' }],
  ['acceptedBy is not an address', { ...acceptedRow(), acceptedBy: 'kei_buyer' }],
  ['an open offer was accepted by somebody', { ...openRow(), acceptedBy: BUYER }],
  ['an open offer names a settling block', { ...openRow(), settledBy: SETTLED_BY }],
  ['an open offer has a settlement time', { ...openRow(), settledAt: 1_700_000_050_000 }],
  ['an accepted offer has no accepter', { ...acceptedRow(), acceptedBy: null }],
  ['an accepted offer has no settling block', { ...acceptedRow(), settledBy: null }],
  ['an accepted offer has no settlement time', { ...acceptedRow(), settledAt: null }],
  ['a cancelled offer was also accepted', { ...cancelledRow(), acceptedBy: BUYER }],
  ['a cancelled offer names no cancelling block', { ...cancelledRow(), settledBy: null }],
  ['a cancelled offer has no settlement time', { ...cancelledRow(), settledAt: null }],
]

function omit(row: Row, key: string): Row {
  const copy = { ...row }
  delete copy[key]
  return copy
}

describe('one parser, two actions', () => {
  test('a valid row reads the same through swap_info and account_swaps', async () => {
    const { node } = nodeAnswering((action) =>
      action === 'swap_info' ? { offer: openRow() } : { offers: [openRow()] },
    )
    const one = await node.swapOffer(OFFER)
    const [page] = await node.accountSwaps(SELLER)
    expect(one).toEqual(page as SwapOffer)
    expect(one).toEqual({
      hash: OFFER,
      from: SELLER,
      asset: SWORD,
      amount: '1',
      wantAsset: KEI,
      wantAmount: '5000000000000000000',
      counterparty: null,
      expiresAt: null,
      state: 'open',
      settledBy: null,
      acceptedBy: null,
      height: 4,
      seenAt: 1_700_000_000_000,
      settledAt: null,
    })
  })

  test.each(BAD_ROWS.map(([name, row]) => [name, row] as const))(
    'swap_info refuses a row where %s',
    async (_name, row) => {
      const { node } = nodeAnswering(() => ({ offer: row }))
      expect((await refusal(node.swapOffer(OFFER))).code).toBe('invalid-node-response')
    },
  )

  test.each(BAD_ROWS.map(([name, row]) => [name, row] as const))(
    'account_swaps refuses a page where %s',
    async (_name, row) => {
      const { node } = nodeAnswering(() => ({ offers: [row] }))
      expect((await refusal(node.accountSwaps(SELLER))).code).toBe('invalid-node-response')
    },
  )

  test('the three valid states are accepted, so the invariants reject nothing real', async () => {
    const { node } = nodeAnswering(() => ({ offers: [openRow(), acceptedRow(), cancelledRow()] }))
    expect((await node.accountSwaps(SELLER)).map((offer) => offer.state)).toEqual([
      'open',
      'accepted',
      'cancelled',
    ])
  })
})

describe('the envelope', () => {
  const ENVELOPES: readonly (readonly [string, unknown])[] = [
    ['a list', []],
    ['a string', 'offers'],
    ['a number', 7],
    ['null', null],
    ['an object with no offers in it', {}],
    ['offers as an object', { offers: {} }],
    ['offers as null', { offers: null }],
    ['offers as a string', { offers: 'none' }],
  ]

  test.each(ENVELOPES.map(([name, body]) => [name, body] as const))(
    'account_swaps refuses an answer that is %s',
    async (_name, body) => {
      const { node } = nodeAnswering(() => body)
      expect((await refusal(node.accountSwaps(SELLER))).code).toBe('invalid-node-response')
    },
  )

  test('an answer with no offers in it is not an empty book', async () => {
    const { node } = nodeAnswering(() => ({}))
    const error = await refusal(node.accountSwaps(SELLER))
    expect(error.message).toContain('is not an empty one')
  })

  test('a page longer than the count it asked for is refused', async () => {
    const rows = [openRow(), { ...openRow(), hash: 'F'.repeat(64) }, { ...openRow(), hash: 'A'.repeat(64) }]
    const { node } = nodeAnswering(() => ({ offers: rows }))
    expect((await refusal(node.accountSwaps(SELLER, { limit: 2 }))).code).toBe('invalid-node-response')
    expect(await node.accountSwaps(SELLER, { limit: 3 })).toHaveLength(3)
  })

  test('swap_info takes an explicit null and refuses an absent offer', async () => {
    const { node: silent } = nodeAnswering(() => ({ offer: null }))
    expect(await silent.swapOffer(OFFER)).toBeNull()
    const { node: absent } = nodeAnswering(() => ({}))
    expect((await refusal(absent.swapOffer(OFFER))).code).toBe('invalid-node-response')
  })
})

describe('provenance: the answer has to be to the question asked', () => {
  // Fails loudly, and for the right reason, if either hash ever becomes a seed
  // somewhere else in the workspace — otherwise the only symptom is a
  // provenance assertion below finding '[redacted]' on one OS and not the other.
  test('guardedFixtures: neither provenance hash is a registered secret', () => {
    expect(containsSecret(OFFER)).toBe(false)
    expect(containsSecret(OTHER_OFFER)).toBe(false)
  })

  test('swap_info cannot answer with a different offer', async () => {
    const { node } = nodeAnswering(() => ({ offer: { ...openRow(), hash: OTHER_OFFER } }))
    const error = await refusal(node.swapOffer(OFFER))
    expect(error.code).toBe('invalid-node-response')
    expect(error.message).toContain(OFFER)
  })

  test('swap_info accepts the same hash in either case', async () => {
    const { node } = nodeAnswering(() => ({ offer: { ...openRow(), hash: OFFER.toLowerCase() } }))
    expect((await node.swapOffer(OFFER))?.hash).toBe(OFFER)
  })

  test('account_swaps cannot slip in another account\'s offer', async () => {
    const { node } = nodeAnswering(() => ({ offers: [openRow(), { ...openRow(), from: BUYER }] }))
    const error = await refusal(node.accountSwaps(SELLER))
    expect(error.code).toBe('invalid-node-response')
    expect(error.message).toContain('index 1')
  })

  test('account_swaps cannot answer a state filter with another state', async () => {
    const { node } = nodeAnswering(() => ({ offers: [acceptedRow()] }))
    expect((await refusal(node.accountSwaps(SELLER, { state: 'open' }))).code).toBe(
      'invalid-node-response',
    )
    expect(await node.accountSwaps(SELLER, { state: 'accepted' })).toHaveLength(1)
  })
})

describe('what a refusal is allowed to say (SPEC §6.6)', () => {
  test('the value that was refused is never in the message', async () => {
    const planted = 'C0FFEE'.repeat(11)
    const { node } = nodeAnswering(() => ({ offers: [{ ...openRow(), amount: planted }] }))
    const error = await refusal(node.accountSwaps(SELLER))
    expect(error.message).not.toContain(planted)
    expect(error.message).toContain('amount')
    expect(error.message).toContain('index 0')
  })

  test('a refusal names the action, the row and the fix', async () => {
    const { node } = nodeAnswering(() => ({ offer: { ...openRow(), state: 'settled' } }))
    const error = await refusal(node.swapOffer(OFFER))
    expect(error.message).toContain('swap_info')
    expect(error.message).toContain('nothing was signed')
  })
})

describe('observation is not confirmation', () => {
  test('the row carries only what the node contract defines', () => {
    const parsed = parseSwapOffer(
      { ...acceptedRow(), confirmed: true, finality: 'final', confirmations: 40 },
      'swap_info',
    )
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'acceptedBy',
        'amount',
        'asset',
        'counterparty',
        'expiresAt',
        'from',
        'hash',
        'height',
        'seenAt',
        'settledBy',
        'settledAt',
        'state',
        'wantAmount',
        'wantAsset',
      ].sort(),
    )
    // Until keicoin-org/kei-node#27 puts confirmation on the wire there is
    // nothing to report, and a settled timestamp is not a substitute for it.
    expect('confirmed' in parsed).toBe(false)
    expect(parsed.settledAt).toBe(1_700_000_050_000)
    expect(parsed.seenAt).toBe(1_700_000_000_000)
  })

  test('a height and a timestamp do not make a row final on their own', () => {
    const parsed = parseSwapOffer({ ...openRow(), height: 9_007_199_254_740_991 }, 'swap_info')
    expect(parsed.state).toBe('open')
    expect(parsed.settledAt).toBeNull()
  })
})

describe('rows this shape cannot arrive as JSON, and arrive anyway', () => {
  test('a computed field is refused, because it can answer twice', () => {
    let reads = 0
    const row = {
      ...openRow(),
      get amount(): string {
        reads += 1
        return reads === 1 ? '1' : '999999'
      },
    }
    expect(() => parseSwapOffer(row, 'swap_info')).toThrow(KeiError)
    expect(reads).toBe(0)
  })

  test('a row with another prototype is refused', () => {
    class Offerish {}
    expect(() => parseSwapOffer(Object.assign(new Offerish(), openRow()), 'swap_info')).toThrow(
      KeiError,
    )
  })

  test('a hole in the page is refused rather than skipped', () => {
    const offers = [openRow(), , openRow()] as unknown[]
    expect(() => parseAccountSwaps({ offers }, SELLER, { limit: 100 })).toThrow(KeiError)
  })

  test('a page whose length is not a length is refused before it is walked', () => {
    const offers = new Proxy([openRow()], {
      get: (target, key, receiver) =>
        key === 'length' ? Number.NaN : Reflect.get(target, key, receiver),
    })
    expect(() => parseAccountSwaps({ offers }, SELLER, { limit: 100 })).toThrow(KeiError)
  })
})

describe('arbitrary JSON is one bounded refusal or a whole row, never a third thing', () => {
  /** Deterministic, so a failure replays with the same value that caused it. */
  function random(seed: number): () => number {
    let state = seed >>> 0
    return () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0
      return state / 0x1_0000_0000
    }
  }

  const SCRAPS: readonly unknown[] = [
    null,
    true,
    0,
    -1,
    1.5,
    '',
    'kei_1',
    'not-an-integer',
    [],
    [1, 2],
    {},
    { hash: OFFER },
    OFFER,
    SELLER,
    '0',
    '-0',
    9_007_199_254_740_992,
    1e309,
  ]

  test('every mutation of a real row lands on one side or the other', () => {
    const next = random(20_260_805)
    const keys = Object.keys(openRow())
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const row = [openRow, acceptedRow, cancelledRow][Math.floor(next() * 3)]?.() as Row
      const key = keys[Math.floor(next() * keys.length)] as string
      if (next() < 0.2) delete row[key]
      else row[key] = SCRAPS[Math.floor(next() * SCRAPS.length)]
      let parsed: SwapOffer | undefined
      try {
        parsed = parseSwapOffer(row, 'account_swaps', 'Offer at index 0')
      } catch (error) {
        expect(error).toBeInstanceOf(KeiError)
        expect((error as KeiError).code).toBe('invalid-node-response')
        continue
      }
      expect(Number.isSafeInteger(parsed.height)).toBe(true)
      expect(Number.isSafeInteger(parsed.seenAt)).toBe(true)
      expect(BigInt(parsed.amount) > 0n).toBe(true)
      expect(BigInt(parsed.wantAmount) > 0n).toBe(true)
    }
  })

  test('every scrap of JSON in an envelope is a refusal and not a crash', () => {
    for (const scrap of SCRAPS) {
      for (const body of [scrap, { offer: scrap }, { offers: scrap }, { offers: [scrap] }]) {
        let outcome: unknown
        try {
          outcome = parseAccountSwaps(body, SELLER, { limit: 100 })
        } catch (error) {
          expect(error).toBeInstanceOf(KeiError)
          continue
        }
        expect(Array.isArray(outcome)).toBe(true)
      }
      for (const body of [scrap, { offer: scrap }]) {
        try {
          expect(parseSwapInfo(body, OFFER)).toBeNull()
        } catch (error) {
          expect(error).toBeInstanceOf(KeiError)
        }
      }
    }
  })
})
