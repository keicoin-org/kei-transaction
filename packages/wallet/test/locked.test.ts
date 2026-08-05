/**
 * Issue #43 — an asset locked in this account's own open offer is still this
 * account's, and the wallet has to be able to say so.
 *
 * The offers here are supplied rather than written: `@keicoin/market` is
 * downstream of this package (see support.ts), so what these tests pin is the
 * half that lives here — what `summary()` does with an offer, and what the
 * panel renders from it. `packages/kei/test/wallet-locked.test.ts` covers the
 * same ground with a real `swap_offer` on a real chain, so neither half can
 * drift into agreeing with a fiction.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { KEI_ASSET, KeiError, MockNode } from '@keicoin/core'
import { issueToken } from '@keicoin/tokens'
import { WalletPanel, createWallet } from '../src/index.js'
import type { WalletMarket, WalletMarketCoverage, WalletMarketOffer, WalletMarketOffers } from '../src/index.js'
import { makeDom, makeIssuer, makePlayer, waitFor, type Dom, type TestIssuer } from './support.js'

let node: MockNode
let game: TestIssuer
let dom: Dom

beforeEach(async () => {
  node = await MockNode.create()
  game = await makeIssuer(node)
  dom = makeDom()
})

const OFFER = 'A'.repeat(64)

function keiLeg(amount: number): WalletMarketOffer['want'] {
  return {
    asset: KEI_ASSET,
    symbol: 'KEI',
    name: 'Kei',
    amount,
    raw: (BigInt(amount) * 10n ** 18n).toString(),
  }
}

/** One `swap_offer`, in the shape `market.mine()` hands back. */
function offer(
  hash: string,
  give: WalletMarketOffer['give'],
  want: WalletMarketOffer['want'] = keiLeg(5),
): WalletMarketOffer {
  return { hash, give, want, expiresAt: null }
}

function stubMarket(rows: WalletMarketOffer[], coverage?: WalletMarketCoverage): WalletMarket {
  return {
    async mine(): Promise<WalletMarketOffers> {
      return coverage === undefined ? [...rows] : Object.assign([...rows], { coverage })
    },
  }
}

describe('summary', () => {
  test('an item locked in this account\'s own offer is reported, not dropped', async () => {
    const sword = await game.items.create({ name: 'Sword of Testing', description: 'It tests things.' })
    // Nothing was minted to this player: after `sell()` the sword is off the
    // holdings table and only the offer knows where it went.
    const player = await makePlayer(node, {
      market: stubMarket([offer(OFFER, { asset: sword.id, symbol: 'SWORD', name: 'Sword of Testing', amount: 1 })]),
    })

    const summary = await player.kei.wallet.summary()

    expect(summary.items).toEqual([])
    expect(summary.locked).toHaveLength(1)
    expect(summary.locked[0]).toMatchObject({
      asset: sword.id,
      name: 'Sword of Testing',
      amount: 1,
      item: true,
      reason: 'offer',
      offer: OFFER,
      expiresAt: null,
    })
    expect(summary.locked[0]?.want).toMatchObject({ asset: KEI_ASSET, symbol: 'KEI', amount: 5 })
    player.close()
  })

  test('a locked token is a token, and a locked item is an item', async () => {
    const sword = await game.items.create({ name: 'Sword of Testing' })
    const gems = await issueToken(game.client, { name: 'Gems', symbol: 'GEM', decimals: 0 })
    const player = await makePlayer(node, {
      market: stubMarket([
        offer('B'.repeat(64), { asset: sword.id, symbol: 'SWORD', name: 'Sword of Testing', amount: 1 }),
        offer('C'.repeat(64), { asset: gems.id, symbol: 'GEM', name: 'Gems', amount: 250 }),
      ]),
    })

    const summary = await player.kei.wallet.summary()

    expect(summary.locked.filter((holding) => holding.item).map((holding) => holding.asset)).toEqual([sword.id])
    expect(summary.locked.filter((holding) => !holding.item).map((holding) => holding.asset)).toEqual([gems.id])
    player.close()
  })

  test('Kei locked in a bid is counted apart from spendable Kei', async () => {
    const sword = await game.items.create({ name: 'Sword of Testing' })
    const player = await makePlayer(node, {
      market: stubMarket([
        offer(OFFER, keiLeg(7), { asset: sword.id, symbol: 'SWORD', name: 'Sword of Testing', amount: 1 }),
      ]),
    })
    await player.client.faucet(3)
    await player.client.receiveAll()

    const summary = await player.kei.wallet.summary()

    // Kei is not a holding and has no issuance record, so it is never a row.
    expect(summary.locked).toEqual([])
    expect(summary.keiLocked).toBe(7)
    expect(summary.kei).toBe(3)
    player.close()
  })

  test('locked rows are ordered by asset, then by the offer holding them', async () => {
    const first = await game.items.create({ name: 'Sword of Testing' })
    const second = await game.items.create({ name: 'Shield of Testing' })
    const [low, high] = first.id < second.id ? [first, second] : [second, first]
    const player = await makePlayer(node, {
      market: stubMarket([
        offer('D'.repeat(64), { asset: high!.id, symbol: 'B', name: high!.name, amount: 1 }),
        offer('C'.repeat(64), { asset: low!.id, symbol: 'A', name: low!.name, amount: 1 }),
        offer('B'.repeat(64), { asset: low!.id, symbol: 'A', name: low!.name, amount: 1 }),
      ]),
    })

    const summary = await player.kei.wallet.summary()

    expect(summary.locked.map((holding) => [holding.asset, holding.offer])).toEqual([
      [low!.id, 'B'.repeat(64)],
      [low!.id, 'C'.repeat(64)],
      [high!.id, 'D'.repeat(64)],
    ])
    player.close()
  })

  test('no market means no locked rows and nothing asked about them', async () => {
    const player = await makePlayer(node)

    const summary = await player.kei.wallet.summary()

    expect(summary.locked).toEqual([])
    expect(summary.keiLocked).toBe(0)
    player.close()
  })

  test('an own-chain read that failed is an error, never an empty inventory', async () => {
    const market = stubMarket([], { failed: [{ reason: 'the node did not answer' }] })
    const player = await makePlayer(node, { market })

    const error = (await player.kei.wallet.summary().catch((thrown: unknown) => thrown)) as KeiError

    expect(error).toBeInstanceOf(KeiError)
    expect(error.code).toBe('wallet-offers-unread')
    expect(error.message).toContain('the node did not answer')
    player.close()
  })
})

/**
 * A locked asset is named through the client's one shared asset cache (#134).
 *
 * Both halves of this have to hold at once, and neither implies the other. A
 * locked asset has left the holdings table, so the resolve set has to be widened
 * to cover it or every locked row goes unnamed — and the widened lookup has to
 * go through the cache the client shares with `items.ownedBy()`, or the wallet
 * has quietly reopened a metadata fan-out outside the only bound there is
 * (`asset-cache.ts`). Counting what reaches the node is the only way to tell the
 * two apart from outside.
 */
describe('the shared asset cache', () => {
  /** Records every asset id the cache actually asks the node about. */
  function countAssetInfo(target: MockNode): string[] {
    const asked: string[] = []
    const real = target.assetInfo.bind(target)
    target.assetInfo = async (asset) => {
      asked.push(asset)
      return real(asset)
    }
    return asked
  }

  test('a locked asset is looked up once and then remembered', async () => {
    const sword = await game.items.create({ name: 'Sword of Testing' })
    const market = stubMarket([offer(OFFER, { asset: sword.id, symbol: 'SWORD', name: 'Sword of Testing', amount: 1 })])
    const player = await makePlayer(node, { market })
    const asked = countAssetInfo(node)

    const first = await player.kei.wallet.summary()
    expect(first.locked[0]?.name).toBe('Sword of Testing')
    // Widening the resolve set is what puts it here at all.
    expect(asked.filter((asset) => asset === sword.id)).toHaveLength(1)

    asked.length = 0
    const again = await player.kei.wallet.summary()
    expect(again.locked[0]?.name).toBe('Sword of Testing')
    // An issuance record cannot change (SPEC §5.3), so the second summary names
    // it without asking again.
    expect(asked).not.toContain(sword.id)
    player.close()
  })

  test('a second wallet on the same client inherits the lookup, because the cache is the client\'s', async () => {
    const sword = await game.items.create({ name: 'Sword of Testing' })
    const market = stubMarket([offer(OFFER, { asset: sword.id, symbol: 'SWORD', name: 'Sword of Testing', amount: 1 })])
    const player = await makePlayer(node, { market })

    await player.kei.wallet.summary()
    const asked = countAssetInfo(node)

    // The point of #134: the bound and the memory belong to the client, not to
    // whichever wallet asked first. A per-wallet cache would re-ask here, and
    // that is the regression this test exists to catch.
    const second = createWallet(player.client, { market })
    const summary = await second.summary()

    expect(summary.locked).toHaveLength(1)
    expect(summary.locked[0]).toMatchObject({ asset: sword.id, name: 'Sword of Testing', item: true })
    expect(asked).not.toContain(sword.id)
    player.close()
  })

  test('a locked asset and a held one share the single resolve, not one pass each', async () => {
    const sword = await game.items.create({ name: 'Sword of Testing' })
    const gems = await issueToken(game.client, { name: 'Gems', symbol: 'GEM', decimals: 0 })
    const player = await makePlayer(node, {
      market: stubMarket([offer(OFFER, { asset: sword.id, symbol: 'SWORD', name: 'Sword of Testing', amount: 1 })]),
    })
    await game.client.submitAsset({ kind: 'mint', asset: gems.id, to: player.client.address, amount: '250' })
    await player.client.receiveAll()

    const asked = countAssetInfo(node)
    const summary = await player.kei.wallet.summary()

    // One spendable row and one locked row, each named, and exactly one lookup
    // apiece — the union is de-duplicated and bounded by the one gate.
    expect(summary.tokens.map((token) => token.asset)).toEqual([gems.id])
    expect(summary.locked.map((holding) => holding.asset)).toEqual([sword.id])
    expect(asked.filter((asset) => asset === sword.id)).toHaveLength(1)
    expect(asked.filter((asset) => asset === gems.id)).toHaveLength(1)
    player.close()
  })
})

describe('the panel', () => {
  function text(el: Element | null | undefined, selector: string): string | null {
    return el?.querySelector(selector)?.textContent ?? null
  }

  test('names the listing instead of saying there is nothing', async () => {
    const sword = await game.items.create({ name: 'Sword of Testing' })
    const player = await makePlayer(node, {
      market: stubMarket([offer(OFFER, { asset: sword.id, symbol: 'SWORD', name: 'Sword of Testing', amount: 1 })]),
    })

    const handle = WalletPanel.mount(dom.container, { kei: player.kei })
    await waitFor(() => handle.element.querySelector('.kei-wallet-panel__items .kei-wallet-panel__row') !== null)

    const row = handle.element.querySelector('.kei-wallet-panel__items .kei-wallet-panel__row--locked')
    expect(text(row, '.kei-wallet-panel__row-name')).toBe('Sword of Testing')
    expect(text(row, '.kei-wallet-panel__row-locked')).toBe('Listed for 5 KEI. Still yours until it sells.')
    expect((row as HTMLElement).dataset.offer).toBe(OFFER)
    expect(handle.element.textContent).not.toContain('No items yet.')
    handle.unmount()
    player.close()
  })

  test('"No items yet." is kept for an account that really has none', async () => {
    const player = await makePlayer(node, { market: stubMarket([]) })

    const handle = WalletPanel.mount(dom.container, { kei: player.kei })
    await waitFor(() => text(handle.element, '.kei-wallet-panel__items .kei-wallet-panel__empty') !== null)

    expect(text(handle.element, '.kei-wallet-panel__items .kei-wallet-panel__empty')).toBe('No items yet.')
    handle.unmount()
    player.close()
  })

  test('a locked token renders in the tokens section with its amount', async () => {
    const gems = await issueToken(game.client, { name: 'Gems', symbol: 'GEM', decimals: 0 })
    const player = await makePlayer(node, {
      market: stubMarket([offer(OFFER, { asset: gems.id, symbol: 'GEM', name: 'Gems', amount: 250 })]),
    })

    const handle = WalletPanel.mount(dom.container, { kei: player.kei })
    await waitFor(() => handle.element.querySelector('.kei-wallet-panel__tokens .kei-wallet-panel__row') !== null)

    const row = handle.element.querySelector('.kei-wallet-panel__tokens .kei-wallet-panel__row--locked')
    expect(text(row, '.kei-wallet-panel__row-amount')).toBe('250 GEM')
    expect(handle.element.querySelector('.kei-wallet-panel__items .kei-wallet-panel__empty')?.textContent).toBe(
      'No items yet.',
    )
    handle.unmount()
    player.close()
  })

  test('the balance line accounts for Kei a bid has locked', async () => {
    const sword = await game.items.create({ name: 'Sword of Testing' })
    const player = await makePlayer(node, {
      market: stubMarket([
        offer(OFFER, keiLeg(7), { asset: sword.id, symbol: 'SWORD', name: 'Sword of Testing', amount: 1 }),
      ]),
    })
    await player.client.faucet(3)
    await player.client.receiveAll()

    const handle = WalletPanel.mount(dom.container, { kei: player.kei })
    await waitFor(() => text(handle.element, '.kei-wallet-panel__balance .kei-wallet-panel__locked') !== null)

    expect(text(handle.element, '.kei-wallet-panel__balance .kei-wallet-panel__value')).toBe('3')
    expect(text(handle.element, '.kei-wallet-panel__balance .kei-wallet-panel__locked')).toBe(
      '7 locked in your offers',
    )
    handle.unmount()
    player.close()
  })
})
