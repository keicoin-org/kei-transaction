/**
 * The derivations, and the one rule that is not ours to invent.
 *
 * `symbolFor` copies the ticker rule out of `@keicoin/core` so that the harness
 * ships with no dependencies. A copy is a thing that drifts, so the copy is
 * checked against the original here — where the SDK is on hand anyway.
 */

import { describe, expect, test } from 'bun:test'
import { normalizeSymbol } from '@keicoin/core'

import { HarnessError } from '../src/errors.js'
import { projectFrom, slugFor, symbolFor } from '../src/naming.js'

describe('slugFor', () => {
  test('turns a title into a directory name', () => {
    expect(slugFor('Star Clicker')).toBe('star-clicker')
    expect(slugFor('  My Game!!  ')).toBe('my-game')
    expect(slugFor('already-kebab')).toBe('already-kebab')
    expect(slugFor('Crystal 2')).toBe('crystal-2')
  })

  test('refuses a name with nothing in it to use', () => {
    expect(() => slugFor('***')).toThrow(HarnessError)
    expect(() => slugFor('***')).toThrow(/no letters or digits/)
  })

  test('refuses a name npm would refuse', () => {
    expect(() => slugFor('a'.repeat(215))).toThrow(/longer than npm allows/)
  })
})

describe('symbolFor', () => {
  test('takes the first word, uppercased', () => {
    expect(symbolFor('Gems')).toBe('GEMS')
    expect(symbolFor('gold pieces')).toBe('GOLD')
    expect(symbolFor('Bits')).toBe('BITS')
    expect(symbolFor('Star Bucks')).toBe('STAR')
  })

  test('truncates rather than inventing an abbreviation', () => {
    expect(symbolFor('Doubloons')).toBe('DOUBL')
  })

  test('drops punctuation the chain would reject', () => {
    expect(symbolFor("Miner's Credit")).toBe('MINER')
    expect(symbolFor('Zed_9')).toBe('ZED9')
  })

  test('refuses what cannot become a ticker', () => {
    expect(() => symbolFor('***')).toThrow(HarnessError)
    expect(() => symbolFor('-nope')).toThrow(/will not accept/)
  })

  /** The rule belongs to the node. If this fails, the copy has drifted. */
  test('agrees with normalizeSymbol in @keicoin/core', () => {
    for (const currency of ['Gems', 'gold pieces', 'Bits', 'Doubloons', "Miner's Credit", 'Zed_9', 'Crystal 2']) {
      const symbol = symbolFor(currency)
      expect(normalizeSymbol(symbol)).toBe(symbol)
    }
  })

  test('every symbol it rejects, the node rejects too', () => {
    for (const currency of ['***', '-nope', '   ', '!']) {
      expect(() => symbolFor(currency)).toThrow(HarnessError)
    }
  })
})

describe('projectFrom', () => {
  test('completes the two answers', () => {
    expect(projectFrom({ name: 'Star Clicker', currency: 'Gems' })).toEqual({
      title: 'Star Clicker',
      slug: 'star-clicker',
      currency: 'Gems',
      symbol: 'GEMS',
    })
  })

  test('asks again rather than guessing', () => {
    expect(() => projectFrom({ name: '', currency: 'Gems' })).toThrow(/project needs a name/)
    expect(() => projectFrom({ name: 'Star Clicker', currency: '  ' })).toThrow(/currency needs a name/)
  })
})
