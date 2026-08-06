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

/**
 * The safe way to include arbitrary text in something you are about to emit —
 * a log line, an event, a crash report. Replaces every registered secret in
 * `text` with a marker before you send it anywhere.
 *
 * Covers what `registerSecret` was told about: a seed or private key an
 * `@keicoin/core` client derived, in every case it stores. It is a backstop
 * (see the module comment above), not a general-purpose secret scanner — it
 * does not protect a secret your own code invented and never registered.
 */
export function scrub(text: string): string {
  let out = text
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join('[redacted]')
  }
  return out
}

/**
 * A last-line check before an integration writes `text` to a transport, a
 * log, or a crash reporter: true if it contains a value this process
 * registered as secret. Covers the seed and its derived private key, in
 * every case, for every client this process has opened — the same registry
 * `scrub` reads from, so the two stay in agreement.
 *
 * A backstop, not a general-purpose secret scanner (see the module comment
 * above): it only catches a value `registerSecret` was told about.
 */
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
