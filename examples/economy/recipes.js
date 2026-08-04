/**
 * The shared file.
 *
 * Both halves of the game import this one, and neither can edit it: a recipe
 * is frozen at `defineRecipe()`. Assets are named by symbol and issuer rather
 * than by id, so this file can be written before the tokens exist and does not
 * change when the game is redeployed against a different network.
 *
 * Nothing here reads a chain or signs anything.
 */

import { defineRecipes } from 'kei-transaction'

/**
 * The game's own address. In a real project this is a constant you publish —
 * the browser needs it to know whose chain the shop lives on.
 */
export function catalogue(gameAddress) {
  return defineRecipes([
    {
      id: 'daily-bonus',
      name: 'Daily Bonus',
      description: 'Fifty gold, once a day, from the game.',
      grants: [{ asset: { symbol: 'GOLD' }, amount: 50 }],
      issuer: gameAddress,
    },
    {
      id: 'repair-armour',
      name: 'Repair Armour',
      description: 'Twenty gold, destroyed. This is the sink that keeps gold worth something.',
      costs: [{ asset: { symbol: 'GOLD' }, amount: 20 }],
      issuer: gameAddress,
    },
    {
      id: 'forge-sword',
      name: 'Forge an Iron Sword',
      description: 'Thirty scrap for a sword. One block, both legs or neither.',
      costs: [{ asset: { symbol: 'SCRAP' }, amount: 30 }],
      grants: [{ asset: { symbol: 'SWORD' } }],
      issuer: gameAddress,
    },
    {
      id: 'guild-sigil',
      name: 'Guild Sigil',
      description: 'Soulbound, so it can never be sold — only earned and retired.',
      grants: [{ asset: { symbol: 'SIGIL' } }],
      issuer: gameAddress,
    },
    {
      id: 'temper-sword',
      name: 'Temper a Sword',
      description: 'A guild member only. Ten scrap, burned, for the tempering.',
      requires: [{ asset: { symbol: 'SIGIL' } }],
      costs: [{ asset: { symbol: 'SCRAP' }, amount: 10 }],
      issuer: gameAddress,
    },
  ])
}
