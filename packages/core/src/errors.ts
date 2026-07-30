/**
 * Errors are sentences that state their own fix (SPEC §6.1), and no error ever
 * carries a seed (SPEC §6.6, acceptance criterion 8).
 *
 * The scrubbing here is a backstop, not the primary defence. The primary
 * defence is that nothing in this SDK interpolates a seed into a string. The
 * backstop exists because that promise is only as good as the next person to
 * write an error message.
 */

const secrets = new Set<string>()

/** Register a value that must never appear in an error, event, or log line. */
export function registerSecret(secret: string): void {
  if (typeof secret === 'string' && secret.length >= 16) {
    secrets.add(secret)
    secrets.add(secret.toUpperCase())
    secrets.add(secret.toLowerCase())
  }
}

/** Replace every registered secret in `text` with a marker. */
export function scrub(text: string): string {
  let out = text
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join('[redacted]')
  }
  return out
}

/** True if `text` contains a registered secret. Used by the test suite. */
export function containsSecret(text: string): boolean {
  for (const secret of secrets) {
    if (text.includes(secret)) return true
  }
  return false
}

export class KeiError extends Error {
  /** Stable machine-readable tag. The message is what a human or agent reads. */
  readonly code: string

  constructor(code: string, message: string) {
    super(scrub(message))
    this.name = 'KeiError'
    this.code = code
  }
}

export function fail(code: string, message: string): never {
  throw new KeiError(code, message)
}
