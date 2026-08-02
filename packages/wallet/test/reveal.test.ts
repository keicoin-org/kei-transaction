/**
 * SPEC §6.6 — the `reveal` policy and the global streamer-mode switch.
 *
 * `WalletPanel.setStreamerMode` is process-global state (by design — the
 * failure it defends against does not care which panel is on screen), so
 * every test resets it in `afterEach` to avoid leaking into other files in
 * this shared `bun test` process.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { MockNode, randomSeed } from '@keicoin/core'
import { WalletPanel } from '../src/index.js'
import { fire, makeDom, makePlayer, type Dom, type TestPlayer } from './support.js'

let node: MockNode
let dom: Dom

beforeEach(async () => {
  node = await MockNode.create()
  dom = makeDom()
})

afterEach(() => {
  WalletPanel.setStreamerMode(false)
})

function seedSection(el: Element): Element {
  const section = el.querySelector('.kei-wallet-panel__seed')
  if (!section) throw new Error('no seed section rendered')
  return section
}

describe("reveal: 'never'", () => {
  test('there is no reveal path at all', async () => {
    // `kei.seed` itself throws under reveal: 'never' (packages/core/src/client.ts)
    // — the point of this test — so the known seed comes from the fixture, not
    // from asking the panel's own `kei` for it.
    const seed = randomSeed()
    const player = await makePlayer(node, { seed, reveal: 'never' })
    const handle = WalletPanel.mount(dom.container, { kei: player.kei })

    const section = seedSection(handle.element)
    expect(section.querySelector('button')).toBeNull()
    expect(section.textContent).not.toContain(seed)
    expect(handle.element.textContent ?? '').not.toContain(seed)
    expect(() => player.kei.seed).toThrow(/reveal: 'never'/)

    handle.unmount()
  })
})

describe("reveal: 'always'", () => {
  test('is visible immediately, with no interaction, while streamer mode is off', async () => {
    const player = await makePlayer(node, { reveal: 'always' })
    const handle = WalletPanel.mount(dom.container, { kei: player.kei })

    const section = seedSection(handle.element)
    expect(section.textContent).toContain(player.kei.seed)
    handle.unmount()
  })

  test('is hidden while streamer mode is on, and reappears when it is off', async () => {
    const player = await makePlayer(node, { reveal: 'always' })
    const handle = WalletPanel.mount(dom.container, { kei: player.kei })
    expect(seedSection(handle.element).textContent).toContain(player.kei.seed)

    WalletPanel.setStreamerMode(true)
    expect(seedSection(handle.element).textContent).not.toContain(player.kei.seed)

    WalletPanel.setStreamerMode(false)
    expect(seedSection(handle.element).textContent).toContain(player.kei.seed)
    handle.unmount()
  })
})

describe("reveal: 'on-request'", () => {
  let player: TestPlayer

  beforeEach(async () => {
    player = await makePlayer(node)
  })

  test('the seed is absent until confirmed and held, then present, then absent again on release', () => {
    const handle = WalletPanel.mount(dom.container, { kei: player.kei })
    const section = seedSection(handle.element)

    // Nothing to reveal yet: just a button, no risk text, no seed.
    expect(section.querySelector('.kei-wallet-panel__seed-reveal')).not.toBeNull()
    expect(section.querySelector('.kei-wallet-panel__seed-hold')).toBeNull()
    expect(handle.element.textContent ?? '').not.toContain(player.kei.seed)

    // Click: the risk warning appears, and the seed is still nowhere — only a
    // masked placeholder exists, and it is not the seed's own characters.
    ;(section.querySelector('.kei-wallet-panel__seed-reveal') as HTMLElement).click()
    expect(section.querySelector('.kei-wallet-panel__seed-warning')).not.toBeNull()
    const holdButton = section.querySelector('.kei-wallet-panel__seed-hold') as HTMLElement
    expect(holdButton).not.toBeNull()
    expect(handle.element.textContent ?? '').not.toContain(player.kei.seed)

    // Press and hold: now, and only now, the seed itself is in the DOM.
    fire(dom.window, holdButton, 'mouse', 'mousedown')
    expect(section.querySelector('.kei-wallet-panel__seed-value')?.textContent).toBe(player.kei.seed)

    // Release: it is gone again, immediately.
    fire(dom.window, holdButton, 'mouse', 'mouseup')
    expect(section.querySelector('.kei-wallet-panel__seed-value')?.textContent).not.toBe(player.kei.seed)
    expect(handle.element.textContent ?? '').not.toContain(player.kei.seed)

    handle.unmount()
  })

  test('releasing anywhere in the document ends the hold, not just on the button', () => {
    const handle = WalletPanel.mount(dom.container, { kei: player.kei })
    const section = seedSection(handle.element)
    ;(section.querySelector('.kei-wallet-panel__seed-reveal') as HTMLElement).click()
    const holdButton = section.querySelector('.kei-wallet-panel__seed-hold') as HTMLElement

    fire(dom.window, holdButton, 'mouse', 'mousedown')
    expect(section.querySelector('.kei-wallet-panel__seed-value')?.textContent).toBe(player.kei.seed)

    // The pointer left the button before it came up — a document-wide mouseup
    // must still end the hold.
    fire(dom.window, dom.document.body, 'mouse', 'mouseup')
    expect(section.querySelector('.kei-wallet-panel__seed-value')?.textContent).not.toBe(player.kei.seed)
    handle.unmount()
  })

  test('keyboard hold (Enter/Space) works the same way, and keyup releases it', () => {
    const handle = WalletPanel.mount(dom.container, { kei: player.kei })
    const section = seedSection(handle.element)
    ;(section.querySelector('.kei-wallet-panel__seed-reveal') as HTMLElement).click()
    const holdButton = section.querySelector('.kei-wallet-panel__seed-hold') as HTMLElement

    fire(dom.window, holdButton, 'keyboard', 'keydown', { key: 'Enter' })
    expect(section.querySelector('.kei-wallet-panel__seed-value')?.textContent).toBe(player.kei.seed)

    fire(dom.window, holdButton, 'keyboard', 'keyup', { key: 'Enter' })
    expect(section.querySelector('.kei-wallet-panel__seed-value')?.textContent).not.toBe(player.kei.seed)
    handle.unmount()
  })

  test('cancel collapses back to the initial button and ends any hold', () => {
    const handle = WalletPanel.mount(dom.container, { kei: player.kei })
    const section = seedSection(handle.element)
    ;(section.querySelector('.kei-wallet-panel__seed-reveal') as HTMLElement).click()
    const holdButton = section.querySelector('.kei-wallet-panel__seed-hold') as HTMLElement
    fire(dom.window, holdButton, 'mouse', 'mousedown')

    ;(section.querySelector('.kei-wallet-panel__seed-cancel') as HTMLElement).click()
    expect(section.querySelector('.kei-wallet-panel__seed-hold')).toBeNull()
    expect(section.querySelector('.kei-wallet-panel__seed-reveal')).not.toBeNull()
    expect(handle.element.textContent ?? '').not.toContain(player.kei.seed)
    handle.unmount()
  })
})

describe('global streamer mode', () => {
  test('immediately suppresses seed material on every mounted panel, of every policy', async () => {
    const always = await makePlayer(node, { reveal: 'always' })
    const onRequest = await makePlayer(node)

    const alwaysDom = makeDom()
    const alwaysHandle = WalletPanel.mount(alwaysDom.container, { kei: always.kei })

    const requestHandle = WalletPanel.mount(dom.container, { kei: onRequest.kei })
    const section = seedSection(requestHandle.element)
    ;(section.querySelector('.kei-wallet-panel__seed-reveal') as HTMLElement).click()
    const holdButton = section.querySelector('.kei-wallet-panel__seed-hold') as HTMLElement
    fire(dom.window, holdButton, 'mouse', 'mousedown')
    expect(section.querySelector('.kei-wallet-panel__seed-value')?.textContent).toBe(onRequest.kei.seed)

    WalletPanel.setStreamerMode(true)

    expect(seedSection(alwaysHandle.element).textContent).not.toContain(always.kei.seed)
    expect(requestHandle.element.textContent ?? '').not.toContain(onRequest.kei.seed)
    // The reveal path itself disappears — nothing left to click or hold.
    expect(seedSection(requestHandle.element).querySelector('button')).toBeNull()

    // Even the (now detached) hold button, if somehow triggered, must not
    // resurrect the seed: the guard lives in the handler, not only in the DOM.
    fire(dom.window, holdButton, 'mouse', 'mousedown')
    expect(requestHandle.element.textContent ?? '').not.toContain(onRequest.kei.seed)

    alwaysHandle.unmount()
    requestHandle.unmount()
  })

  test('turning it off never auto-reveals: always resumes, on-request re-arms from closed', async () => {
    const always = await makePlayer(node, { reveal: 'always' })
    const onRequest = await makePlayer(node)

    const alwaysDom = makeDom()
    const alwaysHandle = WalletPanel.mount(alwaysDom.container, { kei: always.kei })
    const requestHandle = WalletPanel.mount(dom.container, { kei: onRequest.kei })
    const section = seedSection(requestHandle.element)
    ;(section.querySelector('.kei-wallet-panel__seed-reveal') as HTMLElement).click()

    WalletPanel.setStreamerMode(true)
    WalletPanel.setStreamerMode(false)

    // 'always' needed no confirmation before, so it needs none now either.
    expect(seedSection(alwaysHandle.element).textContent).toContain(always.kei.seed)

    // 'on-request' must not skip back to the open/armed state automatically.
    expect(section.querySelector('.kei-wallet-panel__seed-hold')).toBeNull()
    expect(section.querySelector('.kei-wallet-panel__seed-reveal')).not.toBeNull()
    expect(requestHandle.element.textContent ?? '').not.toContain(onRequest.kei.seed)

    alwaysHandle.unmount()
    requestHandle.unmount()
  })

  test('a panel mounted while streamer mode is already on starts suppressed', async () => {
    WalletPanel.setStreamerMode(true)
    const onRequest = await makePlayer(node)
    const handle = WalletPanel.mount(dom.container, { kei: onRequest.kei })

    const section = seedSection(handle.element)
    expect(section.querySelector('button')).toBeNull()
    expect(section.textContent).toMatch(/streamer mode/i)
    handle.unmount()
  })
})
