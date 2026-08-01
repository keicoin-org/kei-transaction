/**
 * Two answers in, four names out.
 *
 * SPEC §11.3 allows the harness exactly two questions — project name and
 * currency name — so everything else is derived. Every extra question is a
 * decision the developer has to make before they have any information with
 * which to make it, and the derivations here are deliberately dull: a developer
 * who dislikes one edits one line of a project they own.
 *
 * The derived name that actually matters is the ticker, because the chain
 * enforces its shape. It is shown before anything is written, so nobody
 * discovers what their currency is called by reading the generated source.
 */

import { fail } from './errors.js'

/**
 * Mirrors `normalizeSymbol` in `@keicoin/core`, which is where this rule is
 * enforced — the node rejects anything else at issue time. It is copied rather
 * than imported so that `npm create kei-game` installs nothing but itself;
 * `test/naming.test.ts` checks the copy against the original.
 */
const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,19}$/

/** npm's limit. Nobody will reach it, and a name that does is a typo. */
const MAX_SLUG_LENGTH = 214

/** Long enough to be a ticker, short enough to fit on a screen in the world. */
const MAX_DERIVED_SYMBOL = 5

export interface GameProject {
  /** As typed: the title on the page and the heading in the README. */
  title: string
  /** Directory name and `package.json` name. */
  slug: string
  /** As typed: what the currency is called in the wallet. */
  currency: string
  /** Derived from `currency`, and what the chain knows it as. */
  symbol: string
}

/**
 * `"Star Clicker"` → `"star-clicker"`. Also the directory it is written to, so
 * a developer who types a title gets a directory they would have chosen anyway.
 */
export function slugFor(projectName: string): string {
  const slug = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (slug === '') {
    fail(
      `"${projectName}" has no letters or digits in it, so there is no directory name in it either. Try something like "star-clicker".`,
    )
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    fail(`"${projectName}" is longer than npm allows for a package name (${MAX_SLUG_LENGTH} characters). Shorten it.`)
  }
  return slug
}

/**
 * `"Gems"` → `"GEMS"`, `"Gold Pieces"` → `"GOLD"`.
 *
 * The first word only. Running the words together produces tickers nobody would
 * pick ("GOLDP"), and initials produce tickers nobody recognises ("GP").
 */
export function symbolFor(currencyName: string): string {
  const [firstWord = ''] = currencyName.trim().split(/\s+/)
  const symbol = firstWord.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, MAX_DERIVED_SYMBOL).replace(/-+$/, '')

  if (!SYMBOL_PATTERN.test(symbol)) {
    fail(
      `A currency called "${currencyName}" gives the ticker "${symbol}", which the chain will not accept. Tickers are 1-20 characters of A-Z, 0-9 or "-", starting with a letter or digit — so name the currency something starting with a letter, like "Gems".`,
    )
  }
  return symbol
}

/** The two answers, checked and completed. Nothing is written before this passes. */
export function projectFrom(answers: { name: string; currency: string }): GameProject {
  const title = answers.name.trim()
  const currency = answers.currency.trim()

  if (title === '') fail('The project needs a name — it becomes the directory this is written to. Try "star-clicker".')
  if (currency === '') fail('The currency needs a name — it is what players will see in their wallet. Try "Gems".')

  return { title, slug: slugFor(title), currency, symbol: symbolFor(currency) }
}
