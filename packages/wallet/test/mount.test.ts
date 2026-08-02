/**
 * SPEC §6.5, M6 — the mountable panel: balance, tokens, items, and pending
 * claims, with `show` filtering, theming, live refresh, and deterministic
 * unmount.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { MockNode } from '@keicoin/core'
import { issueToken } from '@keicoin/tokens'
import { WalletPanel } from '../src/index.js'
import { makeDom, makeIssuer, makePlayer, waitFor, type Dom, type TestIssuer, type TestPlayer } from './support.js'

let node: MockNode
let game: TestIssuer
let player: TestPlayer
let dom: Dom

beforeEach(async () => {
  node = await MockNode.create()
  game = await makeIssuer(node)
  player = await makePlayer(node)
  dom = makeDom()
})

function text(el: Element | null | undefined, selector: string): string | null {
  return el?.querySelector(selector)?.textContent ?? null
}

describe('rendering', () => {
  test('shows balance, tokens, items, and pending claims', async () => {
    const gems = await issueToken(game.client, { name: 'Gems', symbol: 'GEM', decimals: 0 })
    const sword = await game.items.create({ name: 'Sword of Testing' })
    await gems.mint(player.client.address, 250)
    await game.items.mint(sword.id, player.client.address)
    await player.client.faucet(3)
    await player.client.receiveAll()

    // A claim the player holds a proof for but has not yet claimed.
    const held = await makePlayer(node, { autoClaim: false })
    const potions = await issueToken(game.client, { name: 'Potions', symbol: 'POT', decimals: 0 })
    const drop = await potions.commit([{ to: held.client.address, amount: 9 }])
    await held.claims.add(drop.proofFor(held.client.address))

    const handle = WalletPanel.mount(dom.container, { kei: player.kei })
    await waitFor(() => text(handle.element, '.kei-wallet-panel__balance .kei-wallet-panel__value') === '3')

    expect(text(handle.element, '.kei-wallet-panel__tokens .kei-wallet-panel__row-amount')).toBe('250 GEM')
    expect(text(handle.element, '.kei-wallet-panel__items .kei-wallet-panel__row-name')).toBe('Sword of Testing')
    expect(text(handle.element, '.kei-wallet-panel__claims .kei-wallet-panel__empty')).toBe('Nothing pending.')

    const heldDom = makeDom()
    const heldHandle = WalletPanel.mount(heldDom.container, { kei: held.kei })
    await waitFor(() => heldHandle.element.querySelector('.kei-wallet-panel__claims .kei-wallet-panel__row') !== null)
    expect(text(heldHandle.element, '.kei-wallet-panel__claims .kei-wallet-panel__row-name')).toBe('9 POT (unclaimed)')

    handle.unmount()
    heldHandle.unmount()
    held.close()
  })

  test('empty sections say so instead of rendering nothing', async () => {
    const handle = WalletPanel.mount(dom.container, { kei: player.kei })
    await waitFor(() => text(handle.element, '.kei-wallet-panel__balance .kei-wallet-panel__value') === '0')

    expect(text(handle.element, '.kei-wallet-panel__tokens .kei-wallet-panel__empty')).toBe('No tokens yet.')
    expect(text(handle.element, '.kei-wallet-panel__items .kei-wallet-panel__empty')).toBe('No items yet.')
    expect(text(handle.element, '.kei-wallet-panel__claims .kei-wallet-panel__empty')).toBe('Nothing pending.')
    handle.unmount()
  })
})

describe('show filtering', () => {
  test('only renders the requested sections', () => {
    const handle = WalletPanel.mount(dom.container, { kei: player.kei, show: ['balance'] })
    expect(handle.element.querySelector('.kei-wallet-panel__balance')).not.toBeNull()
    expect(handle.element.querySelector('.kei-wallet-panel__tokens')).toBeNull()
    expect(handle.element.querySelector('.kei-wallet-panel__items')).toBeNull()
    expect(handle.element.querySelector('.kei-wallet-panel__claims')).toBeNull()
    handle.unmount()
  })

  test('"inventory" is an alias for "items"', () => {
    const handle = WalletPanel.mount(dom.container, { kei: player.kei, show: ['balance', 'inventory', 'claims'] })
    expect(handle.element.querySelector('.kei-wallet-panel__items')).not.toBeNull()
    expect(handle.element.querySelector('.kei-wallet-panel__tokens')).toBeNull()
    handle.unmount()
  })

  test('defaults to every section when `show` is omitted', () => {
    const handle = WalletPanel.mount(dom.container, { kei: player.kei })
    for (const section of ['balance', 'tokens', 'items', 'claims']) {
      expect(handle.element.querySelector(`.kei-wallet-panel__${section}`)).not.toBeNull()
    }
    handle.unmount()
  })
})

describe('theme', () => {
  test('a string theme becomes a modifier class', () => {
    const handle = WalletPanel.mount(dom.container, { kei: player.kei, theme: 'dark' })
    expect(handle.element.classList.contains('kei-wallet-panel--dark')).toBe(true)
    handle.unmount()
  })

  test('an object theme sets CSS custom properties', () => {
    const handle = WalletPanel.mount(dom.container, {
      kei: player.kei,
      theme: { '--kei-wallet-accent': '#7c3aed', background: '#111111' },
    })
    const style = (handle.element as HTMLElement).style
    expect(style.getPropertyValue('--kei-wallet-accent')).toBe('#7c3aed')
    expect(style.getPropertyValue('--background')).toBe('#111111')
    handle.unmount()
  })

  test('no theme means no modifier class', () => {
    const handle = WalletPanel.mount(dom.container, { kei: player.kei })
    expect([...handle.element.classList]).toEqual(['kei-wallet-panel'])
    handle.unmount()
  })
})

describe('live refresh', () => {
  test('the panel updates after a mint, with no remount', async () => {
    const gems = await issueToken(game.client, { name: 'Gems', symbol: 'GEM', decimals: 0 })
    const handle = WalletPanel.mount(dom.container, { kei: player.kei, show: ['tokens'] })
    await waitFor(() => handle.element.querySelector('.kei-wallet-panel__tokens .kei-wallet-panel__empty') !== null)

    const panelElementBefore = handle.element
    await gems.mint(player.client.address, 40)
    await player.client.receiveAll()

    await waitFor(() => text(handle.element, '.kei-wallet-panel__row-amount') === '40 GEM')
    expect(handle.element).toBe(panelElementBefore)

    handle.unmount()
  })

  test('a second mint keeps the panel in sync', async () => {
    const gems = await issueToken(game.client, { name: 'Gems', symbol: 'GEM', decimals: 0 })
    await gems.mint(player.client.address, 1)
    await player.client.receiveAll()

    const handle = WalletPanel.mount(dom.container, { kei: player.kei, show: ['tokens'] })
    await waitFor(() => text(handle.element, '.kei-wallet-panel__row-amount') === '1 GEM')

    await gems.mint(player.client.address, 9)
    await player.client.receiveAll()
    await waitFor(() => text(handle.element, '.kei-wallet-panel__row-amount') === '10 GEM')

    handle.unmount()
  })
})

describe('unmount', () => {
  test('removes the panel from the DOM and stops listening', async () => {
    const gems = await issueToken(game.client, { name: 'Gems', symbol: 'GEM', decimals: 0 })
    const handle = WalletPanel.mount(dom.container, { kei: player.kei, show: ['tokens'] })
    await waitFor(() => handle.element.querySelector('.kei-wallet-panel__tokens .kei-wallet-panel__empty') !== null)

    handle.unmount()
    expect(dom.container.querySelector('.kei-wallet-panel')).toBeNull()
    expect(dom.container.childNodes.length).toBe(0)

    // A change after unmount must not throw, and must not resurrect any DOM.
    await gems.mint(player.client.address, 5)
    await player.client.receiveAll()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(dom.container.childNodes.length).toBe(0)
  })

  test('unmount is idempotent', () => {
    const handle = WalletPanel.mount(dom.container, { kei: player.kei })
    handle.unmount()
    expect(() => handle.unmount()).not.toThrow()
  })

  test('mounting the same kei twice produces two independent panels', () => {
    const domB = makeDom()
    const handleA = WalletPanel.mount(dom.container, { kei: player.kei })
    const handleB = WalletPanel.mount(domB.container, { kei: player.kei })
    expect(handleA.element).not.toBe(handleB.element)
    handleA.unmount()
    expect(domB.container.querySelector('.kei-wallet-panel')).not.toBeNull()
    handleB.unmount()
  })
})

describe('mount target validation', () => {
  test('a selector with nothing to match throws a sentence naming the fix', () => {
    // Resolving a CSS selector goes through the real global `document`
    // (SPEC's `WalletPanel.mount('#wallet', ...)`); this test provides one for
    // exactly the duration of the assertion so no other file in this shared
    // `bun test` process ever observes it (see support.ts's doc comment).
    const scope = globalThis as { document?: unknown }
    const hadDocument = 'document' in scope
    const original = scope.document
    scope.document = dom.document
    try {
      expect(() => WalletPanel.mount('#does-not-exist', { kei: player.kei })).toThrow(/found nothing matching/)
    } finally {
      if (hadDocument) scope.document = original
      else delete scope.document
    }
  })

  test('a selector with no global document throws asking for an Element instead', () => {
    expect(() => WalletPanel.mount('#wallet', { kei: player.kei })).toThrow(/needs a browser DOM/)
  })

  test('missing kei throws', () => {
    expect(() => WalletPanel.mount(dom.container, {} as never)).toThrow(/needs the kei instance/)
  })

  test('a target that is neither a string nor an element throws', () => {
    expect(() => WalletPanel.mount(42 as unknown as Element, { kei: player.kei })).toThrow(
      /CSS selector string or a DOM Element/,
    )
  })
})
