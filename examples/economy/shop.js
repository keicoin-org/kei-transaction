/**
 * A whole game economy, end to end, in one file you can run.
 *
 *   bun examples/economy/shop.js
 *
 * It uses `Kei.mock()` so it needs no network and no keys. Point it at a real
 * node and the only line that changes is the one that makes the node:
 *
 *   const node = 'https://testnet.keicoin.org/rpc'
 *   const game = await Kei.server({ seed: process.env.KEI_SEED, node })
 *
 * The two halves below are deliberately kept apart. `server()` runs on a
 * machine you own and holds the game's seed; `browser()` runs in front of a
 * player and holds theirs. They share the recipe file and the game's address,
 * and nothing else — no session, no order id, no pending state anywhere.
 */

import { Kei, randomSeed } from 'kei-transaction'

import { catalogue } from './recipes.js'

const line = (text) => console.log(`\n── ${text}`)

// ---------------------------------------------------------------- the game

async function server(node) {
  // In production: Kei.server({ seed: process.env.KEI_SEED, node }). The seed
  // never reaches a browser — an issuer seed in the client is a total
  // compromise of the economy.
  const game = await Kei.server({ seed: 'C'.repeat(64), node })
  await game.faucet(20_000)

  // Issuing is idempotent per (issuer, symbol), so this is safe to run at every
  // boot. The nth asset an account issues burns n Kei (SPEC §5.6.5).
  await game.token.issue({ name: 'Gold', symbol: 'GOLD', decimals: 0, maxSupply: 10_000_000 })
  await game.token.issue({ name: 'Scrap Metal', symbol: 'SCRAP', decimals: 0 })
  await game.token.issue({ name: 'Iron Sword', symbol: 'SWORD', decimals: 0, maxSupply: 500 })
  await game.token.issue({ name: 'Guild Sigil', symbol: 'SIGIL', decimals: 0, transfer: 'none' })

  for (const recipe of catalogue(game.address).values()) game.economy.define(recipe)
  return game
}

// -------------------------------------------------------------- the player

async function browser(node, gameAddress) {
  // In production: Kei.start() — no arguments, no signup, no API key. The seed
  // is generated and persisted in browser storage on first run.
  const kei = await Kei.start({ node, seed: randomSeed(), recipes: catalogue(gameAddress).values() })
  return kei
}

// ------------------------------------------------------------------- a day

const node = await Kei.mock()
const game = await server(node)
const player = await browser(node, game.address)

// Some starting Kei, so the player's own blocks are affordable. (They are
// free; this is here so the example reads like a funded account.)
await game.send(player.address, 20)
await player.sync()

line('The game hands out a daily bonus. Only the issuer can mint.')
{
  const plan = await game.economy.plan('daily-bonus', { player: player.address })
  console.log(plan.explain())
  await game.economy.run('daily-bonus', { player: player.address })
  await player.sync()
}

line('The browser cannot mint, and the refusal names the half that can.')
try {
  await player.economy.run('daily-bonus')
} catch (error) {
  console.log(error.message)
}

line('A sink: the player burns their own gold, signed by them, in one block.')
{
  const gold = await player.token('GOLD', game.address)
  console.log('gold before  ', await gold.balance())
  await player.economy.run('repair-armour')
  console.log('gold after   ', await gold.balance())
  console.log('supply after ', (await gold.info()).circulating, '— the units are gone, not parked')
}

line('The shop is empty, and the plan says whose job it is to fill it.')
{
  // Give the player something to trade in first. Issuing is idempotent per
  // (issuer, symbol), so this reads back the SCRAP issued at boot rather than
  // paying for a second one.
  const scrap = await game.token.issue({ name: 'Scrap Metal', symbol: 'SCRAP', decimals: 0 })
  await scrap.mint(player.address, 100)
  await player.sync()

  const plan = await player.economy.plan('forge-sword')
  console.log('ok:', plan.ok)
  for (const problem of plan.problems) console.log(' ', problem.message)
}

line('The game stocks three swords. Each copy is one offer block.')
{
  const offers = await game.economy.stock('forge-sword', { count: 3, mint: true })
  console.log(offers.map((offer) => `${offer.hash.slice(0, 12)}…  ${offer.give.amount} ${offer.give.symbol} for ${offer.want.amount} ${offer.want.symbol}`))
}

line('The player forges one. Thirty scrap and one sword move in the same block.')
{
  const plan = await player.economy.plan('forge-sword')
  console.log(plan.explain())

  const result = await player.economy.run('forge-sword')
  await Promise.all([player.sync(), game.sync()])

  const scrap = await player.token('SCRAP', game.address)
  const sword = await player.token('SWORD', game.address)
  console.log('settled in block', result.settlement.hash.slice(0, 12) + '…')
  console.log('player scrap    ', await scrap.balance())
  console.log('player swords   ', await sword.balance())
  console.log('game scrap      ', await scrap.balanceOf(game.address))
  console.log('shelf remaining ', (await player.economy.listings('forge-sword')).length)
}

line('A gate the player has not met is a problem, and it says it is a gate.')
{
  const plan = await player.economy.plan('temper-sword')
  for (const problem of plan.problems) console.log(' ', problem.message)
}

line('The game grants the sigil. It is soulbound: earned, never sold.')
{
  await game.economy.run('guild-sigil', { player: player.address })
  await player.sync()
  const plan = await player.economy.plan('temper-sword')
  console.log('ok:', plan.ok)
  await player.economy.run('temper-sword')
  const scrap = await player.token('SCRAP', game.address)
  console.log('player scrap after tempering', await scrap.balance())
}

line('Nothing above kept a balance anywhere but the ledger.')
console.log(await player.wallet.summary())

game.close()
player.close()
