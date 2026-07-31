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

import { Kei, type ClaimBundle, type IssuerToken, type Item, type KeiNode } from 'kei-transaction'

import { CURRENCY, LANTERN, LANTERN_MEMO, perClickFor, type Catalogue } from '../shared/game.js'

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
  close(): void
}

export class GameError extends Error {}

/** Fast for a finger, slow for a script. */
const CLICK_RATE_CAP = 25

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

  const stopSelling = sell(kei, lantern, lanterns)
  const lastEarn = new Map<string, number>()

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

    close() {
      stopSelling()
      kei.close()
    },
  }
}

/**
 * Selling the lantern: the player signs the payment, the issuer signs the
 * delivery, and neither can sign for the other. There is no `charge(player, …)`
 * in this SDK and there never will be — a game cannot sign for a wallet it does
 * not hold the key to.
 *
 * The payment carries a memo, which is how an arriving payment is matched to
 * what it was for.
 */
function sell(kei: Kei, lantern: Item, lanterns: IssuerToken): () => void {
  return kei.onPayment(async ({ from, amount, memo }) => {
    if (memo !== LANTERN_MEMO) return
    if (amount < LANTERN.price) return

    // Already has one. The payment still arrived, so refund it rather than
    // keeping money for a thing that was not delivered.
    if ((await lanterns.balanceOf(from)) > 0) {
      await kei.send(from, amount)
      return
    }

    await kei.items.mint(lantern.id, from)
  })
}
