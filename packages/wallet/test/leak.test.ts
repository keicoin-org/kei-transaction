/**
 * SPEC §6.6 and acceptance criterion 8 — no seed in logs, errors, serialisation,
 * URLs, clipboard, network requests, data attributes, or DOM the player has not
 * explicitly asked to see. `registerSecret` is called for every seed a
 * `KeiClient` is built with (packages/core/src/client.ts), so `containsSecret`
 * is the same repo-wide scrubbing check `packages/kei/test/trust.test.ts` uses
 * for the rest of the SDK — this file is that test, for the panel.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { MockNode, containsSecret, randomSeed } from '@keicoin/core'
import { WalletPanel } from '../src/index.js'
import { fire, makeDom, makePlayer, waitFor, type Dom, type TestPlayer } from './support.js'

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

function spyConsole(): { calls: string[]; restore(): void } {
  const calls: string[] = []
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
  const originals = methods.map((name) => console[name])
  for (const name of methods) {
    console[name] = (...args: unknown[]): void => {
      calls.push(args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack ?? ''}` : String(arg))).join(' '))
    }
  }
  return {
    calls,
    restore(): void {
      methods.forEach((name, i) => {
        console[name] = originals[i] as Console[typeof name]
      })
    },
  }
}

async function revealOnce(dom: Dom, section: Element, player: TestPlayer): Promise<HTMLElement> {
  ;(section.querySelector('.kei-wallet-panel__seed-reveal') as HTMLElement).click()
  const holdButton = section.querySelector('.kei-wallet-panel__seed-hold') as HTMLElement
  fire(dom.window, holdButton, 'mouse', 'mousedown')
  expect(section.querySelector('.kei-wallet-panel__seed-value')?.textContent).toBe(player.kei.seed)
  return holdButton
}

describe('no leaks: console, errors, serialisation', () => {
  test('console output during a full reveal/release cycle never contains the seed', async () => {
    const player = await makePlayer(node)
    const spy = spyConsole()
    try {
      const handle = WalletPanel.mount(dom.container, { kei: player.kei })
      const section = handle.element.querySelector('.kei-wallet-panel__seed') as Element
      const holdButton = await revealOnce(dom, section, player)
      fire(dom.window, holdButton, 'mouse', 'mouseup')
      handle.unmount()
    } finally {
      spy.restore()
    }
    for (const line of spy.calls) {
      expect(containsSecret(line)).toBe(false)
      expect(line).not.toContain(player.kei.seed)
    }
  })

  test('an invalid mount target throws, and the error never contains a seed', async () => {
    const player = await makePlayer(node)
    let caught: unknown
    try {
      WalletPanel.mount('#nothing-here-and-no-global-document', { kei: player.kei })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    const message = String((caught as Error).message)
    expect(containsSecret(message)).toBe(false)
    expect(message).not.toContain(player.kei.seed)
  })

  test('a rejected wallet.summary() renders an error note with no seed in it', async () => {
    const player = await makePlayer(node)
    const brokenKei = {
      ...player.kei,
      wallet: {
        ...player.kei.wallet,
        summary: () => Promise.reject(new Error(`boom, and definitely not ${player.kei.seed}`)),
      },
    }
    const handle = WalletPanel.mount(dom.container, { kei: brokenKei })
    await waitFor(() => handle.element.querySelector('.kei-wallet-panel__error') !== null)
    const errorText = handle.element.querySelector('.kei-wallet-panel__error')?.textContent ?? ''
    expect(errorText).not.toContain(player.kei.seed)
    handle.unmount()
  })

  test('nothing reachable from the mount handle serialises the seed', async () => {
    const player = await makePlayer(node, { reveal: 'always' })
    const handle = WalletPanel.mount(dom.container, { kei: player.kei })
    expect(JSON.stringify(handle)).not.toContain(player.kei.seed)
    expect(JSON.stringify({ address: handle.element.tagName })).not.toContain(player.kei.seed)
    handle.unmount()
  })
})

describe('no leaks: DOM, clipboard, network, URLs', () => {
  test('the seed never sits in the DOM before a hold is active, under any policy', async () => {
    for (const reveal of ['on-request', 'never', 'always'] as const) {
      const seed = randomSeed()
      const player = await makePlayer(node, { seed, reveal })
      const localDom = makeDom()
      const handle = WalletPanel.mount(localDom.container, { kei: player.kei })

      if (reveal === 'always') {
        // The one policy where this is the documented, friction-free behaviour.
        expect(allText(handle.element)).toContain(seed)
      } else {
        expect(allText(handle.element)).not.toContain(seed)
      }
      handle.unmount()
    }
  })

  test('no data-* attribute anywhere ever holds the seed, including mid-reveal', async () => {
    const player = await makePlayer(node)
    const handle = WalletPanel.mount(dom.container, { kei: player.kei })
    const section = handle.element.querySelector('.kei-wallet-panel__seed') as Element
    await revealOnce(dom, section, player)

    const attributeValues: string[] = []
    const walk = (el: Element): void => {
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith('data-')) attributeValues.push(attr.value)
      }
      for (const child of Array.from(el.children)) walk(child)
    }
    walk(handle.element)
    for (const value of attributeValues) expect(value).not.toContain(player.kei.seed)
    handle.unmount()
  })

  test('the clipboard is never written to, even across a full reveal', async () => {
    const player = await makePlayer(node)
    const writes: unknown[] = []
    dom.window.navigator.clipboard.writeText = ((text: string) => {
      writes.push(text)
      return Promise.resolve()
    }) as typeof dom.window.navigator.clipboard.writeText

    const handle = WalletPanel.mount(dom.container, { kei: player.kei })
    const section = handle.element.querySelector('.kei-wallet-panel__seed') as Element
    const holdButton = await revealOnce(dom, section, player)
    fire(dom.window, holdButton, 'mouse', 'mouseup')
    handle.unmount()

    expect(writes).toHaveLength(0)
  })

  test('no fetch/network call happens because of mounting or revealing', async () => {
    const player = await makePlayer(node)
    const calls: unknown[] = []
    const original = dom.window.fetch
    dom.window.fetch = ((...args: unknown[]) => {
      calls.push(args)
      return Promise.reject(new Error('no network call should happen'))
    }) as typeof dom.window.fetch

    try {
      const handle = WalletPanel.mount(dom.container, { kei: player.kei })
      const section = handle.element.querySelector('.kei-wallet-panel__seed') as Element
      const holdButton = await revealOnce(dom, section, player)
      fire(dom.window, holdButton, 'mouse', 'mouseup')
      handle.unmount()
    } finally {
      dom.window.fetch = original
    }
    expect(calls).toHaveLength(0)
  })

  test('the document location never changes because of a reveal', async () => {
    const player = await makePlayer(node)
    const before = dom.window.location.href
    const handle = WalletPanel.mount(dom.container, { kei: player.kei })
    const section = handle.element.querySelector('.kei-wallet-panel__seed') as Element
    const holdButton = await revealOnce(dom, section, player)
    fire(dom.window, holdButton, 'mouse', 'mouseup')
    expect(dom.window.location.href).toBe(before)
    handle.unmount()
  })
})
