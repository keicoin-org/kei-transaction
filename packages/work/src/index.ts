/**
 * Obtaining proof-of-work.
 *
 * SPEC §5.5 and §16: client-side PoW is a visible pause mid-game, so a work
 * server is required v1 infrastructure rather than a later optimisation. This
 * package is the client side of that: a local generator for development, a work
 * server client for production, and precompute so the next block's work is
 * already in hand before the player asks for it.
 *
 * Everything here runs in a browser, because `kei-transaction` re-exports it and
 * a game bundles that. The listener that serves `workRpcHandler` needs
 * `node:http`, which has no browser polyfill, so it lives one import away in
 * `@keicoin/work/server`.
 */

import type { KeiNode, WorkProvider, WorkTier } from '@keicoin/core'
import { KeiError, fail, generateWork, safeEndpoint } from '@keicoin/core'

export interface LocalWorkOptions {
  /** Overrides the node's advertised thresholds. Mostly for tests. */
  thresholds?: Record<WorkTier, string>
}

/** Generates work in this process. Fine for the mock and for a server; visible on a phone. */
export class LocalWorkProvider implements WorkProvider {
  private readonly node: KeiNode
  private readonly override: Record<WorkTier, string> | undefined
  private thresholds: Record<WorkTier, string> | undefined
  private readonly ready = new Map<string, { tier: WorkTier; nonce: string }>()

  constructor(node: KeiNode, options: LocalWorkOptions = {}) {
    this.node = node
    this.override = options.thresholds
  }

  async generate(root: string, tier: WorkTier): Promise<string> {
    const precomputed = this.ready.get(root)
    if (precomputed && precomputed.tier === tier) {
      this.ready.delete(root)
      return precomputed.nonce
    }
    return generateWork(root, await this.thresholdFor(tier))
  }

  /** Fire-and-forget: have work for `root` waiting before it is asked for. */
  precompute(root: string, tier: WorkTier): void {
    if (this.ready.has(root)) return
    void this.thresholdFor(tier)
      .then((threshold) => {
        this.ready.set(root, { tier, nonce: generateWork(root, threshold) })
        // One root ahead is the whole point; more is a memory leak.
        if (this.ready.size > 8) {
          const oldest = this.ready.keys().next().value
          if (oldest !== undefined) this.ready.delete(oldest)
        }
      })
      .catch(() => undefined)
  }

  private async thresholdFor(tier: WorkTier): Promise<bigint> {
    if (this.override) return BigInt(this.override[tier])
    this.thresholds ??= await this.node.workThresholds()
    return BigInt(this.thresholds[tier])
  }
}

export interface WorkServerOptions {
  url: string
  /** Sent with every request. Where a token belongs: `{ authorization: `Bearer ${token}` }`. */
  headers?: Record<string, string>
  fetch?: typeof globalThis.fetch
  /** Used when the server is unreachable. Pass a LocalWorkProvider to degrade instead of fail. */
  fallback?: WorkProvider
}

const MAX_PRECOMPUTED_WORK = 8

function workCacheKey(root: string, tier: WorkTier): string {
  return `${root.toUpperCase()}:${tier}`
}

/**
 * Asks a work server for precomputed work, which is what the Nano and Banano
 * ecosystems already do and what keeps a claim from stalling a frame.
 */
export class WorkServerProvider implements WorkProvider {
  private readonly url: string
  /** `url` with everything an error must not repeat taken out of it. */
  private readonly endpoint: string
  private readonly headers: Record<string, string>
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly fallback: WorkProvider | undefined
  private readonly precomputed = new Map<string, Promise<string>>()

  constructor(options: WorkServerOptions) {
    if (!options?.url) fail('no-work-server', 'A work server needs a URL, for example https://work.kei.dev.')
    this.url = options.url
    this.endpoint = safeEndpoint(options.url)
    this.headers = { 'content-type': 'application/json', ...options.headers }
    const impl = options.fetch ?? globalThis.fetch
    if (typeof impl !== 'function') {
      fail('no-fetch', 'No fetch available. Pass one to WorkServerProvider, or use Node 18+, Bun, or a browser.')
    }
    this.fetchImpl = impl
    this.fallback = options.fallback
  }

  async generate(root: string, tier: WorkTier): Promise<string> {
    const key = workCacheKey(root, tier)
    const ready = this.precomputed.get(key)
    if (ready) {
      // Work is single-use. Delete before awaiting so a later request cannot
      // consume the same speculative nonce while this caller is suspended.
      this.precomputed.delete(key)
      return ready
    }

    return this.requestWork(root, tier)
  }

  precompute(root: string, tier: WorkTier): void {
    const key = workCacheKey(root, tier)
    if (this.precomputed.has(key)) return

    // Install the promise before starting fetch. Besides making duplicate
    // calls coalesce, this keeps the cache authoritative even for a custom
    // fetch implementation that synchronously calls back into the provider.
    let resolveWork!: (work: string) => void
    let rejectWork!: (cause: unknown) => void
    const pending = new Promise<string>((resolve, reject) => {
      resolveWork = resolve
      rejectWork = reject
    })
    this.precomputed.set(key, pending)

    // A failed speculative request must not poison the key, and precompute's
    // fire-and-forget API must never surface an unhandled rejection.
    void pending.catch(() => {
      if (this.precomputed.get(key) === pending) this.precomputed.delete(key)
    })

    if (this.precomputed.size > MAX_PRECOMPUTED_WORK) {
      const oldest = this.precomputed.keys().next().value
      if (oldest !== undefined) this.precomputed.delete(oldest)
    }

    void this.requestWork(root, tier).then(resolveWork, rejectWork)
  }

  private async requestWork(root: string, tier: WorkTier): Promise<string> {
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ action: 'work_generate', hash: root, tier }),
      })
      if (!response.ok) throw new Error(String(response.status))
      const body = (await response.json()) as { work?: string; error?: string }
      if (typeof body.work !== 'string') throw new Error(body.error ?? 'no work in response')
      return body.work
    } catch (cause) {
      if (this.fallback) return this.fallback.generate(root, tier)
      throw new KeiError(
        'work-server-unreachable',
        `The work server at ${this.endpoint} did not return work. Pass { fallback: new LocalWorkProvider(node) } to generate locally instead.`,
      )
    }
  }
}

export interface WorkOptions {
  /** A work server URL. Without one, work is generated locally. */
  workServer?: string
  /**
   * Sent with every work-server request. A work server that wants a token wants
   * it here — `{ authorization: `Bearer ${token}` }` — and not in `workServer`,
   * because a URL is what an error message names and a header is not.
   */
  headers?: Record<string, string>
  thresholds?: Record<WorkTier, string>
  fetch?: typeof globalThis.fetch
}

/** What `Kei.start()` uses: a work server when configured, local generation otherwise. */
export function createWorkProvider(node: KeiNode, options: WorkOptions = {}): WorkProvider {
  const local = new LocalWorkProvider(node, options.thresholds ? { thresholds: options.thresholds } : {})
  if (!options.workServer) return local
  return new WorkServerProvider({
    url: options.workServer,
    fallback: local,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
}

/**
 * A `work_generate` request is one action, a 64-character hash and a tier. Ten
 * times that is already something other than a client, so it stops being read.
 */
export const MAX_WORK_REQUEST_BYTES = 8_192

/**
 * Compares in time that does not depend on where the first difference is. A
 * work server is a public endpoint by design, so a `!==` on the token hands a
 * patient caller the prefix one character at a time.
 */
function tokenMatches(expected: string, presented: string | null): boolean {
  const given = presented ?? ''
  let difference = given.length ^ expected.length
  for (let i = 0; i < given.length; i++) {
    difference |= given.charCodeAt(i) ^ expected.charCodeAt(i % expected.length)
  }
  return difference === 0
}

export interface WorkRpcOptions {
  /** Where the work comes from. `startWorkServer` passes a `LocalWorkProvider`. */
  provider: WorkProvider
  /** Optional bearer token. Omit for a private/local network. */
  token?: string
}

/**
 * The `work_generate` endpoint, as a plain `Request → Response` handler.
 *
 * Deliberately not a server, for the same reason `mockRpcHandler` is not one:
 * the moment this file listens it needs `node:http`, and `@keicoin/work` is
 * reachable from a game's browser bundle. Pass it to `Bun.serve({ fetch })`, to
 * a Cloudflare Worker, or to `startWorkServer` in `@keicoin/work/server`, which
 * is the `node:http` adapter.
 */
export function workRpcHandler(options: WorkRpcOptions): (request: Request) => Promise<Response> {
  const { provider, token } = options
  const headers = { 'content-type': 'application/json' }
  const send = (status: number, body: object): Response =>
    new Response(JSON.stringify(body), { status, headers })

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return send(405, { error: 'POST required' })
    if (token && !tokenMatches(`Bearer ${token}`, request.headers.get('authorization'))) {
      return send(401, { error: 'unauthorized' })
    }

    let body: { action?: string; hash?: string; tier?: WorkTier }
    try {
      const raw = await request.arrayBuffer()
      if (raw.byteLength > MAX_WORK_REQUEST_BYTES) return send(413, { error: 'request body is too large' })
      body = JSON.parse(new TextDecoder().decode(raw))
    } catch {
      return send(400, { error: 'invalid JSON' })
    }

    if (body.action !== 'work_generate') return send(400, { error: 'unknown action' })
    if (!/^[0-9a-fA-F]{64}$/.test(body.hash ?? '')) return send(400, { error: 'hash must be 64 hex characters' })
    if (body.tier !== 'A' && body.tier !== 'B' && body.tier !== 'C') {
      return send(400, { error: 'tier must be A, B, or C' })
    }

    try {
      return send(200, { work: await provider.generate(body.hash!, body.tier) })
    } catch (error) {
      // The request was fine; this server could not answer it — usually because
      // the node it asks for thresholds is down. Saying 400 here would send the
      // caller looking at their own request.
      return send(503, { error: `could not generate work: ${(error as Error)?.message ?? String(error)}` })
    }
  }
}
