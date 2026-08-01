/**
 * SPEC §6.3, and acceptance criterion 6: an issuer seed shipped to the client is
 * a total compromise of the game's economy — anyone can mint infinite currency.
 * So `Kei.server()` detects a browser, refuses to run, and says why.
 */

import { fail } from '@keicoin/core'

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

/**
 * Variables a host sets by itself when it is running a deployment rather than a
 * laptop. `NODE_ENV` is the one a developer sets on purpose and is checked
 * first; the rest matter precisely because nobody sets them on purpose — a game
 * reaches its first real player through a platform that was never told this is
 * production.
 */
const DEPLOYMENT_MARKERS = [
  'FLY_APP_NAME',
  'RAILWAY_ENVIRONMENT',
  'RENDER',
  'VERCEL',
  'DYNO',
  'K_SERVICE',
  'KUBERNETES_SERVICE_HOST',
  'WEBSITE_INSTANCE_ID',
] as const

/**
 * The name of the thing that says this process is deployed, or `undefined` on a
 * developer's machine. It returns the name rather than a boolean so the message
 * can say what tripped it — a guard that fires for reasons it will not disclose
 * gets disabled instead of read.
 */
export function deploymentSignal(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  if (!env) return undefined
  if (env.NODE_ENV === 'production') return 'NODE_ENV=production'
  return DEPLOYMENT_MARKERS.find((marker) => Boolean(env[marker]))
}

/** The escape hatch, read where a deploy is configured rather than in a commit. */
export function testnetAllowedInDeployment(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  const value = env?.KEI_ALLOW_TESTNET
  return value === '1' || value === 'true'
}

export function assertServerOnly(): void {
  if (looksLikeBrowser() || !isServerRuntime()) {
    fail(
      'issuer-in-browser',
      'Kei.server() is refusing to run: it holds your game\'s issuer seed, and this looks like a browser. Anyone who reads that seed can mint your currency without limit. Run Kei.server() on your server (Node or Bun) and use Kei.start() in the game.',
    )
  }
}
