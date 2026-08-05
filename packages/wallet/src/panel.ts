/**
 * `WalletPanel` — the mountable half of the in-game wallet (SPEC §6.5, M6).
 *
 * `createWallet` (index.ts) is the headless half most of this file is built on:
 * one summary call and a change event. This is the drop-in UI over it, because
 * most players never open the standalone wallet (`kei-wallet`) — this panel is
 * what they actually touch.
 *
 * Seed reveal follows SPEC §6.6 to the letter:
 *   - `never`   — no reveal path exists. Nothing is ever rendered that could
 *                 show it.
 *   - `always`  — shown without friction, but only while streamer mode is off.
 *                 Documented as development/testing only; never ship it.
 *   - `on-request` (default) — hidden behind two deliberate gestures: a click
 *                 that surfaces a plain-language risk warning, then a
 *                 press-and-hold that is the only moment the seed text exists
 *                 in the DOM at all. Releasing — by any means, including
 *                 losing the pointer off the button — clears it immediately.
 *
 * Streamer mode is one global switch (`WalletPanel.setStreamerMode`), because
 * the failure it defends against — a seed visible on a stream — does not care
 * which panel is on screen. Turning it on force-clears and re-hides every
 * mounted panel synchronously, and turning it off never auto-reveals anything;
 * `on-request` panels re-arm from the closed state, `always` panels resume
 * showing the seed plainly.
 */

import type { RevealPolicy } from '@keicoin/core'
import { fail, scrub } from '@keicoin/core'
import type { LockedHolding, WalletApi, WalletSummary } from './index.js'

/** `'inventory'` is the SPEC §6.5 example's spelling; it is an alias for `'items'`. */
export type WalletPanelSection = 'balance' | 'tokens' | 'items' | 'inventory' | 'claims'

type Section = 'balance' | 'tokens' | 'items' | 'claims'

const ALL_SECTIONS: readonly WalletPanelSection[] = ['balance', 'tokens', 'items', 'claims']

/** CSS custom properties, e.g. `{ '--kei-wallet-accent': '#7c3aed' }`. The `--` prefix is optional. */
export type WalletPanelThemeVars = Record<string, string>

/** A named preset (applied as a `kei-wallet-panel--{theme}` class) or raw CSS variables. */
export type WalletPanelTheme = string | WalletPanelThemeVars

/**
 * The durability half of `kei.custody` (SPEC §6.4). Declared structurally
 * rather than imported, because `@keicoin/wallet` depends on `@keicoin/core`
 * and not on the umbrella package that owns `SeedCustody` — a real
 * `Kei.start()` result satisfies it exactly.
 */
export interface WalletPanelCustody {
  readonly durability: 'persistent' | 'session' | 'supplied'
}

/**
 * What `WalletPanel.mount` needs from a `Kei` instance. This matches the
 * public shape of the real `Kei` class exactly (`address`, `seed`, `client`,
 * `wallet`, `custody`), so a real `Kei.start()` result satisfies it with no
 * adapter.
 */
export interface WalletPanelKei {
  readonly address: string
  /** Subject to the reveal policy — only read while a reveal is actually in progress. */
  readonly seed: string
  readonly client: { readonly reveal: RevealPolicy }
  readonly wallet: WalletApi
  /**
   * Optional only so an object assembled by hand still mounts; `Kei.start()`
   * always supplies it, and without it the panel has no way to know whether a
   * reload keeps this wallet and so says nothing.
   */
  readonly custody?: WalletPanelCustody
}

export interface WalletPanelOptions {
  kei: WalletPanelKei
  /** Which sections to render. Defaults to all four. */
  show?: readonly WalletPanelSection[]
  theme?: WalletPanelTheme
}

export interface WalletPanelHandle {
  readonly element: HTMLElement
  /** Removes the panel's DOM, unsubscribes every listener, and clears any revealed seed. Safe to call more than once. */
  unmount(): void
}

interface StreamerAware {
  applyStreamerMode(): void
}

// A single, module-global switch (SPEC §6.6): the failure it defends against —
// a seed visible on a stream — is global, so the switch is too.
let streamerModeOn = false
const streamerAwarePanels = new Set<StreamerAware>()

export const WalletPanel = {
  mount(target: string | Element, options: WalletPanelOptions): WalletPanelHandle {
    return mountPanel(target, options)
  },

  /** Immediately clears and re-hides seed material on every mounted panel. */
  setStreamerMode(enabled: boolean): void {
    streamerModeOn = Boolean(enabled)
    for (const panel of streamerAwarePanels) panel.applyStreamerMode()
  },

  get streamerMode(): boolean {
    return streamerModeOn
  },
}

// ---------------------------------------------------------------- mounting

function mountPanel(target: string | Element, options: WalletPanelOptions): WalletPanelHandle {
  if (!options || typeof options !== 'object' || !options.kei) {
    fail(
      'wallet-panel-no-kei',
      'WalletPanel.mount(target, { kei }) needs the kei instance whose wallet this panel should show.',
    )
  }
  const { kei } = options
  const root = resolveTarget(target)
  const doc = root.ownerDocument
  if (!doc) {
    fail('wallet-panel-no-document', 'WalletPanel.mount() needs an element that belongs to a document.')
  }

  const sections = normalizeSections(options.show)

  const panelEl = doc.createElement('div')
  panelEl.className = 'kei-wallet-panel'
  applyTheme(panelEl, options.theme)
  root.appendChild(panelEl)

  // First, above every number, and with no way to dismiss it: a wallet a reload
  // loses has to say so before it is used (SPEC §6.4).
  const durabilityNotice = buildDurabilityNotice(doc, panelEl, kei)

  const summaryEls: Partial<Record<Section, HTMLElement>> = {}
  for (const name of ['balance', 'tokens', 'items', 'claims'] as const) {
    if (sections.has(name)) summaryEls[name] = buildSection(doc, panelEl, name)
  }

  // The backup path lives inside the warning when there is one, so the sentence
  // that names the risk and the control that answers it are one thing.
  const seed = buildSeedSection(doc, durabilityNotice ?? panelEl, kei)
  streamerAwarePanels.add(seed)
  seed.applyStreamerMode()

  let closed = false
  /** Set once the wallet's own change stream has painted something here. */
  let delivered = false
  const renderSummary = (summary: WalletSummary): void => {
    if (closed) return
    if (summaryEls.balance) renderBalance(doc, summaryEls.balance, summary)
    if (summaryEls.tokens) renderTokens(doc, summaryEls.tokens, summary)
    if (summaryEls.items) renderItems(doc, summaryEls.items, summary)
    if (summaryEls.claims) renderClaims(doc, summaryEls.claims, summary)
  }

  const unsubscribe = kei.wallet.on('change', (summary) => {
    delivered = true
    renderSummary(summary)
  })
  void kei.wallet
    .summary()
    .then((summary) => {
      // `kei.wallet` delivers its own change events in order, but this first
      // fetch is outside that queue: it starts at mount, so anything the wallet
      // has already delivered was read from the chain later than this was. A
      // slow first response must not paint an older wallet over a newer one.
      if (!delivered) renderSummary(summary)
    })
    .catch((error: unknown) => {
      // Same reasoning, and the same way round: a first fetch that failed says
      // nothing about a panel the change stream has already filled in, and an
      // unmounted panel is nobody's to write to.
      if (!delivered && !closed) renderError(doc, panelEl, error)
    })

  return {
    element: panelEl,
    unmount(): void {
      if (closed) return
      closed = true
      unsubscribe()
      streamerAwarePanels.delete(seed)
      seed.dispose()
      panelEl.remove()
    },
  }
}

function resolveTarget(target: string | Element): Element {
  if (typeof target === 'string') {
    if (typeof document === 'undefined') {
      fail(
        'wallet-panel-no-dom',
        'WalletPanel.mount(selector, ...) needs a browser DOM to resolve a CSS selector. Pass the Element itself if you already have one.',
      )
    }
    const found = document.querySelector(target)
    if (!found) {
      fail(
        'wallet-panel-no-target',
        `WalletPanel.mount("${target}", ...) found nothing matching "${target}". Add the element to the page before mounting, e.g. <div id="wallet"></div>.`,
      )
    }
    return found
  }
  if (!target || typeof target.appendChild !== 'function') {
    fail('wallet-panel-bad-target', 'WalletPanel.mount(target, ...) needs a CSS selector string or a DOM Element.')
  }
  return target
}

function normalizeSections(show: readonly WalletPanelSection[] | undefined): Set<Section> {
  const list = show && show.length > 0 ? show : ALL_SECTIONS
  const out = new Set<Section>()
  for (const entry of list) out.add(entry === 'inventory' ? 'items' : entry)
  return out
}

function applyTheme(panelEl: HTMLElement, theme: WalletPanelTheme | undefined): void {
  if (!theme) return
  if (typeof theme === 'string') {
    panelEl.classList.add(`kei-wallet-panel--${theme}`)
    return
  }
  for (const [name, value] of Object.entries(theme)) {
    panelEl.style.setProperty(name.startsWith('--') ? name : `--${name}`, value)
  }
}

/**
 * The session-only warning (SPEC §6.4), or nothing when the wallet is kept.
 *
 * Rendered first, marked as an alert, and with no dismiss control — a player
 * whose wallet disappears on reload has to have been told before they were
 * shown a balance, not after they funded it. `data-durability` on the panel is
 * the same fact for a game styling around it, or gating its own "buy" button.
 */
function buildDurabilityNotice(doc: Document, panelEl: HTMLElement, kei: WalletPanelKei): HTMLElement | null {
  const durability = kei.custody?.durability
  if (durability) panelEl.dataset.durability = durability
  if (durability !== 'session') return null

  const notice = doc.createElement('div')
  notice.className = 'kei-wallet-panel__section kei-wallet-panel__durability'
  notice.setAttribute('role', 'alert')

  const title = doc.createElement('strong')
  title.className = 'kei-wallet-panel__durability-title'
  title.textContent = 'This wallet is not saved.'

  const body = doc.createElement('p')
  body.className = 'kei-wallet-panel__durability-body'
  // Precise about the loss and about the way out of it: the seed is the only
  // copy of this wallet, and a player who writes it down keeps everything. No
  // sentence here claims a loss is beyond recovery, because a backed-up seed
  // restores the wallet in any Kei wallet.
  body.textContent =
    'It lasts until this page reloads. A reload starts a different wallet, so anything sent to this address is lost with the old one unless you have saved its hex seed. Back the seed up now if you are going to put anything here you would miss.'

  notice.append(title, body)

  if (kei.client.reveal === 'never') {
    const blocked = doc.createElement('p')
    blocked.className = 'kei-wallet-panel__durability-blocked'
    blocked.textContent =
      'This game switched seed backup off, so this panel cannot show you the hex seed to save. Keep this wallet empty until the game turns backup on.'
    notice.appendChild(blocked)
  }

  panelEl.appendChild(notice)
  return notice
}

function buildSection(doc: Document, parent: HTMLElement, name: Section): HTMLElement {
  const section = doc.createElement('div')
  section.className = `kei-wallet-panel__section kei-wallet-panel__${name}`
  parent.appendChild(section)
  return section
}

// ---------------------------------------------------------------- rendering

function renderBalance(doc: Document, el: HTMLElement, summary: WalletSummary): void {
  el.textContent = ''
  const label = doc.createElement('span')
  label.className = 'kei-wallet-panel__label'
  label.textContent = 'Kei'
  const value = doc.createElement('span')
  value.className = 'kei-wallet-panel__value'
  value.textContent = String(summary.kei)
  el.append(label, value)
  // A bid takes the Kei out of the balance the moment it is written (SPEC §9.2)
  // and nothing else on the panel accounts for the difference, so the number
  // above is only honest next to this one.
  if (summary.keiLocked <= 0) return
  const locked = doc.createElement('span')
  locked.className = 'kei-wallet-panel__locked'
  locked.textContent = `${summary.keiLocked} locked in your offers`
  el.appendChild(locked)
}

function renderTokens(doc: Document, el: HTMLElement, summary: WalletSummary): void {
  el.textContent = ''
  const locked = summary.locked.filter((holding) => !holding.item)
  if (summary.tokens.length === 0 && locked.length === 0) {
    el.appendChild(emptyNote(doc, 'No tokens yet.'))
    return
  }
  for (const token of summary.tokens) {
    const row = doc.createElement('div')
    row.className = 'kei-wallet-panel__row'
    row.dataset.symbol = token.symbol
    const name = doc.createElement('span')
    name.className = 'kei-wallet-panel__row-name'
    name.textContent = token.name
    const amount = doc.createElement('span')
    amount.className = 'kei-wallet-panel__row-amount'
    amount.textContent = `${token.amount} ${token.symbol}`
    row.append(name, amount)
    el.appendChild(row)
  }
  for (const holding of locked) {
    el.appendChild(lockedRow(doc, holding, holding.name, `${holding.amount} ${holding.symbol}`))
  }
}

function renderItems(doc: Document, el: HTMLElement, summary: WalletSummary): void {
  el.textContent = ''
  const locked = summary.locked.filter((holding) => holding.item)
  // "No items yet." is true only of an account that holds none and has none
  // locked either. An item in this player's own offer is still this player's
  // and comes back on a cancel (SPEC §9.2), so it is named below instead of
  // being counted as nothing.
  if (summary.items.length === 0 && locked.length === 0) {
    el.appendChild(emptyNote(doc, 'No items yet.'))
    return
  }
  for (const item of summary.items) {
    const row = doc.createElement('div')
    row.className = 'kei-wallet-panel__row'
    row.dataset.symbol = item.symbol
    const name = doc.createElement('span')
    name.className = 'kei-wallet-panel__row-name'
    name.textContent = item.count > 1 ? `${item.name} ×${item.count}` : item.name
    row.appendChild(name)
    el.appendChild(row)
  }
  for (const holding of locked) {
    const name = holding.amount > 1 ? `${holding.name} ×${holding.amount}` : holding.name
    el.appendChild(lockedRow(doc, holding, name, null))
  }
}

/**
 * A row for something the player owns and cannot spend, marked as such in the
 * DOM as well as in the sentence: a game styling around this needs to be able
 * to tell the two apart without reading the text.
 */
function lockedRow(doc: Document, holding: LockedHolding, name: string, amount: string | null): HTMLElement {
  const row = doc.createElement('div')
  row.className = 'kei-wallet-panel__row kei-wallet-panel__row--locked'
  row.dataset.symbol = holding.symbol
  row.dataset.locked = holding.reason
  row.dataset.offer = holding.offer
  const nameEl = doc.createElement('span')
  nameEl.className = 'kei-wallet-panel__row-name'
  nameEl.textContent = name
  row.appendChild(nameEl)
  if (amount !== null) {
    const amountEl = doc.createElement('span')
    amountEl.className = 'kei-wallet-panel__row-amount'
    amountEl.textContent = amount
    row.appendChild(amountEl)
  }
  const note = doc.createElement('span')
  note.className = 'kei-wallet-panel__row-locked'
  // Both halves matter: where it went, and that it is coming back if nobody
  // takes it. "Listed" is the player's word for the state; the offer hash is on
  // the row for the game that wants to offer a cancel button.
  note.textContent = `Listed for ${holding.want.amount} ${holding.want.symbol}. Still yours until it sells.`
  row.appendChild(note)
  return row
}

function renderClaims(doc: Document, el: HTMLElement, summary: WalletSummary): void {
  el.textContent = ''
  if (summary.pending.length === 0) {
    el.appendChild(emptyNote(doc, 'Nothing pending.'))
    return
  }
  for (const claim of summary.pending) {
    const row = doc.createElement('div')
    row.className = 'kei-wallet-panel__row'
    row.dataset.symbol = claim.symbol
    row.dataset.root = claim.root
    const label = doc.createElement('span')
    label.className = 'kei-wallet-panel__row-name'
    label.textContent = `${claim.amount} ${claim.symbol} (unclaimed)`
    row.appendChild(label)
    el.appendChild(row)
  }
}

function emptyNote(doc: Document, text: string): HTMLElement {
  const note = doc.createElement('span')
  note.className = 'kei-wallet-panel__empty'
  note.textContent = text
  return note
}

function renderError(doc: Document, panelEl: HTMLElement, error: unknown): void {
  const note = doc.createElement('div')
  note.className = 'kei-wallet-panel__error'
  // `KeiError` messages are already scrubbed at construction time
  // (@keicoin/core errors.ts). `scrub` here is the backstop for anything else
  // `kei.wallet.summary()` might reject with — no error this panel shows is
  // ever exempt from the "no seed in any error" rule (SPEC §6.6).
  const message = error instanceof Error ? error.message : 'Could not load the wallet summary.'
  note.textContent = scrub(message)
  panelEl.appendChild(note)
}

// --------------------------------------------------------------- seed reveal

interface SeedSection extends StreamerAware {
  dispose(): void
}

function buildSeedSection(doc: Document, panelEl: HTMLElement, kei: WalletPanelKei): SeedSection {
  const section = doc.createElement('div')
  section.className = 'kei-wallet-panel__section kei-wallet-panel__seed'
  panelEl.appendChild(section)

  const reveal = kei.client.reveal
  if (reveal === 'never') {
    const note = doc.createElement('span')
    note.className = 'kei-wallet-panel__seed-note'
    note.textContent = 'Seed backup is disabled for this wallet.'
    section.appendChild(note)
    // No control of any kind exists here — there is no reveal path to suppress.
    return { applyStreamerMode(): void {}, dispose(): void {} }
  }

  return reveal === 'always' ? buildAlwaysSeed(doc, section, kei) : buildOnRequestSeed(doc, section, kei)
}

function buildAlwaysSeed(doc: Document, section: HTMLElement, kei: WalletPanelKei): SeedSection {
  const hint = doc.createElement('span')
  hint.className = 'kei-wallet-panel__seed-hint'

  const valueEl = doc.createElement('span')
  valueEl.className = 'kei-wallet-panel__seed-value'

  const render = (): void => {
    if (streamerModeOn) {
      valueEl.textContent = ''
      valueEl.classList.remove('kei-wallet-panel__seed-value--visible')
      hint.textContent = 'Seed hidden — streamer mode is on.'
      return
    }
    hint.textContent = "reveal: 'always' — development only. Never ship this."
    valueEl.textContent = kei.seed
    valueEl.classList.add('kei-wallet-panel__seed-value--visible')
  }

  section.append(hint, valueEl)
  render()

  return {
    applyStreamerMode: render,
    dispose(): void {
      valueEl.textContent = ''
    },
  }
}

const SEED_MASK = '••••••••••••••••'

function buildOnRequestSeed(doc: Document, section: HTMLElement, kei: WalletPanelKei): SeedSection {
  type Stage = 'closed' | 'open'
  let stage: Stage = 'closed'
  let holding = false
  let releaseListenersAttached = false

  const revealButton = doc.createElement('button')
  revealButton.type = 'button'
  revealButton.className = 'kei-wallet-panel__seed-reveal'
  // A Kei seed is 64 hexadecimal characters, not a word list. Calling it a
  // phrase sends a player looking for twelve words that do not exist.
  revealButton.textContent = 'Back up hex seed'

  const warning = doc.createElement('p')
  warning.className = 'kei-wallet-panel__seed-warning'
  warning.textContent =
    'This is the 64-character hex seed for this wallet. Anyone who sees it can take everything in it. Make sure nobody is watching or recording your screen.'

  const holdButton = doc.createElement('button')
  holdButton.type = 'button'
  holdButton.className = 'kei-wallet-panel__seed-hold'
  holdButton.textContent = 'Press and hold to reveal'

  const cancelButton = doc.createElement('button')
  cancelButton.type = 'button'
  cancelButton.className = 'kei-wallet-panel__seed-cancel'
  cancelButton.textContent = 'Cancel'

  const valueEl = doc.createElement('span')
  valueEl.className = 'kei-wallet-panel__seed-value kei-wallet-panel__seed-value--blurred'
  valueEl.textContent = SEED_MASK

  const disabledNote = doc.createElement('span')
  disabledNote.className = 'kei-wallet-panel__seed-note'
  disabledNote.textContent = 'Seed reveal is disabled while streamer mode is on.'

  const onDocumentRelease = (): void => release()
  const onVisibilityChange = (): void => {
    if (doc.hidden) release()
  }

  const attachReleaseListeners = (): void => {
    if (releaseListenersAttached) return
    releaseListenersAttached = true
    doc.addEventListener('mouseup', onDocumentRelease)
    doc.addEventListener('touchend', onDocumentRelease)
    doc.addEventListener('touchcancel', onDocumentRelease)
    doc.addEventListener('visibilitychange', onVisibilityChange)
  }

  const detachReleaseListeners = (): void => {
    if (!releaseListenersAttached) return
    releaseListenersAttached = false
    doc.removeEventListener('mouseup', onDocumentRelease)
    doc.removeEventListener('touchend', onDocumentRelease)
    doc.removeEventListener('touchcancel', onDocumentRelease)
    doc.removeEventListener('visibilitychange', onVisibilityChange)
  }

  // The only place this ever runs: the moment a hold begins, and never before.
  function reveal(): void {
    if (streamerModeOn || stage !== 'open' || holding) return
    holding = true
    valueEl.textContent = kei.seed
    valueEl.classList.remove('kei-wallet-panel__seed-value--blurred')
    valueEl.classList.add('kei-wallet-panel__seed-value--visible')
    attachReleaseListeners()
  }

  function release(): void {
    if (!holding) {
      detachReleaseListeners()
      return
    }
    holding = false
    valueEl.textContent = SEED_MASK
    valueEl.classList.remove('kei-wallet-panel__seed-value--visible')
    valueEl.classList.add('kei-wallet-panel__seed-value--blurred')
    detachReleaseListeners()
  }

  holdButton.addEventListener('mousedown', reveal)
  holdButton.addEventListener('touchstart', reveal)
  holdButton.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key
    if (key === 'Enter' || key === ' ') reveal()
  })
  holdButton.addEventListener('mouseup', release)
  holdButton.addEventListener('mouseleave', release)
  holdButton.addEventListener('touchend', release)
  holdButton.addEventListener('touchcancel', release)
  holdButton.addEventListener('keyup', release)
  holdButton.addEventListener('blur', release)

  revealButton.addEventListener('click', () => {
    if (streamerModeOn) return
    stage = 'open'
    renderStage()
  })
  cancelButton.addEventListener('click', () => {
    release()
    stage = 'closed'
    renderStage()
  })

  function renderStage(): void {
    section.textContent = ''
    if (streamerModeOn) {
      section.appendChild(disabledNote)
      return
    }
    if (stage === 'closed') {
      section.appendChild(revealButton)
      return
    }
    const controls = doc.createElement('div')
    controls.className = 'kei-wallet-panel__seed-controls'
    controls.append(holdButton, cancelButton)
    section.append(warning, controls, valueEl)
  }

  return {
    applyStreamerMode(): void {
      if (streamerModeOn) {
        // Force back to the closed state: turning streamer mode off must
        // require re-confirmation, never auto-resume a reveal.
        release()
        stage = 'closed'
      }
      renderStage()
    },
    dispose(): void {
      release()
    },
  }
}
