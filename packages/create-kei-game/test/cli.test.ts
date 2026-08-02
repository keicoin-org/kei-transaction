/**
 * The command line. Every prompt has a flag, because an agent cannot answer a
 * prompt (SPEC §12) and neither can CI.
 */

import { describe, expect, test } from 'bun:test'

import { DEFAULT_CURRENCY, helpText, parseArgs } from '../src/cli.js'
import { HarnessError } from '../src/errors.js'

describe('parseArgs', () => {
  test('nothing given means everything gets asked', () => {
    expect(parseArgs([])).toEqual({ yes: false, force: false, help: false, version: false })
  })

  test('takes the project name as the first positional', () => {
    expect(parseArgs(['star-clicker']).name).toBe('star-clicker')
    expect(parseArgs(['Star Clicker']).name).toBe('Star Clicker')
  })

  test('takes the currency both ways round', () => {
    expect(parseArgs(['--currency', 'Gems']).currency).toBe('Gems')
    expect(parseArgs(['--currency=Gems']).currency).toBe('Gems')
  })

  test('runs unattended', () => {
    const options = parseArgs(['star-clicker', '--currency', 'Gems', '--yes', '--force'])
    expect(options).toEqual({
      name: 'star-clicker',
      currency: 'Gems',
      yes: true,
      force: true,
      help: false,
      version: false,
    })
  })

  test('short flags', () => {
    expect(parseArgs(['-y']).yes).toBe(true)
    expect(parseArgs(['-h']).help).toBe(true)
    expect(parseArgs(['-v']).version).toBe(true)
  })

  test('says what it does understand', () => {
    expect(() => parseArgs(['--renderer', 'three'])).toThrow(HarnessError)
    expect(() => parseArgs(['--renderer', 'three'])).toThrow(/not an option this understands/)
  })

  test('refuses a currency flag with nothing after it', () => {
    expect(() => parseArgs(['--currency'])).toThrow(/needs a name after it/)
    expect(() => parseArgs(['--currency', '--yes'])).toThrow(/needs a name after it/)
  })

  test('an unquoted two-word name is a mistake worth naming', () => {
    expect(() => parseArgs(['Star', 'Clicker'])).toThrow(/Quote it if the name has a space/)
  })

  test('takes the template both ways round', () => {
    expect(parseArgs(['--template', 'world-of-wonder']).template).toBe('world-of-wonder')
    expect(parseArgs(['--template=world-of-wonder']).template).toBe('world-of-wonder')
  })

  test('refuses a template flag with nothing after it', () => {
    expect(() => parseArgs(['--template'])).toThrow(/needs a name after it/)
    expect(() => parseArgs(['--template', '--yes'])).toThrow(/needs a name after it/)
  })

  test('no template means the default is chosen later, not here', () => {
    expect(parseArgs(['my-game']).template).toBeUndefined()
  })
})

describe('helpText', () => {
  test('shows the version and the defaults it would use', () => {
    const text = helpText('9.9.9')
    expect(text).toContain('create-kei-game 9.9.9')
    expect(text).toContain(DEFAULT_CURRENCY)
    expect(text).toContain('npm create kei-game')
  })
})
