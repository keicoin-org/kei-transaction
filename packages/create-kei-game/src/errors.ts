/**
 * One error class, so the CLI can tell "you typed something I cannot use" apart
 * from "this scaffolder has a bug".
 *
 * The first prints as a sentence and exits 1. The second prints a stack, because
 * a stack is what is useful when the fault is here rather than in the answer.
 * SPEC §6.1: the message states its own fix, and it is the only thing shown.
 */
export class HarnessError extends Error {
  override readonly name = 'HarnessError'
}

export function fail(message: string): never {
  throw new HarnessError(message)
}
