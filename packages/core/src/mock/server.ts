/**
 * The mock node, over HTTP.
 *
 * `MockNode` is in-process, which is enough for a test and not enough for a
 * game: SPEC §6.3 forbids the issuer seed from reaching a browser, so the player
 * and the issuer are always two processes, and two processes cannot share an
 * object. They can share a URL.
 *
 * This is the smallest thing that makes that true — a plain `Request → Response`
 * handler speaking docs/rpc.md, which is also the first time that document gets
 * executed rather than described. It is deliberately not a server: no `Bun.serve`,
 * no `node:http`, no listener, so `@keicoin/core` stays runtime-agnostic and the
 * caller decides what listens. `button/server/main.ts` is nine lines because of
 * this.
 *
 * It is a development tool and says so — the real node is M2, and nothing here
 * validates anything `MockLedger` does not already validate.
 */

import type { Block } from '../blocks.js'
import { KeiError } from '../errors.js'
import type { KeiNode, SwapState } from '../node.js'

export interface MockRpcOptions {
  node: KeiNode
  /**
   * Answer browser requests from any origin. A mock node exists to be reached
   * from a game running on some other dev port, so this defaults on; a real node
   * would not.
   */
  cors?: boolean
}

interface RpcRequest extends Record<string, unknown> {
  action?: unknown
}

/**
 * One handler, every action in docs/rpc.md. Pass it to `Bun.serve({ fetch })`,
 * to a `node:http` adapter, or straight to `HttpNode`'s `fetch` option in a test.
 */
export function mockRpcHandler(options: MockRpcOptions): (request: Request) => Promise<Response> {
  const { node } = options
  const cors = options.cors !== false
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(cors
      ? {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'content-type',
          'access-control-allow-methods': 'POST, OPTIONS',
        }
      : {}),
  }

  const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers })
  // Errors ride at HTTP 200 with an `error` field, which is what Nano and Banano
  // do and therefore what ported tooling expects (SPEC §5.6.8).
  const bad = (message: string): Response => ok({ error: message })

  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') {
      return bad('A Kei node takes one POST per call, with a JSON body like { "action": "account_info", ... }.')
    }

    let body: RpcRequest
    try {
      body = (await request.json()) as RpcRequest
    } catch {
      return bad('The request body was not JSON.')
    }
    if (!body || typeof body !== 'object' || typeof body.action !== 'string') {
      return bad('Every call needs an "action" — see docs/rpc.md for the list.')
    }

    try {
      return ok(await dispatch(node, body.action, body))
    } catch (error) {
      // The ledger's rejections are the interesting ones — a double claim, a
      // fork, a transfer a policy forbids — and every one of them is a sentence
      // already, so it goes over the wire unchanged.
      return bad(error instanceof KeiError ? error.message : String((error as Error)?.message ?? error))
    }
  }
}

async function dispatch(node: KeiNode, action: string, body: RpcRequest): Promise<unknown> {
  switch (action) {
    case 'account_info':
      return { account: await node.accountInfo(text(body.account, 'account')) }

    // A real Kei node serves two shapes here and picks by `shape`, because it
    // inherited Nano's answer under this name. This node has only the
    // contract's shape and could serve it unasked — but then a client that
    // forgot the parameter would pass against the mock and read Nano's history
    // entries as blocks against kei-node, which is the failure the parameter
    // exists to prevent. So the reference implementation holds callers to it.
    case 'account_history': {
      if (body.shape !== 'block') {
        throw new KeiError(
          'bad-request',
          'account_history needs "shape": "block". Without it a Kei node answers in the shape it inherited from Nano — history entries, not blocks. See docs/rpc.md.',
        )
      }
      return {
        history: await node.accountHistory(text(body.account, 'account'), { limit: count(body.count, 100) }),
      }
    }

    case 'block_info':
      return { block: await node.blockInfo(text(body.hash, 'hash')) }

    case 'accounts_receivable':
      return { receivables: await node.receivables(text(body.account, 'account')) }

    case 'process': {
      const block = body.block
      if (!block || typeof block !== 'object') {
        throw new KeiError('bad-request', 'process needs a signed block: { "action": "process", "block": { ... } }.')
      }
      return node.process(block as Block)
    }

    case 'work_thresholds':
      return { thresholds: await node.workThresholds() }

    case 'asset_info':
      return { asset: await node.assetInfo(text(body.asset, 'asset')) }

    case 'asset_by_symbol':
      return { asset: await node.assetBySymbol(text(body.issuer, 'issuer'), text(body.symbol, 'symbol')) }

    case 'account_holdings':
      return { holdings: await node.holdings(text(body.account, 'account')) }

    case 'asset_balance':
      return { balance: await node.holderBalance(text(body.asset, 'asset'), text(body.account, 'account')) }

    case 'asset_holders':
      return { holders: await node.holders(text(body.asset, 'asset'), { limit: count(body.count, 100) }) }

    case 'commit_info':
      return { commit: await node.commitInfo(text(body.root, 'root')) }

    case 'claim_status':
      return { claimed: await node.hasClaimed(text(body.account, 'account'), text(body.root, 'root')) }

    case 'swap_info':
      return { offer: await node.swapOffer(text(body.hash, 'hash')) }

    case 'account_swaps':
      return {
        offers: await node.accountSwaps(text(body.account, 'account'), {
          limit: count(body.count, 100),
          ...(body.state === undefined ? {} : { state: swapState(body.state) }),
        }),
      }

    case 'faucet':
      return node.faucet(
        text(body.account, 'account'),
        body.amount === undefined ? undefined : text(body.amount, 'amount'),
      )

    default:
      throw new KeiError('no-such-action', `This node has no "${action}" action. See docs/rpc.md for the list.`)
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new KeiError('bad-request', `This call needs a "${field}".`)
  }
  return value
}

function swapState(value: unknown): SwapState {
  if (value === 'open' || value === 'accepted' || value === 'cancelled') return value
  throw new KeiError(
    'bad-request',
    `"state" is one of open, accepted or cancelled — got "${String(value)}". Leave it out for all three.`,
  )
}

function count(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}
