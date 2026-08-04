/**
 * `examples/player-shops` is documentation that can rot, and a README snippet
 * that no longer runs is worse than no snippet. This runs it as a real
 * subprocess and checks the lines a reader would check.
 *
 * A subprocess rather than an import, for the same reason the other example
 * test shells out: it proves the file works on its own, with no state this
 * suite happens to have set up.
 */

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const example = resolve(import.meta.dir, '../../../examples/player-shops/bazaar.js')

describe('examples/player-shops', () => {
  test('runs end to end, with no arguments and no network', async () => {
    const proc = Bun.spawn([process.execPath, example], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)

    // Two stalls, and listing locks the goods on the seller's own chain.
    expect(stdout).toContain('2 × Iron Sword at 120 GOLD each — 240 for the lot')
    expect(stdout).toContain('alice still holds  1 Iron Sword')
    expect(stdout).toContain('4 × Healing Potion at 15 GOLD each')

    // A browse across both, and the coverage that says how much it saw.
    expect(stdout).toContain('read 2 chains, complete: true')

    // One block, both legs, and the balances afterwards come off the chain.
    expect(stdout).toContain('one block moved both legs: 2 Iron Sword for 240 GOLD')
    expect(stdout).toContain('alice gold  740 Gold')
    expect(stdout).toContain('bob gold    260 Gold')
    expect(stdout).toContain('bob swords  2 Iron Sword')

    // A gift is one call and needs no offer.
    expect(stdout).toContain('alice potions 1 Healing Potion')
    expect(stdout).toContain('open listings 0')

    // History, with the sequence caveat stated rather than implied.
    expect(stdout).toContain('median 120 GOLD each')
    expect(stdout).toContain('ordered by advisory-time')
    expect(stdout).toContain('there is no clock')

    // Partial discovery is shown as the design rather than hidden as a bug.
    expect(stdout).toContain('the hall shows 0')
    expect(stdout).toContain('Kei ships no indexer')
    expect(stdout).toContain('after one announce: 1, at 5 GOLD')
    expect(stdout).toContain('a floor, never a census')

    // And the world cannot touch a player's stall.
    expect(stdout).toContain('only its author can cancel it')
  }, 60_000)
})
