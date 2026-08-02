/**
 * Test-only plumbing.
 *
 * `@keicoin/wallet` depends only on `@keicoin/core`, `@keicoin/claims`, and
 * `@keicoin/tokens` (see package.json) — deliberately not on `kei-transaction`,
 * which itself depends on this package. So these tests build a `KeiClient`
 * directly against `MockNode`, the same way `packages/core/test` does, rather
 * than reaching for the `Kei` facade.
 *
 * DOM: happy-dom's `Window` is constructed fresh per test and never registered
 * globally. `packages/kei/test/trust.test.ts` toggles `globalThis.window` /
 * `globalThis.document` to prove `Kei.server()` refuses to run in a browser —
 * `bun test` runs every package's tests in one process, so a global `document`
 * left behind by this file would make that check pass unconditionally for the
 * rest of the run. Casting a happy-dom element to the ambient `Element` type at
 * this one boundary, and passing it to `WalletPanel.mount` directly, avoids ever
 * touching those globals.
 */

import { Window } from 'happy-dom'
import {
  KeiClient,
  MockNode,
  generateWork,
  keyPairFromSeed,
  randomSeed,
  type KeiNode,
  type RevealPolicy,
  type Role,
  type WorkProvider,
  type WorkTier,
} from '@keicoin/core'
import { createClaims } from '@keicoin/claims'
import { createIssuerItems, createPlayerItems, type IssuerItemsApi, type PlayerItemsApi } from '@keicoin/tokens'
import { createWallet } from '../src/index.js'
import type { WalletPanelKei } from '../src/panel.js'

/** Generates work locally against whatever thresholds the node advertises. */
function localWork(node: KeiNode): WorkProvider {
  let thresholds: Record<WorkTier, string> | undefined
  return {
    async generate(root, tier) {
      thresholds ??= await node.workThresholds()
      return generateWork(root, BigInt(thresholds[tier]))
    },
  }
}

interface BaseWallet {
  client: KeiClient
  kei: WalletPanelKei
  claims: ReturnType<typeof createClaims>
  close(): void
}

async function baseWallet(
  node: MockNode,
  role: Role,
  options: { seed?: string; reveal?: RevealPolicy; autoClaim?: boolean },
): Promise<BaseWallet> {
  const keys = await keyPairFromSeed(options.seed ?? randomSeed())
  const client = new KeiClient({
    node,
    work: localWork(node),
    keys,
    role,
    ...(options.reveal === undefined ? {} : { reveal: options.reveal }),
  })
  await client.start()

  const claims = createClaims(client, options.autoClaim === false ? { autoClaim: false } : {})
  const wallet = createWallet(client, { claims })
  // Matches the real `Kei` class's public shape exactly (SPEC §6.5) — see
  // WalletPanelKei's doc comment — so no adapter is needed here either.
  const kei: WalletPanelKei = {
    address: client.address,
    get seed() {
      return client.seed
    },
    client: {
      get reveal() {
        return client.reveal
      },
    },
    wallet,
  }

  return { client, kei, claims, close: () => client.close() }
}

export interface TestPlayer extends BaseWallet {
  items: PlayerItemsApi
}

export interface TestIssuer extends BaseWallet {
  items: IssuerItemsApi
}

export async function makePlayer(
  node: MockNode,
  options: { seed?: string; reveal?: RevealPolicy; autoClaim?: boolean } = {},
): Promise<TestPlayer> {
  const base = await baseWallet(node, 'player', options)
  return { ...base, items: createPlayerItems(base.client) }
}

/** Funded, so it can afford to issue tokens/items straight away. */
export async function makeIssuer(
  node: MockNode,
  options: { seed?: string; reveal?: RevealPolicy } = {},
): Promise<TestIssuer> {
  const base = await baseWallet(node, 'issuer', { seed: options.seed ?? 'C'.repeat(64), reveal: options.reveal })
  await base.client.node.faucet(base.client.address, (20_000n * 10n ** 18n).toString())
  await base.client.receiveAll()
  return { ...base, items: createIssuerItems(base.client) }
}

export interface Dom {
  window: Window
  document: Document
  container: HTMLElement
}

/** A fresh, unregistered happy-dom document with an empty mount point already attached to <body>. */
export function makeDom(): Dom {
  const window = new Window()
  const document = window.document as unknown as Document
  const container = document.createElement('div')
  document.body.appendChild(container)
  return { window, document, container }
}

type EventKind = 'mouse' | 'keyboard' | 'generic'

/**
 * Dispatches a real happy-dom event through `window`, typed loosely at this
 * one boundary only. Bubbles by default, like the real user-generated mouse,
 * touch, and keyboard events this is standing in for.
 */
export function fire(window: Window, target: HTMLElement, kind: EventKind, type: string, init: Record<string, unknown> = {}): void {
  const Ctor = kind === 'mouse' ? window.MouseEvent : kind === 'keyboard' ? window.KeyboardEvent : window.Event
  const event = new (Ctor as unknown as new (type: string, init?: Record<string, unknown>) => unknown)(type, {
    bubbles: true,
    ...init,
  })
  ;(target as unknown as { dispatchEvent(event: unknown): void }).dispatchEvent(event)
}

/**
 * Polls until `predicate` is true. Panel rendering follows an async
 * `wallet.summary()` fetch, so DOM assertions need to wait for that fetch to
 * settle rather than assuming it already has — this is a short, bounded poll,
 * not a fixed sleep, so a real regression still fails instead of racing green.
 */
export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition was not met in time')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
