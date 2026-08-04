/**
 * SPEC §6.4 — "cleared site data must not silently destroy a player's holdings".
 *
 * A wallet whose seed could not be saved works exactly like one that was, right
 * up until the reload that ends it. The panel is where a player finds that out,
 * so the warning is rendered first, cannot be dismissed, and carries the backup
 * control with it rather than pointing at one somewhere else.
 *
 * The seed itself is still subject to §6.6 throughout: nothing here reveals it,
 * and the reveal friction inside the warning is the same two gestures it is
 * everywhere else (reveal.test.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { MockNode, containsSecret } from '@keicoin/core'
import { WalletPanel } from '../src/index.js'
import { fire, makeDom, makePlayer, waitFor, type Dom } from './support.js'

let node: MockNode
let dom: Dom

beforeEach(async () => {
  node = await MockNode.create()
  dom = makeDom()
})

afterEach(() => {
  WalletPanel.setStreamerMode(false)
})

function allText(root: Element): string {
  const parts: string[] = [root.textContent ?? '']
  const walk = (el: Element): void => {
    for (const attr of Array.from(el.attributes)) parts.push(attr.value)
    for (const child of Array.from(el.children)) walk(child)
  }
  walk(root)
  return parts.join('\n')
}

/** The wording a player is shown, asserted exactly rather than by keyword. */
const NOTICE_TITLE = 'This wallet is not saved.'
const NOTICE_BODY =
  'It lasts until this page reloads. A reload starts a different wallet, so anything sent to this address is lost with the old one unless you have saved its hex seed. Back the seed up now if you are going to put anything here you would miss.'
const BLOCKED_BODY =
  'This game switched seed backup off, so this panel cannot show you the hex seed to save. Keep this wallet empty until the game turns backup on.'

describe('a session-only wallet says so before it is used (SPEC §6.4)', () => {
  test('the warning is the first thing in the panel, and names what a reload costs', async () => {
    const player = await makePlayer(node, { custody: { durability: 'session' } })
    const panel = WalletPanel.mount(dom.container as unknown as Element, { kei: player.kei })

    const notice = panel.element.querySelector('.kei-wallet-panel__durability')
    expect(notice).not.toBe(null)
    expect(panel.element.firstElementChild).toBe(notice as Element)
    expect(notice?.getAttribute('role')).toBe('alert')
    expect(panel.element.dataset.durability).toBe('session')

    expect(notice?.querySelector('.kei-wallet-panel__durability-title')?.textContent).toBe(NOTICE_TITLE)
    expect(notice?.querySelector('.kei-wallet-panel__durability-body')?.textContent).toBe(NOTICE_BODY)

    // Nothing dismisses it: the only control in there is the backup path.
    const buttons = Array.from(notice?.querySelectorAll('button') ?? [])
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.className).toContain('kei-wallet-panel__seed-reveal')
    expect(buttons[0]?.textContent).toBe('Back up hex seed')

    panel.unmount()
    player.close()
  })

  test('the wording calls the backup material a hex seed, and claims no loss is beyond recovery', async () => {
    const player = await makePlayer(node, { custody: { durability: 'session' } })
    const panel = WalletPanel.mount(dom.container as unknown as Element, { kei: player.kei })
    const notice = panel.element.querySelector('.kei-wallet-panel__durability') as Element

    ;(notice.querySelector('.kei-wallet-panel__seed-reveal') as HTMLElement).click()
    const shown = allText(panel.element)

    // A Kei seed is 64 hex characters. A player told to write down a "seed
    // phrase" goes looking for twelve words that do not exist.
    expect(shown).not.toContain('seed phrase')
    expect(shown).not.toContain('mnemonic')
    expect(shown).not.toContain('recovery phrase')
    expect(shown).toContain('hex seed')

    // And nothing tells a player their money is gone for good: a backed-up seed
    // restores this wallet anywhere, which is the whole point of backing it up.
    expect(shown).not.toContain('nothing can get it back')
    expect(shown).not.toContain('gone forever')
    expect(shown).not.toContain('cannot be recovered')

    expect(notice.querySelector('.kei-wallet-panel__seed-warning')?.textContent).toBe(
      'This is the 64-character hex seed for this wallet. Anyone who sees it can take everything in it. Make sure nobody is watching or recording your screen.',
    )

    panel.unmount()
    player.close()
  })

  test('the backup path is inside the warning, and still costs two deliberate gestures', async () => {
    const player = await makePlayer(node, { custody: { durability: 'session' } })
    const panel = WalletPanel.mount(dom.container as unknown as Element, { kei: player.kei })
    const notice = panel.element.querySelector('.kei-wallet-panel__durability') as Element

    // Nothing readable before the player asks — the seed is not sitting in the
    // DOM waiting for dev tools (SPEC §6.6).
    expect(containsSecret(allText(panel.element))).toBe(false)

    ;(notice.querySelector('.kei-wallet-panel__seed-reveal') as HTMLElement).click()
    expect(notice.querySelector('.kei-wallet-panel__seed-warning')).not.toBe(null)
    expect(containsSecret(allText(panel.element))).toBe(false)

    const hold = notice.querySelector('.kei-wallet-panel__seed-hold') as HTMLElement
    fire(dom.window, hold, 'mouse', 'mousedown')
    expect(notice.querySelector('.kei-wallet-panel__seed-value')?.textContent).toBe(player.kei.seed)

    fire(dom.window, hold, 'mouse', 'mouseup')
    expect(containsSecret(allText(panel.element))).toBe(false)

    panel.unmount()
    player.close()
  })

  test('when the game switched backup off, the warning says the panel cannot show the seed', async () => {
    const player = await makePlayer(node, { reveal: 'never', custody: { durability: 'session' } })
    const panel = WalletPanel.mount(dom.container as unknown as Element, { kei: player.kei })
    const notice = panel.element.querySelector('.kei-wallet-panel__durability') as Element

    expect(notice.querySelector('.kei-wallet-panel__durability-blocked')?.textContent).toBe(BLOCKED_BODY)
    expect(notice.querySelectorAll('button')).toHaveLength(0)
    expect(notice.textContent).toContain('Seed backup is disabled for this wallet.')
    expect(containsSecret(allText(panel.element))).toBe(false)

    panel.unmount()
    player.close()
  })

  test("reveal: 'always' puts the seed inside the warning, and the warning still comes first", async () => {
    // Whatever backup path the game configured is the one the warning carries.
    // `always` is documented development-only, and the point here is that the
    // notice is not conditional on the policy: it is first, undismissable, and
    // the material a player would save is inside it rather than beside it.
    const player = await makePlayer(node, { reveal: 'always', custody: { durability: 'session' } })
    const panel = WalletPanel.mount(dom.container as unknown as Element, { kei: player.kei })
    const notice = panel.element.querySelector('.kei-wallet-panel__durability') as Element

    expect(panel.element.firstElementChild).toBe(notice)
    expect(notice.querySelector('.kei-wallet-panel__durability-body')?.textContent).toBe(NOTICE_BODY)
    expect(notice.querySelector('.kei-wallet-panel__seed-value')?.textContent).toBe(player.kei.seed)
    expect(notice.querySelector('.kei-wallet-panel__durability-blocked')).toBe(null)

    panel.unmount()
    player.close()
  })

  test('streamer mode suppresses the reveal and leaves the warning standing', async () => {
    const player = await makePlayer(node, { custody: { durability: 'session' } })
    const panel = WalletPanel.mount(dom.container as unknown as Element, { kei: player.kei })
    WalletPanel.setStreamerMode(true)

    const notice = panel.element.querySelector('.kei-wallet-panel__durability') as Element
    expect(notice.textContent).toContain('not saved')
    expect(notice.querySelector('.kei-wallet-panel__seed-reveal')).toBe(null)
    expect(notice.textContent).toContain('streamer mode is on')
    expect(containsSecret(allText(panel.element))).toBe(false)

    panel.unmount()
    player.close()
  })

  test('the balances still render — the warning is above them, not instead of them', async () => {
    const player = await makePlayer(node, { custody: { durability: 'session' } })
    await player.client.node.faucet(player.client.address, (3n * 10n ** 18n).toString())
    await player.client.receiveAll()

    const panel = WalletPanel.mount(dom.container as unknown as Element, { kei: player.kei })
    const balance = panel.element.querySelector('.kei-wallet-panel__balance') as HTMLElement
    await waitFor(() => (balance.textContent ?? '').includes('3'))

    expect(panel.element.firstElementChild?.className).toContain('kei-wallet-panel__durability')

    panel.unmount()
    player.close()
  })
})

describe('a wallet that is kept does not nag about it', () => {
  test('a persisted wallet renders no warning, and marks itself persistent', async () => {
    const player = await makePlayer(node, { custody: { durability: 'persistent' } })
    const panel = WalletPanel.mount(dom.container as unknown as Element, { kei: player.kei })

    expect(panel.element.querySelector('.kei-wallet-panel__durability')).toBe(null)
    expect(panel.element.dataset.durability).toBe('persistent')
    expect(panel.element.querySelector('.kei-wallet-panel__seed-reveal')).not.toBe(null)

    panel.unmount()
    player.close()
  })

  test('a seed the caller supplied is theirs to keep, so the panel says nothing either', async () => {
    const player = await makePlayer(node, { custody: { durability: 'supplied' } })
    const panel = WalletPanel.mount(dom.container as unknown as Element, { kei: player.kei })

    expect(panel.element.querySelector('.kei-wallet-panel__durability')).toBe(null)
    expect(panel.element.dataset.durability).toBe('supplied')

    panel.unmount()
    player.close()
  })

  test('a kei object with no custody at all still mounts, and claims nothing', async () => {
    const player = await makePlayer(node)
    const panel = WalletPanel.mount(dom.container as unknown as Element, { kei: player.kei })

    expect(panel.element.querySelector('.kei-wallet-panel__durability')).toBe(null)
    expect(panel.element.dataset.durability).toBeUndefined()

    panel.unmount()
    player.close()
  })
})
