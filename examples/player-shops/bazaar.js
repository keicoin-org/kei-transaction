/**
 * Two players, two stalls, and no shop.
 *
 *   bun examples/player-shops/bazaar.js
 *
 * It uses `Kei.mock()` so it needs no network and no keys. Point it at a real
 * node and the only line that changes is the one that makes the node:
 *
 *   const node = 'https://testnet.keicoin.org/rpc'
 *
 * The part worth noticing is what is *not* here. There is no shop server, no
 * listings table, no escrow account, and no moment where anything holds
 * somebody else's gold. A stall is a set of blocks on one player's own chain, a
 * sale is one block that moves both legs or neither (SPEC §9.2), and the only
 * thing the world provides is a list of which chains are worth reading — which
 * is the one thing a chain deliberately will not do for you (SPEC §9.4).
 */

import { Kei, createDirectory, randomSeed } from 'kei-transaction'

const line = (text) => console.log(`\n── ${text}`)
const money = (funds) => `${funds.confirmed} ${funds.title}`

// ------------------------------------------------------------------ the world

/**
 * What a world hands a browser, and none of it is a secret or a credential.
 *
 * `directory` is the whole backend. In a real game it is a `watch` route and a
 * bounded set behind it, or an `AccountDirectory` that reads your own player
 * table — the interface is one method. Here it is in memory, because two
 * players in one process is what this file is.
 */
function shopFor(gold, sword, potion, directory) {
  return {
    currency: gold.id,
    catalogue: [
      { key: 'sword', asset: sword.id, title: 'Iron Sword' },
      { key: 'potion', asset: potion.id, title: 'Healing Potion' },
    ],
    directory,
  }
}

async function main() {
  const node = await Kei.mock()

  // The game's server: it issues the money and the goods, and that is all it
  // ever does here. It cannot list, buy, cancel, or gift for anybody.
  const game = await Kei.server({ seed: 'C'.repeat(64), node })
  await game.faucet(20_000)
  const gold = await game.token.issue({ name: 'Gold', symbol: 'GOLD', decimals: 0 })
  const sword = await game.items.create({ name: 'Iron Sword', supply: 1_000 })
  const potion = await game.items.create({ name: 'Healing Potion', supply: 1_000 })

  const directory = createDirectory()
  const shop = shopFor(gold, sword, potion, directory)

  // Two browsers. In production these are `Kei.start()` with no arguments: the
  // seed is generated and persisted on first run, and there is no signup.
  const alice = await Kei.start({ node, seed: randomSeed(), shop })
  const bob = await Kei.start({ node, seed: randomSeed(), shop })

  for (const player of [alice, bob]) {
    await game.send(player.address, 10)
    await gold.mint(player.address, 500)
  }
  await (await game.items.token(sword.id)).mint(alice.address, 3)
  await (await game.items.token(potion.id)).mint(bob.address, 6)
  await Promise.all([alice.sync(), bob.sync()])

  // ------------------------------------------------------------- the sixty
  // Everything below this line is the whole API. Paste it into a world.

  line('Alice opens a stall')
  const swords = await alice.shop.list({ item: 'sword', qty: 2, each: 120 })
  console.log(`  ${swords.qty} × ${swords.title} at ${swords.each} GOLD each — ${swords.price} for the lot`)
  console.log(`  alice still holds  ${money(await alice.shop.funds('sword'))}`)
  console.log('  the other two are locked by the ledger, not by a database')

  line('Bob opens one too')
  const potions = await bob.shop.list({ item: 'potion', qty: 4, each: 15 })
  console.log(`  ${potions.qty} × ${potions.title} at ${potions.each} GOLD each`)

  line('Bob browses')
  const shelves = await bob.shop.browse()
  for (const shelf of shelves.shelves) {
    console.log(`  ${shelf.mine ? 'your stall' : shelf.seller.slice(0, 16) + '…'}`)
    for (const listing of shelf.listings) {
      console.log(`    ${listing.qty} × ${listing.title.padEnd(16)} ${listing.each} GOLD each`)
    }
  }
  console.log(`  read ${shelves.coverage.read} chains, complete: ${shelves.coverage.complete}`)

  line('Bob buys the swords')
  const purchase = await bob.shop.buy(shelves.listings.find((listing) => listing.key === 'sword'))
  console.log(`  one block moved both legs: ${purchase.received.qty} ${purchase.received.title} for ${purchase.paid.amount} GOLD`)

  await Promise.all([alice.shop.sync(), bob.shop.sync()])
  console.log(`  alice gold  ${money(await alice.shop.funds())}`)
  console.log(`  bob gold    ${money(await bob.shop.funds())}`)
  console.log(`  bob swords  ${money(await bob.shop.funds('sword'))}`)

  line('Bob gives Alice a potion, for nothing')
  await bob.shop.gift({ to: alice.address, item: 'potion' })
  await alice.shop.sync()
  console.log(`  alice potions ${money(await alice.shop.funds('potion'))}`)

  line('Alice takes her last sword back off the shelf')
  const remaining = await alice.shop.list({ item: 'sword', each: 200 })
  await alice.shop.cancel(remaining)
  console.log(`  open listings ${(await alice.shop.mine()).length}`)

  // --------------------------------------------------------- the honest parts

  line('What it sold for, read off the chain')
  const history = await alice.shop.history({ item: 'sword' })
  console.log(`  ${history.points.length} trade(s), median ${history.summary.median} GOLD each`)
  console.log(`  ordered by ${history.ordering.by}, exact: ${history.ordering.exact}`)
  console.log('  the prices are consensus; the order is this node\'s opinion — there is no clock')

  line('What the world could not see')
  const stranger = await Kei.start({
    node,
    seed: randomSeed(),
    shop: { ...shop, directory: createDirectory(), announce: false },
  })
  await game.send(stranger.address, 10)
  await (await game.items.token(sword.id)).mint(stranger.address, 1)
  await stranger.sync()
  await stranger.shop.list({ item: 'sword', each: 5 })

  const before = await bob.shop.browse({ item: 'sword' })
  console.log(`  a stranger is selling a sword at 5 GOLD; the hall shows ${before.listings.length}`)
  console.log('  not a bug: an offer lives on its author\'s chain and Kei ships no indexer (SPEC §9.4)')
  directory.watch(stranger.address)
  const after = await bob.shop.browse({ item: 'sword' })
  console.log(`  after one announce: ${after.listings.length}, at ${after.listings[0].each} GOLD`)
  console.log(`  read ${after.coverage.read} chains — a hall is a floor, never a census`)

  line('What the world cannot do')
  try {
    await game.shop.cancel(after.listings[0].hash)
  } catch (error) {
    console.log(`  ${error.message}`)
  }

  for (const wallet of [game, alice, bob, stranger]) wallet.close()
}

await main()
