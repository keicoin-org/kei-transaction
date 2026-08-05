/**
 * Turning a URL the caller configured into a URL an error may repeat.
 *
 * Both transports in this SDK point at a URL a developer typed — a node and a
 * work server — and both are somewhere people keep credentials. The rule is the
 * same for either, so it lives here rather than in one of them (SPEC §6.6: a
 * secret never reaches a log, an error, or a stack trace).
 */

/**
 * A run long and opaque enough to be a key rather than a name. Deliberately
 * eager: redacting a long path segment costs a reader some context, printing an
 * API key costs them the key.
 */
const OPAQUE_RUN = /[A-Za-z0-9_-]{20,}/g

/**
 * Userinfo: everything up to an `@` that still precedes the first path segment.
 *
 * The kept prefix is only what is unambiguously *not* userinfo — a `scheme://`,
 * or the `//` of a scheme-relative URL. `operator:hunter2@node/rpc` is left to
 * match whole, because `operator:` there reads as a scheme and is a username.
 */
const CREDENTIALS = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/|\/\/)?[^/?#]*@/

const redactOpaque = (text: string): string => text.replace(OPAQUE_RUN, '[redacted]')

/**
 * The URL as it can safely appear in an error message.
 *
 * A node or work-server URL is somewhere people keep credentials —
 * `https://user:pass@node/`, an API key in the query string, a project token as
 * a path segment — and error messages get pasted into issues, logs and chat.
 * What survives is the part that answers "which server went quiet": scheme,
 * host, path. Userinfo, query and fragment do not, because none of them are
 * needed to answer that.
 */
export function safeEndpoint(url: string): string {
  try {
    const parsed = new URL(url)
    // A hostname is public by definition, so it is kept whole; a path segment
    // can be a project token, so a long opaque one is not.
    if (parsed.host !== '') {
      return `${parsed.protocol}//${parsed.host}${redactOpaque(parsed.pathname)}`
    }
    // Host-less: `weird:user:pass@node/rpc` parses, but everything after the
    // scheme is one opaque path and the userinfo is sitting inside it.
  } catch {
    // Not a URL the platform can parse at all.
  }
  // Neither case can be taken apart by structure, so the text is cut back
  // instead: no query, no fragment, no userinfo, nothing long enough to be a
  // key. An endpoint this shaped fails at `fetch` anyway, so being unhelpfully
  // conservative about it costs a reader nothing they had.
  const head = (url.split(/[?#]/)[0] ?? '').replace(CREDENTIALS, '$1')
  return redactOpaque(head.slice(0, 200))
}
