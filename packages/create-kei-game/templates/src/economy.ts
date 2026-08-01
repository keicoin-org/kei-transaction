/**
 * Every line of Kei in the browser, in one file, so it can be read in one sitting.
 *
 * The shape to notice: there is no call to this game's server asking what the
 * player's balance is, and there is no session. The browser holds a key, signs
 * its own blocks, and reads its own balances from the node. The server is asked
 * exactly one thing — pay me for these clicks — and it answers with a proof
 * rather than a number.
 *
 * The other thing to notice is what is missing. There is no save file. The
 * lantern is an item this wallet holds, so progress is restored by reading the
 * chain, and it is restored just as well in a different browser, or in a wallet
 * this game has never heard of.
 */

import { Kei, type PlayerToken, type WalletSummary } from 'kei-transaction'

import { perClickFor, type Catalogue, type LanternOrder, type LanternOutcome } from '../shared/game.js'

export interface EconomyState {
  address: string
  /** False when the node or the game server could not be reached. */
  online: boolean
  /** The player's Kei — real money, and what the lantern is bought with. */
  kei: number
  /** The player's __CURRENCY_NAME__. */
  coins: number
  symbol: string
  /** Clicks this browser has made and not yet been paid for. */
  unsaved: number
  saving: boolean
  perClick: number
  lanterns: number
  lanternPrice: number
  claiming: number
  /** One sentence for the player. Errors from the SDK arrive here verbatim. */
  message: string | null
}

export interface Economy {
  readonly state: EconomyState
  click(): void
  buyLantern(): Promise<void>
  on(listener: (state: EconomyState) => void): void
  close(): void
}

/** Bank after this many clicks, or this long, whichever comes first. */
const SAVE_AFTER_CLICKS = 20
const SAVE_AFTER_MS = 3_000

export async function connect(): Promise<Economy> {
  const listeners: Array<(state: EconomyState) => void> = []
  const state: EconomyState = {
    address: '',
    online: false,
    kei: 0,
    coins: 0,
    symbol: '__CURRENCY_SYMBOL__',
    unsaved: 0,
    saving: false,
    perClick: 1,
    lanterns: 0,
    lanternPrice: 0,
    claiming: 0,
    message: null,
  }

  const changed = (): void => {
    for (const listener of listeners) listener(state)
  }
  const say = (error: unknown): void => {
    // Every error this SDK raises is a sentence that states its own fix, so it
    // is shown as written rather than replaced with "something went wrong".
    state.message = error instanceof Error ? error.message : String(error)
    changed()
  }

  let catalogue: Catalogue
  let kei: Kei
  let currency: PlayerToken
  try {
    catalogue = (await (await fetch('/game/catalogue')).json()) as Catalogue

    // The wallet. Created on first visit, saved in this browser, and reused
    // forever after. No signup, no API key, no extension.
    kei = await Kei.start({
      node: `${location.origin}/rpc`,
      network: catalogue.network as 'mock' | 'testnet',
    })
    currency = await kei.token(catalogue.currency.asset)
  } catch (error) {
    // Practice mode: clicking still works and says plainly that nothing is
    // landing. A game that shows a blank screen because one fetch failed is
    // worse than one that keeps going and tells you why.
    state.message =
      error instanceof Error && !/Failed to fetch|NetworkError/.test(error.message)
        ? error.message
        : 'No game server here — clicks are not being paid. Start one with: bun run dev'
    return offline(state, listeners, changed)
  }

  state.address = kei.address
  state.online = true
  state.symbol = catalogue.currency.symbol
  state.lanternPrice = catalogue.lantern.price

  // On a mock chain a new player funds themselves, which is what a testnet
  // faucet is for. On mainnet this is the one human step there is.
  if ((await kei.balance()) === 0 && catalogue.network !== 'mainnet') {
    await kei.faucet().catch(() => undefined)
  }

  // Everything the player owns, read from the chain, pushed here on change.
  const apply = (summary: WalletSummary): void => {
    state.kei = summary.kei
    state.coins = summary.tokens.find((token) => token.asset === catalogue.currency.asset)?.amount ?? 0
    state.lanterns = summary.items.find((item) => item.asset === catalogue.lantern.asset)?.count ?? 0
    state.perClick = perClickFor(state.lanterns)
    state.claiming = summary.pending.length
    changed()
  }

  apply(await kei.wallet.summary())
  kei.wallet.on('change', apply)
  kei.on('error', say)

  // ------------------------------------------------------------------- saving

  let timer: ReturnType<typeof setTimeout> | undefined

  const save = async (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const clicks = state.unsaved
    if (clicks <= 0 || state.saving) return

    state.unsaved = 0
    state.saving = true
    changed()
    try {
      const response = await fetch('/game/earn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: kei.address, clicks }),
      })
      const body = (await response.json()) as { bundle?: Parameters<typeof kei.claims.add>[0]; error?: string }
      if (body.error || !body.bundle) throw new Error(body.error ?? 'The game server sent no proof back.')

      // From here the game is not involved. The bundle is an entitlement, and
      // the claim that collects it is written by this wallet, from this account,
      // in parallel with every other player claiming against the same root.
      await kei.claims.add(body.bundle)
      state.message = null
    } catch (error) {
      // Nothing was minted, so the clicks are still owed. Put them back.
      state.unsaved += clicks
      say(error)
    } finally {
      state.saving = false
      changed()
    }
  }

  return {
    state,

    click() {
      state.unsaved++
      if (state.unsaved >= SAVE_AFTER_CLICKS) void save()
      else timer ??= setTimeout(() => void save(), SAVE_AFTER_MS)
      changed()
    },

    async buyLantern() {
      let paid: string | undefined
      try {
        state.message = null
        if (state.lanterns > 0) throw new Error('You already have a lantern.')

        // A real payment, for a real fraction of a cent. The player signs it;
        // the game delivers in response. Two signatures, never one.
        if ((await kei.balance()) < catalogue.lantern.price && catalogue.network !== 'mainnet') {
          await kei.faucet()
        }
        const receipt = await kei.pay({ to: catalogue.issuer, amount: catalogue.lantern.price })
        paid = receipt.hash

        // The payment is on the chain and cannot say what it was for — a Kei
        // send has no memo field. Its hash names it exactly, so that is what
        // gets sent, and the game matches it against the payment it watched
        // arrive. Money first, order second: nothing here can spend a payment
        // that was never made.
        state.message = 'Paid. Telling the game what it was for…'
        changed()

        const response = await fetch('/game/lantern', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address: kei.address, hash: receipt.hash } satisfies LanternOrder),
        })
        const body = (await response.json()) as LanternOutcome | { error?: string }
        if ('error' in body && body.error) throw new Error(body.error)

        state.message =
          'outcome' in body && body.outcome === 'refunded'
            ? `${body.reason} Refunded ${body.amount} Kei.`
            : 'Paid. The lantern is on its way.'
        changed()
      } catch (error) {
        say(error)
        if (paid) {
          // The payment is final and its hash is the only thing that redeems
          // it, so it is not allowed to vanish with the failure. The crystal
          // has room for two lines; the console has room for the hash. It is
          // also in this wallet's own account history, and posting it again is
          // safe — the game delivers once per payment, however often it is
          // asked.
          console.warn(`Paid, not yet delivered. Payment hash: ${paid}`)
          state.message = `${state.message ?? ''} Payment ${paid.slice(0, 8)}… — try again.`
          changed()
        }
      }
    },

    on(listener) {
      listeners.push(listener)
    },

    close() {
      if (timer) clearTimeout(timer)
      kei.close()
    },
  }
}

/** No server, no chain: the game still runs and says why nothing is landing. */
function offline(
  state: EconomyState,
  listeners: Array<(state: EconomyState) => void>,
  changed: () => void,
): Economy {
  return {
    state,
    click() {
      state.unsaved++
      changed()
    },
    async buyLantern() {
      /* nothing to buy without a chain */
    },
    on(listener) {
      listeners.push(listener)
    },
    close() {
      /* nothing running */
    },
  }
}
