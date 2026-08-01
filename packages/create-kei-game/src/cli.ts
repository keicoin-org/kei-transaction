/**
 * The command line, parsed.
 *
 * Two questions get asked (SPEC §11.3), and both can be answered up front
 * instead. That is not a convenience: SPEC §12 expects most integrations to be
 * driven by an agent, and an agent cannot answer a prompt. Anything that can be
 * typed at a prompt can be passed as a flag, and `--yes` accepts the defaults
 * for the rest, so the whole harness runs unattended.
 */

import { fail } from './errors.js'

export interface CliOptions {
  /** The project name, given as the first positional argument. */
  name?: string
  currency?: string
  /** Take the defaults for whatever was not given, and ask nothing. */
  yes: boolean
  /** Write into a directory that already has files in it. */
  force: boolean
  help: boolean
  version: boolean
}

/** Used only under `--yes`, or when a prompt is answered with an empty line. */
export const DEFAULT_NAME = 'kei-game'
export const DEFAULT_CURRENCY = 'Coins'

const FLAGS = ['--currency', '--yes', '-y', '--force', '--help', '-h', '--version', '-v']

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { yes: false, force: false, help: false, version: false }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!

    switch (arg) {
      case '--help':
      case '-h':
        options.help = true
        break
      case '--version':
      case '-v':
        options.version = true
        break
      case '--yes':
      case '-y':
        options.yes = true
        break
      case '--force':
        options.force = true
        break
      case '--currency': {
        const value = argv[++index]
        if (value === undefined || value.startsWith('-')) {
          fail('--currency needs a name after it, for example: --currency "Gems".')
        }
        options.currency = value
        break
      }
      default: {
        // `--currency=Gems` is the other spelling of the same thing, and a
        // developer who types it should not be told it is not a flag.
        if (arg.startsWith('--currency=')) {
          options.currency = arg.slice('--currency='.length)
          break
        }
        if (arg.startsWith('-')) {
          fail(`"${arg}" is not an option this understands. It takes: ${FLAGS.join(', ')}.`)
        }
        if (options.name !== undefined) {
          fail(
            `Two project names were given ("${options.name}" and "${arg}"), and there can only be one. Quote it if the name has a space in it.`,
          )
        }
        options.name = arg
      }
    }
  }

  return options
}

export function helpText(version: string): string {
  return `
  create-kei-game ${version}

  Scaffolds a browser game with a real currency, a real item, and a wallet the
  player owns. It writes files and exits: nothing it generates depends on it.

  Usage

    npm create kei-game
    npm create kei-game <project> -- --currency <name>
    bun create kei-game <project> --currency <name>

  Options

    --currency <name>   What the in-game currency is called. Default: ${DEFAULT_CURRENCY}
    --yes, -y           Take the defaults and ask nothing. For CI and agents.
    --force             Write into a directory that already has files in it.
    --help, -h          This.
    --version, -v       Print the version and exit.

  It asks two things and derives the rest, including the ticker the chain knows
  your currency by. Everything it writes is yours to edit.

  https://keicoin.org
`
}
