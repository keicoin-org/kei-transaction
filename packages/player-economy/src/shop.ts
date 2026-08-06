/**
 * A player's shop.
 *
 * `@keicoin/economy` is the issuer's half of an economy: recipes the game
 * declares, stocked from the game's own account, dry-run before anything signs.
 * This is the other half, and it belongs to the player. Nobody stocks it, nobody
 * approves it, and the world it is embedded in cannot move anything in it —
 * every block below is signed by one key, and that key is in the player's
 * browser (SPEC §6.3, §6.4).
 *
 * What that costs, stated once so it is not rediscovered: **there is no shop
 * anywhere.** A stall is a set of `swap_offer` blocks on one player's own chain,
 * a sale is one `swap_accept` that moves both legs or neither (SPEC §9.2), and
 * "every shop in the world" is an indexer that Kei deliberately does not ship
 * (SPEC §9.4). So a world that wants a bazaar tells this package which chains to
 * read — a directory — and everything read through it is re-read off the chain
 * and verified before a signature is put near it. A wrong directory can hide a
 * stall. It cannot cost anybody an item.
 *
 * What the SDK owes the developer in exchange is that the common flow is one
 * call each:
 *
 *   await shop.list({ item: 'sword', each: 120 })
 *   await shop.buy(listing)
 *   await shop.gift({ to: friend, item: 'potion' })
 *
 * and that the awkward parts — three balances instead of one, a lot price that
 * is not a unit price, an index that must not be trusted, a listing that was
 * bought between the read and the click — are handled here rather than in every
 * game that needs them.
 */

import type { AssetId, KeiClient, Receivable } from '@keicoin/core'
import {
  Emitter,
  KEI_ASSET,
  KEI_DECIMALS,
  KEI_NAME,
  KEI_SYMBOL,
  assertAddress,
  fail,
  formatRaw,
  fromRaw,
  toRaw,
} from '@keicoin/core'
import type {
  AccountDirectory,
  Candle,
  Duration,
  MarketApi,
  MutableDirectory,
  Offer,
  Series,
  TradeOptions,
} from '@keicoin/market'
import { createDirectory, createMarket } from '@keicoin/market'

import { createCatalogue, type Catalogue, type Ware, type WareSpec } from './catalogue.js'
import {
  NO_CHAIN_FUNDS,
  toFunds,
  type ChainFunds,
  type Funds,
  type Pending,
  type PendingKind,
} from './funds.js'
import type {
  BrowseOptions,
  BuyOptions,
  Currency,
  Gift,
  GiftRequest,
  Listing,
  ListingRequest,
  Purchase,
  Reconciled,
  Shelf,
  Shelves,
} from './types.js'

export interface ShopEvents extends Record<string, unknown> {
  /** Anything that could change what is on screen: funds, pending, listings. */
  change: { pending: readonly Pending[] }
  /** One signed action finished, successfully or not. */
  settled: Pending
}

export interface PlayerEconomyOptions {
  /** Share the instance's market so one background expiry sweep runs, not two. */
  market?: MarketApi
  /** What listings are priced in. Kei by default; a world's own coin otherwise. */
  currency?: AssetId | { id: AssetId }
  /** What this world deals in, so a listing has a name rather than a hex id. */
  catalogue?: Iterable<WareSpec>
  /**
   * Which chains to read when browsing.
   *
   * A bounded local roster is created if absent. A world with a server that
   * already knows who is playing implements `AccountDirectory` in four lines and
   * passes that instead — the interface is one method, and nothing read through
   * it is trusted.
   */
  directory?: AccountDirectory
  /** Announce this wallet to the directory whenever it lists or buys. Default true. */
  announce?: boolean
  /** The wallet's clock. Replaceable so a test needs no timers. */
  now?: () => number
}

export interface PlayerEconomyApi {
  readonly address: string
  /** What this shop prices in. Read once at first use and cached. */
  currency(): Promise<Currency>
  readonly catalogue: Catalogue
  readonly directory: AccountDirectory

  // ------------------------------------------------------------------ selling
  /** Put a lot on this player's own shelf. One block, and it locks the goods. */
  list(request: ListingRequest): Promise<Listing>
  /** Take a lot back. Only its author can — only their asset is locked. */
  cancel(listing: Listing | string): Promise<Listing>
  /** This wallet's own stall, read straight off its own chain. */
  mine(options?: { includeExpired?: boolean }): Promise<Listing[]>

  // ------------------------------------------------------------------- buying
  /** Every stall on the chains this shop knows to read. */
  browse(options?: BrowseOptions): Promise<Shelves>
  /** One player's stall. */
  shelfOf(seller: string, options?: BrowseOptions): Promise<Shelf>
  /** Take a listing. One block, both legs or neither, verified before signing. */
  buy(listing: Listing | string, options?: BuyOptions): Promise<Purchase>

  // ------------------------------------------------------------------- giving
  /** Hand somebody Kei, tokens, or an item. No price, no offer, no accept. */
  gift(request: GiftRequest): Promise<Gift>

  // -------------------------------------------------------------------- state
  /** Confirmed, incoming, and in flight, for the currency or any other asset. */
  funds(asset?: string | { id: AssetId }): Promise<Funds>
  /** What this wallet has signed and not yet read back. */
  pending(): readonly Pending[]
  /** Collect arrivals, re-read this stall, and say what moved. */
  sync(): Promise<Reconciled>
  /** Tell the directory this chain is worth reading. Costs and grants nothing. */
  announce(address?: string): void
  on<Key extends keyof ShopEvents & string>(event: Key, listener: (payload: ShopEvents[Key]) => void): () => void

  // ------------------------------------------------------------------ history
  /** What a ware has actually sold for here, ordered and ready to draw. */
  history(options: HistoryOptions): Promise<Series>
  /** The same, as OHLCV buckets. Bucketing is advisory — see `@keicoin/market`. */
  candles(options: HistoryOptions & { every: Duration; fill?: boolean }): Promise<Candle[]>

  close(): void
}

export interface HistoryOptions extends Omit<TradeOptions, 'asset' | 'quote' | 'from'> {
  /** Which ware. A catalogue key, an asset id, or the item object. */
  item: string | { id: AssetId }
  /** Whose chains to read. Defaults to the shop's directory. */
  from?: string | readonly string[]
  /** Keep only the most recent n points. */
  last?: number
}

/** `HistoryOptions` resolved against the catalogue and the shop's currency. */
interface HistoryQuery extends TradeOptions {
  asset: AssetId
  quote: AssetId
  last?: number
}

export function createPlayerEconomy(
  client: KeiClient,
  options: PlayerEconomyOptions = {},
): PlayerEconomyApi {
  const market = options.market ?? createMarket(client)
  const now = options.now ?? Date.now
  const catalogue = createCatalogue(options.catalogue ?? [])
  const directory = options.directory ?? createDirectory({ accounts: [client.address] })
  const shouldAnnounce = options.announce !== false
  const events = new Emitter<ShopEvents>()
  const inFlight: Pending[] = []
  let ticket = 0
  /**
   * Listings this shop has seen open on its own chain.
   *
   * `market.mine({ state: 'open' })` cannot answer "what left", because a
   * listing that was taken is no longer open and so is no longer returned. So
   * the departures have to be a diff against what was there last time, and that
   * is this set. It grows when this wallet lists and empties as `sync()`
   * reports each departure exactly once.
   */
  const watching = new Set<string>()

  const currencyId = options.currency === undefined ? KEI_ASSET : idOf(options.currency)
  let currencyFacts: Currency | undefined

  const currency = async (): Promise<Currency> => {
    if (currencyFacts) return currencyFacts
    currencyFacts = await factsFor(currencyId)
    return currencyFacts
  }

  const factsFor = async (asset: AssetId): Promise<Currency> => {
    if (asset === KEI_ASSET) {
      return { asset: KEI_ASSET, symbol: KEI_SYMBOL, name: KEI_NAME, decimals: KEI_DECIMALS }
    }
    const info = await client.node.assetInfo(asset)
    if (!info) {
      fail(
        'no-such-asset',
        `No asset with id ${asset} exists on ${client.node.network}. A shop's currency is an asset somebody issued — check the id, or check you are on the network that issued it.`,
      )
    }
    return { asset: info.id, symbol: info.symbol, name: info.name, decimals: info.decimals }
  }

  /**
   * The world's word for an asset, then the chain's, then the id.
   *
   * The catalogue is optional, and its own fallback cannot do better than the id
   * because it never reads a chain. Every site here has the asset's facts in
   * hand already — an `OfferLeg` carries `name` and `symbol`, and `factsFor()`
   * has just been awaited — so the id is the last resort rather than the first,
   * and a shop with no catalogue still says "Sword of Testing" in its listings
   * and in the sentences that interpolate a title.
   */
  const wareFor = (asset: AssetId, facts: { name?: string; symbol?: string }): Ware => {
    const declared = catalogue.byAsset(asset)
    if (declared) return declared
    return {
      key: facts.symbol || asset,
      asset,
      title: facts.name || facts.symbol || asset,
    }
  }

  const announce = (address?: string): void => {
    const mutable = directory as Partial<MutableDirectory>
    if (typeof mutable.watch === 'function') mutable.watch(address ?? client.address)
  }

  // ----------------------------------------------------------- in-flight ledger

  /**
   * Run one signed action, counted as a debt from the moment it starts.
   *
   * The entry goes up before the block is signed and comes down once the action
   * has finished and been read back, so two actions started in the same second
   * cannot each be checked against the same units. While it is up it is only
   * ever a debt: money arriving does not fund the next spend until it has
   * arrived (see `funds.ts`).
   */
  const act = async <T>(
    kind: PendingKind,
    what: string,
    moves: Iterable<readonly [AssetId, bigint]>,
    job: () => Promise<{ hash: string; value: T }>,
  ): Promise<T> => {
    const entry: Pending = {
      id: ++ticket,
      kind,
      what,
      state: 'signing',
      moves: new Map(moves),
      hash: null,
      startedAt: now(),
    }
    inFlight.push(entry)
    events.emit('change', { pending: [...inFlight] })

    try {
      const { hash, value } = await job()
      entry.hash = hash
      entry.state = 'settled'
      return value
    } catch (error) {
      entry.state = 'failed'
      // Already a sentence that states its own fix (SPEC §6.1), so it is carried
      // rather than rewritten — a caller watching `pending()` should read the
      // same words the throw carries.
      entry.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      const at = inFlight.indexOf(entry)
      if (at >= 0) inFlight.splice(at, 1)
      events.emit('settled', entry)
      events.emit('change', { pending: [...inFlight] })
    }
  }

  // ------------------------------------------------------------------- reading

  const chainFunds = async (asset: AssetId): Promise<ChainFunds> => {
    const [confirmedRaw, waiting] = await Promise.all([
      asset === KEI_ASSET
        ? client.balanceRaw()
        : client.node.holderBalance(asset, client.address).then((raw) => BigInt(raw)),
      client.node.receivables(client.address),
    ])
    const incomingRaw = waiting.reduce(
      (total: bigint, arrival: Receivable) => (arrival.asset === asset ? total + BigInt(arrival.amount) : total),
      0n,
    )
    return { confirmedRaw, incomingRaw, arrivals: waiting.length }
  }

  /**
   * The purse, plus why it is blank when it is.
   *
   * A read that throws blanks a purse rather than rejecting: zero with
   * `settling` false is wrong in a way a view can see, and a thrown promise is
   * wrong in a way it cannot. But `funds()` is also the precondition check for
   * every write in this file, and there a blank purse becomes a sentence
   * asserting what the wallet holds — which nobody measured. So the reason is
   * carried out alongside the numbers, and a write path refuses on it instead.
   */
  const readFunds = async (
    asset?: string | { id: AssetId },
  ): Promise<{ purse: Funds; unread: unknown }> => {
    const id = asset === undefined ? currencyId : catalogue.assetOf(asset)
    const facts = id === currencyId ? await currency() : await factsFor(id)
    let chain: ChainFunds = NO_CHAIN_FUNDS
    let unread: unknown = null
    try {
      chain = await chainFunds(id)
    } catch (cause) {
      unread = cause ?? new Error('the node did not answer')
    }
    const purse = toFunds({
      asset: id,
      symbol: facts.symbol,
      // The world's word for it, so a purse reads "Iron Sword" rather than the
      // ticker a symbol has to be derived into.
      title: wareFor(id, facts).title,
      decimals: facts.decimals,
      chain,
      pending: inFlight,
      ...(unread === null ? {} : { read: 'failed' as const }),
    })
    return { purse, unread }
  }

  const funds = async (asset?: string | { id: AssetId }): Promise<Funds> => (await readFunds(asset)).purse

  /**
   * The purse a write is allowed to argue with.
   *
   * `canSpend` is right to refuse a blank purse, but "you have 0" is a claim
   * about the wallet, and a failed read is a claim about the node. SPEC §6.1
   * makes the difference the contract: an error has to state a fix the reader
   * can act on, and "acquire some swords" is the wrong errand for somebody
   * holding three of them.
   */
  const spendableFunds = async (asset: string | { id: AssetId } | undefined, attempt: string): Promise<Funds> => {
    const { purse, unread } = await readFunds(asset)
    if (unread !== null) {
      fail(
        'funds-unreadable',
        `This wallet's ${purse.title} balance could not be read, so ${attempt} was not attempted and nothing was signed. ${
          unread instanceof Error ? unread.message : String(unread)
        } Retry once that read succeeds — this says nothing about what the wallet holds.`,
      )
    }
    return purse
  }

  const asListing = (offer: Offer, money: Currency): Listing | null => {
    if (offer.want.asset !== money.asset) return null
    const ware = wareFor(offer.give.asset, offer.give)
    return {
      hash: offer.hash,
      seller: offer.from,
      // This wallet's view, not whichever wallet read the offer first. A
      // `Listing` travels — out of a browse, through a server, into a click —
      // and `offer.mine` is only true for the market that built it.
      mine: offer.from === client.address,
      key: ware.key,
      title: ware.title,
      asset: offer.give.asset,
      qty: offer.give.amount,
      price: offer.want.amount,
      each: offer.give.amount === 0 ? 0 : offer.want.amount / offer.give.amount,
      currency: money,
      life: market.lifeOf(offer),
      reservedFor: offer.to,
      expiresAt: offer.expiresAt,
      offer,
    }
  }

  const mine = async (mineOptions: { includeExpired?: boolean } = {}): Promise<Listing[]> => {
    const money = await currency()
    const offers = await market.mine({
      state: 'open',
      includeExpired: mineOptions.includeExpired !== false,
    })
    return offers.map((offer) => asListing(offer, money)).filter((listing): listing is Listing => listing !== null)
  }

  const browse = async (browseOptions: BrowseOptions = {}): Promise<Shelves> => {
    const money = await currency()
    const from = browseOptions.from ?? directory
    // Browsing "everything" still needs one asset to key the walk on, and the
    // currency is the one thing every stall here has in common: a listing is
    // priced in the world's money, whatever it is selling. Keyed that way the
    // stalls come back as asks: every level gives its non-quote ware and wants
    // the shared quote currency. Keying on one ware produces the same side and
    // narrows the shelf. Same blocks either way.
    const book = await market.book({
      from,
      ...(browseOptions.item === undefined ? {} : { asset: catalogue.assetOf(browseOptions.item) }),
      quote: money.asset,
      ...(browseOptions.limit === undefined ? {} : { limit: browseOptions.limit }),
      includeExpired: browseOptions.includeExpired === true,
      includeMine: browseOptions.includeMine !== false,
    })

    const raw = book.asks
    const listings: Listing[] = []
    for (const offer of raw) {
      const listing = asListing(offer, money)
      if (listing) listings.push(listing)
    }
    listings.sort((a, b) => a.each - b.each || a.title.localeCompare(b.title) || a.hash.localeCompare(b.hash))

    const bySeller = new Map<string, Listing[]>()
    for (const listing of listings) {
      const held = bySeller.get(listing.seller)
      if (held) held.push(listing)
      else bySeller.set(listing.seller, [listing])
    }
    const shelves: Shelf[] = [...bySeller].map(([seller, held]) => ({
      seller,
      mine: seller === client.address,
      listings: held,
    }))
    shelves.sort((a, b) => b.listings.length - a.listings.length || a.seller.localeCompare(b.seller))

    return { shelves, listings, coverage: book.coverage }
  }

  // ------------------------------------------------------------------- writing

  const list = async (request: ListingRequest): Promise<Listing> => {
    if (!request || typeof request !== 'object') {
      fail(
        'bad-listing',
        "shop.list() takes { item, each } — for example shop.list({ item: 'sword', each: 120 }). Add { qty } to sell more than one.",
      )
    }
    const money = await currency()
    const asset = catalogue.assetOf(request.item)
    if (asset === money.asset) {
      fail(
        'same-asset',
        `A listing sells something *for* ${money.symbol}, so it cannot also be selling ${money.symbol} — that trade moves nothing. To swap one currency for another, use market.offer({ give, want }) directly.`,
      )
    }

    const goods = await factsFor(asset)
    const ware = wareFor(asset, goods)
    const qty = wholeQty(request.qty, ware)
    const qtyRaw = toRaw(String(qty), goods.decimals, `The quantity of ${ware.title}`)

    // Per unit × quantity, in raw integers. A JS number does the multiplication
    // wrong at eighteen decimal places and `carpet-markets` had to do it by
    // hand, with a comment about being out by a factor of `amount` — which on a
    // million-unit lot is several orders of magnitude. Doing it here is the
    // whole reason `each` exists as an option.
    const totalRaw = priceRaw(request, qty, money, ware)

    const held = await spendableFunds(asset, `listing ${qty} ${ware.title}`)
    if (held.spendableRaw < qtyRaw) {
      const locked = (await mine()).filter((listing) => listing.asset === asset)
      const hint =
        locked.length > 0
          ? ` ${locked.reduce((total, listing) => total + listing.qty, 0)} ${ware.title} ${locked.length === 1 ? 'is' : 'are'} locked in your own open listings — shop.cancel() frees them.`
          : held.incomingRaw > 0n
            ? ' Some are on their way and not signed for yet — shop.sync() collects them.'
            : ''
      fail(
        'insufficient-balance',
        `You have ${held.spendable} ${ware.title} to list, not ${qty}.${hint}`,
      )
    }

    const to = request.to === undefined ? undefined : assertAddress(request.to, 'reserved buyer address')
    const what = `List ${qty} ${ware.title} for ${formatRaw(totalRaw, money.decimals)} ${money.symbol}`

    const listing = await act('list', what, [[asset, -qtyRaw]], async () => {
      const offer = await market.offer({
        // Exact decimal strings from the raw amounts. A rounded price here is a
        // listing that does not say what the seller meant.
        give: { asset, amount: formatRaw(qtyRaw, goods.decimals) },
        want: { asset: money.asset, amount: formatRaw(totalRaw, money.decimals) },
        ...(to === undefined ? {} : { to }),
        ...(request.expiresIn === undefined ? {} : { expiresIn: request.expiresIn }),
      })
      const made = asListing(offer, money)
      if (!made) {
        fail(
          'listing-unreadable',
          `The offer for ${ware.title} is on the chain as ${offer.hash}, but it does not price in ${money.symbol} and this shop cannot show it. Nothing is lost — read it with market.get('${offer.hash}'), or cancel it with market.cancel('${offer.hash}').`,
        )
      }
      return { hash: offer.hash, value: made }
    })

    watching.add(listing.hash)
    if (shouldAnnounce) announce()
    return listing
  }

  const cancel = async (target: Listing | string): Promise<Listing> => {
    const money = await currency()
    const hash = hashOf(target, 'cancel')
    const before = typeof target === 'string' ? null : target
    const label = before ? `Take back ${before.qty} ${before.title}` : `Cancel listing ${hash.slice(0, 12)}…`

    return act('cancel', label, [], async () => {
      const result = await market.cancel(hash)
      const after = await market.get(hash)
      const listing = after ? asListing(after, money) : null
      if (listing) return { hash: result.hash, value: listing }
      // The cancel block landed; only the read-back shape is missing. Say what
      // came back rather than throwing away a successful recovery.
      return {
        hash: result.hash,
        value:
          before ??
          fail(
            'cancel-unreadable',
            `Listing ${hash} was cancelled by block ${result.hash} and the ${result.returned.amount} ${result.returned.symbol} is back in this wallet, but the offer cannot be read back to describe it. Nothing is lost.`,
          ),
      }
    })
  }

  const buy = async (target: Listing | string, buyOptions: BuyOptions = {}): Promise<Purchase> => {
    const money = await currency()
    const hash = hashOf(target, 'buy')
    const shown = typeof target === 'string' ? null : target

    if (shown !== null && shown.seller === client.address) {
      fail(
        'own-listing',
        `That is this wallet's own listing. Accepting your own offer would trade an asset with itself and move nothing (SPEC §9.2) — shop.cancel() is what takes the ${shown.title} back.`,
      )
    }
    // A bare hash carries no terms, so there is nothing to check it against.
    // That is a legitimate way to take an offer whose terms the caller has
    // already read off the chain, and it is not what `verify` defends — so it
    // is refused only when the caller asked for a check that cannot happen.
    if (buyOptions.verify === true && shown === null) {
      fail(
        'nothing-to-verify',
        `shop.buy('${hash.slice(0, 12)}…', { verify: true }) was given a hash and no terms, so there is nothing to compare the chain against. Pass the listing object from shop.browse() — that is what carries what you were shown.`,
      )
    }

    const priceRawShown = shown ? toRaw(String(shown.price), money.decimals, 'The listing price') : null
    const purse = await spendableFunds(money.asset, shown ? `buying ${shown.title}` : `taking offer ${hash.slice(0, 12)}…`)
    if (priceRawShown !== null && purse.spendableRaw < priceRawShown) {
      fail(
        'insufficient-balance',
        `${shown?.title} costs ${shown?.price} ${money.symbol} and this wallet can spend ${purse.spendable}.${
          purse.incomingRaw > 0n
            ? ` Another ${purse.incoming} is on its way and not signed for yet — shop.sync() collects it.`
            : ''
        }${
          purse.committedRaw > 0n
            ? ` ${purse.committed} is committed to something this wallet signed a moment ago.`
            : ''
        }`,
      )
    }

    const what = shown ? `Buy ${shown.qty} ${shown.title} for ${shown.price} ${money.symbol}` : `Take offer ${hash.slice(0, 12)}…`
    const moves: Array<readonly [AssetId, bigint]> = priceRawShown === null ? [] : [[money.asset, -priceRawShown]]

    const purchase = await act('buy', what, moves, async () => {
      const settlement = await market.accept(hash, {
        // Built from the listing's own displayed fields rather than from the
        // `offer` it carries. Those fields are what a view rendered and what a
        // server could have rewritten on the way; the nested offer is a copy of
        // a chain read, so checking against it would be checking the chain
        // against itself. A directory is a list of where to look and never an
        // authority (SPEC §9.4), and this is what keeps that true.
        ...(shown !== null && buyOptions.verify !== false
          ? {
              expect: {
                hash: shown.hash,
                seller: shown.seller,
                give: { asset: shown.asset, amount: shown.qty },
                want: { asset: money.asset, amount: shown.price },
                to: shown.reservedFor,
              },
            }
          : {}),
      })
      const ware = wareFor(settlement.received.asset, settlement.received)
      const made: Purchase = {
        hash: settlement.hash,
        listing:
          shown ??
          ({
            hash,
            seller: settlement.from,
            mine: false,
            key: ware.key,
            title: ware.title,
            asset: settlement.received.asset,
            qty: settlement.received.amount,
            price: settlement.paid.amount,
            each: settlement.received.amount === 0 ? 0 : settlement.paid.amount / settlement.received.amount,
            currency: money,
            life: 'taken',
            reservedFor: null,
            expiresAt: null,
            offer: (await market.get(hash)) as Offer,
          } satisfies Listing),
        received: {
          asset: settlement.received.asset,
          key: ware.key,
          title: ware.title,
          qty: settlement.received.amount,
        },
        paid: {
          asset: settlement.paid.asset,
          symbol: settlement.paid.symbol,
          amount: settlement.paid.amount,
        },
      }
      return { hash: settlement.hash, value: made }
    })

    if (shouldAnnounce) {
      // Both chains can carry the next listing: this one because it now holds
      // the goods, the seller's because it now holds the money.
      announce()
      announce(purchase.listing.seller)
    }
    return purchase
  }

  const gift = async (request: GiftRequest): Promise<Gift> => {
    if (!request || typeof request !== 'object') {
      fail(
        'bad-gift',
        "shop.gift() takes { to } and one of { kei }, { item }, or { asset, amount } — for example shop.gift({ to: friend, item: 'potion' }).",
      )
    }
    const to = assertAddress(request.to, 'recipient address')
    if (to === client.address) {
      fail(
        'self-gift',
        'That is this wallet\'s own address. A gift to yourself moves nothing and still writes a block — send it to somebody else.',
      )
    }

    const named = [request.kei !== undefined, request.item !== undefined, request.asset !== undefined].filter(
      Boolean,
    ).length
    if (named !== 1) {
      fail(
        'bad-gift',
        named === 0
          ? "shop.gift() needs to know what to give: { kei: 0.5 }, { item: 'potion' }, or { asset, amount }."
          : 'shop.gift() gives one thing per call, and { kei }, { item }, and { asset } are three different things. A block moves one asset (SPEC §5.6.1), so two gifts are two calls.',
      )
    }

    if (request.kei !== undefined) {
      const amountRaw = toRaw(request.kei, KEI_DECIMALS, 'The Kei to give')
      const purse = await spendableFunds(KEI_ASSET, `this gift of ${fromRaw(amountRaw, KEI_DECIMALS)} Kei`)
      if (purse.spendableRaw < amountRaw) {
        fail(
          'insufficient-balance',
          `Not enough Kei — this wallet can spend ${purse.spendable}, and this gift is ${fromRaw(amountRaw, KEI_DECIMALS)}.${
            purse.incomingRaw > 0n ? ` Another ${purse.incoming} is on its way — shop.sync() collects it.` : ''
          }`,
        )
      }
      const amount = fromRaw(amountRaw, KEI_DECIMALS)
      return act('gift', `Give ${amount} Kei to ${to.slice(0, 12)}…`, [[KEI_ASSET, -amountRaw]], async () => {
        const receipt = await client.send(to, formatRaw(amountRaw, KEI_DECIMALS))
        return {
          hash: receipt.hash,
          value: { hash: receipt.hash, to, asset: KEI_ASSET, symbol: KEI_SYMBOL, ware: null, amount },
        }
      })
    }

    const asset = catalogue.assetOf((request.item ?? request.asset) as string | { id: AssetId })
    const facts = await factsFor(asset)
    // `ware` stays null when the world never declared one — a `Gift` says
    // whether it was catalogued. The label is what a player reads, so it falls
    // back to the chain's name the same way every other sentence here does.
    const ware: Ware | null = catalogue.byAsset(asset) ?? null
    const label = wareFor(asset, facts).title
    const amountRaw = toRaw(request.amount ?? 1, facts.decimals, `The ${label} to give`)
    if (amountRaw <= 0n) {
      fail('bad-amount', `A gift of ${label} is at least one unit — got ${String(request.amount)}.`)
    }
    const held = await spendableFunds(asset, `this gift of ${fromRaw(amountRaw, facts.decimals)} ${label}`)
    if (held.spendableRaw < amountRaw) {
      fail(
        'insufficient-balance',
        `You have ${held.spendable} ${label} to give, not ${fromRaw(amountRaw, facts.decimals)}.${
          held.incomingRaw > 0n ? ' Some are on their way and not signed for yet — shop.sync() collects them.' : ''
        }`,
      )
    }

    const amount = fromRaw(amountRaw, facts.decimals)
    return act('gift', `Give ${amount} ${label} to ${to.slice(0, 12)}…`, [[asset, -amountRaw]], async () => {
      const { hash } = await client.submitAsset({
        kind: 'transfer',
        asset,
        to,
        amount: amountRaw.toString(),
      })
      return { hash, value: { hash, to, asset, symbol: facts.symbol, ware, amount } }
    })
  }

  // ------------------------------------------------------------ reconciliation

  const sync = async (): Promise<Reconciled> => {
    // Receive first, then read. A purchase arrives as a receivable and is not
    // this wallet's until this wallet signs for it (SPEC §5.6.3), so reading
    // before collecting shows the truth about the wrong moment.
    const received = await client.receiveAll()
    const money = await currency()

    const open = await mine({ includeExpired: true })
    for (const listing of open) watching.add(listing.hash)
    const reconciliation = await market.reconcile(watching)

    const asListings = (offers: readonly Offer[]): Listing[] =>
      offers.map((offer) => asListing(offer, money)).filter((listing): listing is Listing => listing !== null)

    // Reported once. A sale this wallet has already been told about is history,
    // not news, and a `gone` list that repeats itself every poll is a list a
    // view learns to ignore.
    watching.clear()
    for (const offer of [...reconciliation.live, ...reconciliation.stale]) watching.add(offer.hash)
    // A listing whose re-read failed has not been shown to have moved — leave
    // it in `watching` and ask again next round, rather than letting the
    // rebuild above silently drop it the way an unreachable node would read as
    // "sold" (#189; `reconcileOffers`' own contract for `failed`).
    for (const failure of reconciliation.failed) watching.add(failure.hash)
    // Hashes the node has never heard of are not retried — asking again does
    // not fix a typo or a different network — but the drop is deliberate and
    // reported below, not silent.

    const report: Reconciled = {
      received,
      mine: asListings(reconciliation.live),
      gone: reconciliation.gone,
      stale: asListings(reconciliation.stale),
      unresolved: reconciliation.failed.map((failure) => ({ hash: failure.hash, reason: failure.reason })),
      unknown: reconciliation.unknown,
      funds: await funds(money.asset),
    }
    events.emit('change', { pending: [...inFlight] })
    return report
  }

  // ------------------------------------------------------------------ history

  /** One query both `history()` and `candles()` are built from. */
  const historyQuery = async (historyOptions: HistoryOptions): Promise<HistoryQuery> => {
    if (!historyOptions?.item) {
      fail(
        'no-item',
        "This reads what one ware has sold for: { item: 'sword' }. There is no 'everything' — a chart of two different things is not a chart.",
      )
    }
    const money = await currency()
    return {
      asset: catalogue.assetOf(historyOptions.item),
      quote: money.asset,
      from: historyOptions.from ?? directory,
      ...(historyOptions.window === undefined ? {} : { window: historyOptions.window }),
      ...(historyOptions.limit === undefined ? {} : { limit: historyOptions.limit }),
      ...(historyOptions.last === undefined ? {} : { last: historyOptions.last }),
    }
  }

  return {
    address: client.address,
    currency,
    catalogue,
    directory,

    list,
    cancel,
    mine,

    browse,
    async shelfOf(seller, browseOptions = {}) {
      const address = assertAddress(seller, 'seller address')
      const all = await browse({ ...browseOptions, from: [address] })
      return all.shelves[0] ?? { seller: address, mine: address === client.address, listings: [] }
    },
    buy,

    gift,

    funds,
    pending: () => [...inFlight],
    sync,
    announce,
    on: (event, listener) => events.on(event, listener),

    async history(historyOptions) {
      return market.series(await historyQuery(historyOptions))
    },

    async candles(candleOptions) {
      return market.candles({
        ...(await historyQuery(candleOptions)),
        every: candleOptions.every,
        ...(candleOptions.fill === undefined ? {} : { fill: candleOptions.fill }),
      })
    },

    close() {
      events.clear()
      inFlight.length = 0
    },
  }
}

// ------------------------------------------------------------------- helpers

function idOf(asset: AssetId | { id: AssetId }): AssetId {
  const id = typeof asset === 'string' ? asset : asset?.id
  if (typeof id !== 'string' || id === '') {
    fail('bad-asset', "A shop's currency is an asset id, or the token object itself: { currency: gold }.")
  }
  return id.toUpperCase()
}

function hashOf(target: Listing | string, verb: string): string {
  const hash = typeof target === 'string' ? target : target?.hash
  if (typeof hash !== 'string' || hash === '') {
    fail(
      'bad-listing',
      `shop.${verb}() takes a listing, or its hash. Read one from shop.browse() or shop.mine() — an offer's hash is its id, not something to type.`,
    )
  }
  return hash.toUpperCase()
}

function wholeQty(qty: number | undefined, ware: Ware): number {
  if (qty === undefined) return 1
  if (!Number.isInteger(qty) || qty < 1) {
    fail(
      'bad-quantity',
      `A lot holds a whole number of ${ware.title}, one or more — got ${String(qty)}.`,
    )
  }
  return qty
}

/**
 * What the lot costs, in raw currency units.
 *
 * Exactly one of `each` and `price`, and the refusal names both, because the
 * single most expensive mistake anybody has made with this package is passing a
 * per-unit price where a lot price was wanted. On a thousand-unit lot that is a
 * listing priced a thousand times wrong, and the ledger will settle it happily.
 */
function priceRaw(
  request: ListingRequest,
  qty: number,
  money: Currency,
  ware: Ware,
): bigint {
  const hasEach = request.each !== undefined
  const hasPrice = request.price !== undefined
  if (hasEach === hasPrice) {
    fail(
      'bad-price',
      hasEach
        ? `Pass { each } or { price }, not both: { each: 12 } is 12 ${money.symbol} per ${ware.title} and { price: 12 } is 12 ${money.symbol} for the whole lot of ${qty}.`
        : `A listing needs a price: { each: 12 } for 12 ${money.symbol} per ${ware.title}, or { price: 12 } for 12 ${money.symbol} for the whole lot.`,
    )
  }

  if (hasPrice) {
    const total = toRaw(request.price as number | string, money.decimals, 'The asking price')
    if (total <= 0n) fail('bad-price', `The asking price is more than zero — got ${String(request.price)}.`)
    return total
  }

  // Integer multiplication, deliberately. `each * qty` as a JS number is wrong
  // in the last decimal places of any currency with real precision.
  const each = toRaw(request.each as number | string, money.decimals, 'The price per unit')
  if (each <= 0n) fail('bad-price', `The price per unit is more than zero — got ${String(request.each)}.`)
  return each * BigInt(qty)
}
