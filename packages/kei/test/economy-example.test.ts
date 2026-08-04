/**
 * The example in `examples/economy` is documentation that can rot, and README
 * snippets that no longer run are worse than no snippets. This runs it as a
 * real subprocess and checks the lines a reader would check.
 *
 * A subprocess rather than an import, for the same reason the browser-bundle
 * tests shell out: it proves the file works on its own, with no state this
 * suite happens to have set up.
 */

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const example = resolve(import.meta.dir, '../../../examples/economy/shop.js')

describe('examples/economy', () => {
  test('runs end to end, with no arguments and no network', async () => {
    const proc = Bun.spawn(['bun', example], { stdout: 'pipe', stderr: 'pipe' })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)

    // The reward is minted by the issuer, and the browser is refused.
    expect(stdout).toContain('[issuer signs] mint')
    expect(stdout).toContain('a browser that could would be holding your issuer seed')

    // The sink actually removes supply.
    expect(stdout).toContain('gold after    30')
    expect(stdout).toContain('the units are gone, not parked')

    // The exchange settles both legs, and the shelf shrinks by one.
    expect(stdout).toContain('[player signs] accept')
    expect(stdout).toContain('player scrap     70')
    expect(stdout).toContain('player swords    1')
    expect(stdout).toContain('game scrap       30')
    expect(stdout).toContain('shelf remaining  2')

    // The gate reads as a gate, then opens.
    expect(stdout).toContain('it is a gate, not a price')
    expect(stdout).toContain('player scrap after tempering 60')
  }, 60_000)
})
