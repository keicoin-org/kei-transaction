/**
 * The whole backend.
 *
 * There is no database here. No `players` table, no `balances` table, no
 * `inventory` table, and no save file — those are questions the chain answers,
 * and asking it is `balanceOf`. What is left is what a game server is actually
 * for: deciding what a click is worth and what things cost.
 *
 * It holds the game's seed, which is why it cannot run in a browser. An issuer
 * seed in the client is a total compromise of your economy: anyone could mint
 * your currency without limit. `Kei.server()` refuses to start in a browser for
 * that reason, and there is no way to talk it round.
 */

import { Kei, type ClaimBundle, type KeiNode } from 'kei-transaction'

import { CURRENCY, LANTERN, perClickFor, type Catalogue, type LanternOutcome } from '../shared/game.js'

export interface GameOptions {
  seed: string
  node: KeiNode | string
  network?: 'mock' | 'testnet' | 'mainnet'
}

export interface Game {
  address: string
  catalogue(): Catalogue
  /** Pay for clicks. Returns the proof the player claims with. */
  earn(address: string, clicks: number): Promise<ClaimBundle>
  /**
   * Deliver the lantern for one payment, named by the hash `kei.pay()` gave the
   * player. Calling it twice with the same hash returns the first answer rather
   * than delivering twice.
   */
  buyLantern(address: string, hash: string): Promise<LanternOutcome>
  close(): void
}

export class GameError extends Error {}

/** Fast for a finger, slow for a script. */
const CLICK_RATE_CAP = 25

/**
 * How long to wait for a payment the player says they made. They are quicker
 * than the chain: `kei.pay()` returns as soon as the block is theirs, and this
 * side only knows about it once the node has told it and it has collected.
 */
const PAYMENT_WAIT_MS = 10_000

export async function startGame(options: GameOptions): Promise<Game> {
  const kei = await Kei.server({
    seed: options.seed,
    node: options.node,
    ...(options.network === undefined ? {} : { network: options.network }),
  })

  // Issuing an asset burns Kei — the one place in Kei where something is not
  // free, and what stops an infinite supply of worthless tokens. This game
  // issues two: the currency and the lantern. On a real network somebody funds
  // this address once; on a mock the faucet does it.
  const needed = 2 * 1_000 + 100
  if ((await kei.balance()) < needed) await kei.faucet(needed)

  // Idempotent: restarting this server returns the same currency rather than a
  // second one, because an asset's id is derived from the issuer and the ticker.
  const currency = await kei.token.issue({
    name: CURRENCY.name,
    symbol: CURRENCY.symbol,
    decimals: CURRENCY.decimals,
    maxSupply: CURRENCY.maxSupply,
    // Open, so players can trade with each other. 'issuer-only' or 'none' are
    // the other choices, and the chain enforces whichever you pick, forever.
    transfer: 'open',
    swap: 'off',
  })

  const lantern = await kei.items.create({
    name: LANTERN.name,
    description: LANTERN.description,
    supply: LANTERN.supply,
    transfer: 'open',
  })
  const lanterns = await kei.items.token(lantern.id)

  const payments = watchPayments(kei)
  const lastEarn = new Map<string, number>()

  // One delivery at a time, so two payments arriving together cannot both read
  // "this player has no lantern" and both mint one.
  let queue: Promise<unknown> = Promise.resolve()
  const serially = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run)
    queue = next.catch(() => undefined)
    return next
  }

  /**
   * Selling the lantern: the player signs the payment, the issuer signs the
   * delivery, and neither can sign for the other. There is no `charge(player, …)`
   * in this SDK and there never will be — a game cannot sign for a wallet it
   * does not hold the key to.
   *
   * The payment says who and how much. The hash says which, and the player is
   * the only one who has it when they make it, so quoting it is a claim only
   * they could make. Everything else here is checking that claim against what
   * this game watched arrive.
   */
  const deliver = async (address: string, hash: string): Promise<LanternOutcome> => {
    const payment = await payments.find(hash, PAYMENT_WAIT_MS)
    if (!payment) {
      throw new GameError(
        `No payment ${hash.slice(0, 12)}… has reached this game. If you have only just paid, try again in a moment — nothing was delivered and nothing was kept.`,
      )
    }
    if (payment.from !== address) {
      throw new GameError('That payment was signed by a different wallet, and a payment buys for the wallet that made it.')
    }
    if (payment.amount < LANTERN.price) {
      throw new GameError(`That payment was ${payment.amount} Kei and the lantern costs ${LANTERN.price}.`)
    }

    // Waiting happens above, outside the queue, so one player's unarrived
    // payment cannot hold up everybody else's delivery.
    return serially<LanternOutcome>(async () => {
      // Already has one. The payment still arrived, so refund it rather than
      // keeping money for a thing that was not delivered.
      if ((await lanterns.balanceOf(address)) > 0) {
        await kei.send(address, payment.amount)
        return { outcome: 'refunded', amount: payment.amount, reason: 'You already have a lantern.' }
      }

      await kei.items.mint(lantern.id, address)
      return { outcome: 'delivered', item: lantern.id }
    })
  }

  /** Deliveries already made or in flight, so a hash buys exactly one lantern. */
  const orders = new Map<string, Promise<LanternOutcome>>()

  return {
    address: kei.address,

    catalogue() {
      return {
        issuer: kei.address,
        network: kei.network,
        currency: { asset: currency.id, symbol: currency.symbol, decimals: currency.decimals },
        lantern: {
          asset: lantern.id,
          name: LANTERN.name,
          description: LANTERN.description,
          price: LANTERN.price,
        },
      }
    },

    async earn(address, clicks) {
      const now = Date.now()
      const since = now - (lastEarn.get(address) ?? now - 1_000)
      lastEarn.set(address, now)

      // The browser counts the clicks, because in single-player nothing else
      // sees them. That is a real trust hole, and this is a ceiling rather than
      // a fix: it makes the hole worth a few coins instead of the whole supply.
      // Put a Colyseus room in the middle and the clicks become observed.
      const allowed = Math.max(1, Math.ceil((since / 1_000) * CLICK_RATE_CAP) + CLICK_RATE_CAP)
      const counted = Math.min(Math.floor(clicks), allowed)
      if (!(counted > 0)) throw new GameError('That was zero clicks.')

      const owned = await lanterns.balanceOf(address)

      // One issuer block, and the player writes their own claim against it from
      // their own account. With one player this is a batch of one and the code
      // is identical — which is the useful part, because nothing has to be
      // rewritten when there are a thousand of them claiming at once. Minting
      // to each player in turn would instead make this account's chain a global
      // write lock, and the queue behind it would become the game.
      const drop = await currency.commit([{ to: address, amount: counted * perClickFor(owned) }])
      return drop.proofFor(address)
    },

    async buyLantern(address, hash) {
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) {
        throw new GameError('That is not a payment hash. Send the hash kei.pay() gave you.')
      }
      const paid = hash.toUpperCase()

      // Exactly once, and safe to retry: the first call for a hash owns the
      // delivery and every later one is handed its answer. A browser that loses
      // the response and posts again must not get a second lantern, and neither
      // must two tabs posting at the same moment.
      const started = orders.get(paid)
      if (started) return started

      // A failure is not an answer — most often it means the payment has not
      // landed here yet — so it is not remembered and the player can try again.
      const order = deliver(address, paid).catch((error: unknown) => {
        orders.delete(paid)
        throw error
      })
      orders.set(paid, order)
      return order
    },

    close() {
      payments.close()
      kei.close()
    },
  }
}

interface SeenPayment {
  from: string
  amount: number
}

interface PaymentLog {
  /** Wait for one named payment to arrive here, or give up. */
  find(hash: string, timeoutMs: number): Promise<SeenPayment | undefined>
  close(): void
}

/**
 * Every Kei payment this game has actually watched arrive, filed under the name
 * the payer knows it by.
 *
 * `onPayment` reports the *receive* block this account wrote, which is not the
 * hash `kei.pay()` handed the player — they hold the send. A receive names the
 * send it collects in its `link`, and reading that back is what lets the two
 * sides talk about one payment by one name.
 */
function watchPayments(kei: Kei): PaymentLog {
  const seen = new Map<string, SeenPayment>()
  const waiting = new Map<string, Array<(payment: SeenPayment) => void>>()

  const stop = kei.onPayment(async ({ from, amount, hash }) => {
    const receive = await kei.client.node.blockInfo(hash)
    if (receive?.type !== 'state') return

    const payment = { from, amount }
    seen.set(receive.link, payment)
    for (const arrived of waiting.get(receive.link) ?? []) arrived(payment)
    waiting.delete(receive.link)
  })

  return {
    async find(hash, timeoutMs) {
      const already = seen.get(hash)
      if (already) return already

      return new Promise<SeenPayment | undefined>((resolve) => {
        let timer: ReturnType<typeof setTimeout>
        const arrived = (payment: SeenPayment): void => {
          clearTimeout(timer)
          resolve(payment)
        }
        timer = setTimeout(() => {
          const listeners = (waiting.get(hash) ?? []).filter((listener) => listener !== arrived)
          if (listeners.length === 0) waiting.delete(hash)
          else waiting.set(hash, listeners)
          resolve(undefined)
        }, timeoutMs)

        waiting.set(hash, [...(waiting.get(hash) ?? []), arrived])
      })
    },

    close: stop,
  }
}
