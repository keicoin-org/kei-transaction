/**
 * The two questions.
 *
 * Deliberately not a dependency: a scaffolder that pulls in a prompt library, a
 * colour library, and a spinner is three supply-chain risks for a program that
 * runs once and writes ten files. `readline` is in the runtime already.
 *
 * If nothing is attached to the input — CI, a pipe, an agent — asking is not
 * possible, so it says so and names the flags that would have answered it.
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import { fail } from './errors.js'

export interface Asker {
  ask(question: string, fallback: string): Promise<string>
  close(): void
}

export function createAsker(): Asker {
  if (!stdin.isTTY) {
    fail(
      'There is nothing to type into here, so the two questions cannot be asked. Pass the answers instead: create-kei-game <project> --currency "Gems", or --yes to take the defaults.',
    )
  }

  const readline = createInterface({ input: stdin, output: stdout })
  return {
    async ask(question, fallback) {
      const answer = (await readline.question(`  ${question} (${fallback}) `)).trim()
      return answer === '' ? fallback : answer
    },
    close() {
      readline.close()
    },
  }
}
