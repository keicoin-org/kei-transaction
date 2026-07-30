/**
 * SPEC §6.3, and acceptance criterion 6: an issuer seed shipped to the client is
 * a total compromise of the game's economy — anyone can mint infinite currency.
 * So `Kei.server()` detects a browser, refuses to run, and says why.
 */

import { fail } from '@kei/core'

export function looksLikeBrowser(): boolean {
  const scope = globalThis as {
    window?: unknown
    document?: unknown
    self?: unknown
    importScripts?: unknown
    process?: { versions?: Record<string, string> }
  }
  if (scope.window !== undefined && scope.document !== undefined) return true
  // Web workers have no document but are just as much the client.
  if (typeof scope.importScripts === 'function' && scope.self !== undefined) return true
  return false
}

export function isServerRuntime(): boolean {
  const versions = (globalThis as { process?: { versions?: Record<string, string> } }).process?.versions
  return Boolean(versions?.node ?? versions?.bun)
}

export function assertServerOnly(): void {
  if (looksLikeBrowser() || !isServerRuntime()) {
    fail(
      'issuer-in-browser',
      'Kei.server() is refusing to run: it holds your game\'s issuer seed, and this looks like a browser. Anyone who reads that seed can mint your currency without limit. Run Kei.server() on your server (Node or Bun) and use Kei.start() in the game.',
    )
  }
}
