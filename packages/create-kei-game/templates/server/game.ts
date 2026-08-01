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
import { openOrders } from './orders.js'

export interface GameOptions {
  seed: string
  node: KeiNode | string
  network?: 'mock' | 'testnet' | 'mainnet'
  /**
   * Where purchases are written down, before and after they are answered. See
   * `server/orders.ts`: it is the only thing this server keeps, and the only
   * thing that can say which payment got which answer. Losing it does not cost
   * money — nothing can be answered twice — but the wallets it held records for
   * can no longer buy, so back it up the way you would back up a database.
   */
  orders?: string
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

/** Which payment got which answer, so a restart is not amnesia. Kept out of git by `.gitignore`. */
const ORDERS_PATH = '.kei/orders.ndjson'

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

  // Watches for payments, writes down what each one was answered with before it
  // is answered, and reads the issuer's own chain back so that neither survives
  // only in this process. It also serialises deliveries: two payments arriving
  // together cannot both read "this player has no lantern" and both mint one.
  const orders = await openOrders({
    kei,
    item: lantern.id,
    path: options.orders ?? ORDERS_PATH,
  })

  const lastEarn = new Map<string, number>()

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
    const payment = await orders.payment(hash, PAYMENT_WAIT_MS)
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
    // payment cannot hold up everybody else's delivery. Everything below runs
    // one payment at a time, with the intent to answer this hash on the disk
    // before the block that answers it is written.
    const settled = await orders.settle(payment, async () => {
      // Already has one. The payment still arrived, so refund it rather than
      // keeping money for a thing that was not delivered.
      if ((await lanterns.balanceOf(address)) > 0) {
        return {
          kind: 'refund',
          outcome: { outcome: 'refunded', amount: payment.amount, reason: 'You already have a lantern.' },
          perform: async () => void (await kei.send(address, payment.amount)),
        }
      }
      return {
        kind: 'deliver',
        outcome: { outcome: 'delivered', item: lantern.id },
        perform: async () => void (await kei.items.mint(lantern.id, address)),
      }
    })

    // Answered, and this game cannot say with what: the entry naming this hash
    // is gone and the chain shows an answer it can no longer attribute. The one
    // thing that must not happen now is a guess. Delivering again would mint a
    // second lantern; refunding would hand back the price of one the player is
    // still holding.
    if (settled.status === 'unattributable') {
      throw new GameError(
        'This payment has already been answered — you were sent the lantern, or your Kei was refunded — and this game no longer has the record of which. Both are in your own account history. Nothing was taken, and nothing more will be.',
      )
    }

    // A lantern or a refund was sent to the chain and the chain has not said
    // whether it took it. The one thing that must not happen is a second try at
    // answering, because the first may still land — so nothing is answered until
    // it is known which. Nothing has been lost either: the payment stands and
    // this hash still redeems it.
    if (settled.status === 'indeterminate') {
      throw new GameError(
        'Your payment is still being settled: the game sent an answer and the network has not confirmed what happened to it. Nothing was taken and nothing was lost — try again in a moment, and you will get whichever answer the chain actually has.',
      )
    }
    return settled.outcome
  }

  /** Posts being served right now, so two tabs at once are one delivery. */
  const inFlight = new Map<string, Promise<LanternOutcome>>()

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
      // must two tabs posting at the same moment. What survives a restart is in
      // `server/orders.ts`; this map only covers posts overlapping in time.
      const started = inFlight.get(paid)
      if (started) return started

      // A failure is not an answer — most often it means the payment has not
      // landed here yet — so it is not remembered and the player can try again.
      const order = deliver(address, paid).finally(() => {
        inFlight.delete(paid)
      })
      inFlight.set(paid, order)
      return order
    },

    close() {
      orders.close()
      kei.close()
    },
  }
}
