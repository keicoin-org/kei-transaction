/**
 * The work server's listener — `@keicoin/work/server`, and server-only.
 *
 * This is the one file in the package that imports `node:http`, and it is behind
 * its own export for that reason: `kei-transaction` re-exports the work client
 * from the package root, a game bundles `kei-transaction` for the browser, and
 * `node:http` has no browser polyfill for `createServer`. Importing this from a
 * browser bundle is meant to fail — that is the boundary, not an accident.
 *
 * The endpoint itself is `workRpcHandler` in the package root, which is a plain
 * `Request → Response` function and runs anywhere. Everything below is the
 * adapter that makes it listen on a TCP port.
 */

import type { KeiNode } from '@keicoin/core'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { LocalWorkProvider, MAX_WORK_REQUEST_BYTES, workRpcHandler } from './index.js'

export interface WorkHttpServerOptions {
  host?: string
  port?: number
  /** Optional bearer token. Omit for a private/local network. */
  token?: string
}

export interface RunningWorkServer {
  url: string
  close(): Promise<void>
}

const JSON_HEADERS = { 'content-type': 'application/json' }

/** Runs the production-compatible `work_generate` HTTP endpoint. */
export async function startWorkServer(
  node: KeiNode,
  options: WorkHttpServerOptions = {},
): Promise<RunningWorkServer> {
  const handle = workRpcHandler({
    provider: new LocalWorkProvider(node),
    ...(options.token ? { token: options.token } : {}),
  })
  const host = options.host ?? '127.0.0.1'

  const server: Server = createServer((request, response) => {
    const chunks: Uint8Array[] = []
    let size = 0
    let rejected = false

    // The handler checks the size too, but only once the body is in memory. A
    // listener on a public port has to stop reading, not measure afterwards.
    request.on('data', (chunk: Uint8Array) => {
      if (rejected) return
      size += chunk.byteLength
      if (size > MAX_WORK_REQUEST_BYTES) {
        rejected = true
        response.writeHead(413, JSON_HEADERS)
        response.end(JSON.stringify({ error: 'request body is too large' }))
        return
      }
      chunks.push(chunk)
    })

    request.on('end', () => {
      if (rejected) return
      void (async () => {
        try {
          const answer = await handle(toRequest(request, Buffer.concat(chunks)))
          const headers: Record<string, string> = {}
          answer.headers.forEach((value, name) => {
            headers[name] = value
          })
          response.writeHead(answer.status, headers)
          response.end(Buffer.from(await answer.arrayBuffer()))
        } catch (error) {
          response.writeHead(500, JSON_HEADERS)
          response.end(JSON.stringify({ error: String((error as Error)?.message ?? error) }))
        }
      })()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('work server did not bind a TCP port')
  return {
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

function toRequest(message: IncomingMessage, body: Buffer): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(message.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item)
  }
  const method = message.method ?? 'GET'
  const url = new URL(message.url ?? '/', `http://${message.headers.host ?? 'work.invalid'}`)
  // GET and HEAD may not carry one, and the handler answers them 405 unread.
  const carriesBody = method !== 'GET' && method !== 'HEAD'
  return new Request(url.href, { method, headers, ...(carriesBody ? { body } : {}) })
}
