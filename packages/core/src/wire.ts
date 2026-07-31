/**
 * The bytes a block hashes over.
 *
 * M0 hashed canonical JSON under a `kei-block-v0` preamble, deliberately, because
 * the byte layout belongs to the node fork and inventing one here would have
 * meant inventing it twice. The fork has since decided it: decisions-m2.md §7
 * fixes the `asset` layout and §14 puts every block type under
 * `blake2b-256("kei-block-v1")` followed by the block type. This file mirrors
 * `nano/lib/blocks.cpp`; it does not decide anything, and where the node has not
 * decided yet it says so rather than guessing (see `nodeLayoutGap`).
 *
 * Field order, widths and endianness are the node's. Everything is big-endian
 * except the two length prefixes, which are little-endian — the one departure
 * from Nano's convention that §7 calls out.
 */

import { publicKeyFromAddress } from './address.js'
import type { AssetBlockBody, AssetOp, BlockBody, StateBlockBody } from './blocks.js'
import { deriveAssetId, normalizeSymbol } from './blocks.js'
import { blake2b } from './crypto.js'
import { fail } from './errors.js'
import { bigintToBytes, concat, hexToBytes, isHex, utf8 } from './hex.js'

/** `nano::block_type`. Inherited types keep their numbers (decisions-m2.md §2). */
const BLOCK_TYPE_STATE = 6
const BLOCK_TYPE_ASSET = 7

/** `nano::asset_op`. Five operations, and the order is consensus. */
const ASSET_OP: Record<string, number> = {
  issue: 0,
  mint: 1,
  burn: 2,
  transfer: 3,
  asset_receive: 4,
}

/** `nano::transfer_policy`. */
const TRANSFER_POLICY: Record<string, number> = { open: 0, 'issuer-only': 1, none: 2 }

/** `nano::swap_policy`. */
const SWAP_POLICY: Record<string, number> = { 'two-way': 0, 'one-way': 1, off: 2 }

/** `nano::asset_kind`. Absent is `unspecified`, which is not the same as `token`. */
const ASSET_KIND: Record<string, number> = { unspecified: 0, token: 1, item: 2 }

/** Payload string bounds, enforced here so the SDK cannot sign an unparseable block. */
const MAX_NAME = 64
const MAX_SYMBOL = 20
const MAX_DESCRIPTION = 256
const MAX_IMAGE = 128
const MAX_MEMO = 128

let domain: Uint8Array | undefined

/**
 * `blake2b-256("kei-block-v1")` — `nano::kei_block_domain`.
 *
 * Every Kei block hash begins with it and no Nano or Banano block hash does, so
 * an inherited block cannot hash to a value its own signature covers.
 */
export function keiBlockDomain(): Uint8Array {
  domain ??= blake2b(utf8('kei-block-v1'), 32)
  return domain
}

/** The domain followed by the block type as a 32-byte big-endian integer. */
function preamble(blockType: number): Uint8Array {
  return concat(keiBlockDomain(), bigintToBytes(BigInt(blockType), 32))
}

/**
 * A 32-byte account. The SDK carries an address in `account` and
 * `representative` and a raw public key in `link`, so both are accepted.
 */
function accountBytes(value: string): Uint8Array {
  return isHex(value, 32) ? hexToBytes(value) : hexToBytes(publicKeyFromAddress(value))
}

/** A 32-byte hash, already hex on the wire. */
function hashBytes(value: string, label: string): Uint8Array {
  if (!isHex(value, 32)) {
    fail('bad-block', `${label} must be 64 hex characters, got "${value}".`)
  }
  return hexToBytes(value)
}

const DECIMAL = /^(0|[1-9][0-9]*)$/

/** A 16-byte big-endian amount, from the decimal string the SDK carries. */
function amountBytes(value: string, label: string): Uint8Array {
  if (!DECIMAL.test(value)) {
    fail('bad-amount', `${label} must be a decimal string of raw units, got "${value}".`)
  }
  return bigintToBytes(BigInt(value), 16)
}

function u8(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff)
}

/** Little-endian, like `payload_len` itself. */
function u16le(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >> 8) & 0xff)
}

/** A length-prefixed payload string: `uint16` little-endian, then the UTF-8 bytes. */
function payloadString(value: string, max: number, label: string): Uint8Array {
  const bytes = utf8(value)
  if (bytes.length > max) {
    fail('bad-block', `${label} is ${bytes.length} bytes, and the limit is ${max}.`)
  }
  return concat(u16le(bytes.length), bytes)
}

function enumByte(table: Record<string, number>, value: string, label: string): Uint8Array {
  const found = table[value]
  if (found === undefined) fail('bad-block', `"${value}" is not a usable ${label}.`)
  return u8(found)
}

const ZERO_32 = new Uint8Array(32)

/**
 * The flat §7 fields an `op` object maps onto.
 *
 * The node derives exactly these from the same JSON — an `issue` names no asset
 * id because the id is `H(issuer ‖ symbol)`, and a `mint` or `transfer` names a
 * recipient address where the layout carries a public key.
 */
function assetFields(
  account: string,
  op: AssetOp,
): { op: number; assetId: Uint8Array; amount: Uint8Array; link: Uint8Array; payload: Uint8Array } {
  const code = ASSET_OP[op.kind]
  if (code === undefined) {
    fail('bad-block', `"${op.kind}" has no wire layout — see nodeLayoutGap().`)
  }
  switch (op.kind) {
    case 'issue': {
      const symbol = normalizeSymbol(op.symbol)
      // An absent or null cap is uncapped, stored as zero. An explicit zero is a
      // different statement and the node refuses it, so it is refused here too.
      if (op.maxSupply !== null && BigInt(op.maxSupply) === 0n) {
        fail('bad-block', 'A maxSupply of zero is not "uncapped" — pass null for uncapped.')
      }
      return {
        op: code,
        assetId: hexToBytes(deriveAssetId(publicKeyFromAddress(account), symbol)),
        amount: new Uint8Array(16),
        link: ZERO_32,
        payload: concat(
          payloadString(op.name, MAX_NAME, 'name'),
          payloadString(symbol, MAX_SYMBOL, 'symbol'),
          u8(op.decimals),
          amountBytes(op.maxSupply ?? '0', 'maxSupply'),
          enumByte(TRANSFER_POLICY, op.transfer, 'transfer policy'),
          enumByte(SWAP_POLICY, op.swap, 'swap policy'),
          payloadString(op.metadata?.description ?? '', MAX_DESCRIPTION, 'description'),
          payloadString(op.metadata?.image ?? '', MAX_IMAGE, 'image'),
          enumByte(ASSET_KIND, op.metadata?.kind ?? 'unspecified', 'asset kind'),
        ),
      }
    }
    case 'mint':
    case 'transfer':
      return {
        op: code,
        assetId: hashBytes(op.asset, 'asset id'),
        amount: amountBytes(op.amount, 'amount'),
        link: accountBytes(op.to),
        payload: payloadString(
          op.kind === 'transfer' ? (op.memo ?? '') : '',
          MAX_MEMO,
          'memo',
        ),
      }
    case 'burn':
      return {
        op: code,
        assetId: hashBytes(op.asset, 'asset id'),
        amount: amountBytes(op.amount, 'amount'),
        link: ZERO_32,
        payload: new Uint8Array(0),
      }
    case 'asset_receive':
      // Which asset it pays is the receivable's business, not the collecting
      // block's (decisions-m2.md §10), so the id stays zero.
      return {
        op: code,
        assetId: ZERO_32,
        amount: new Uint8Array(16),
        link: hashBytes(op.link, 'source block hash'),
        payload: new Uint8Array(0),
      }
    default:
      fail('bad-block', `"${(op as AssetOp).kind}" has no wire layout.`)
  }
}

function stateBytes(body: StateBlockBody): Uint8Array {
  return concat(
    preamble(BLOCK_TYPE_STATE),
    accountBytes(body.account),
    hashBytes(body.previous, 'previous'),
    accountBytes(body.representative),
    amountBytes(body.balance, 'balance'),
    // A public key on a send, a source block hash on a receive, zeros otherwise
    // — 32 bytes either way, and the node reads it as a `link` union too.
    accountBytes(body.link),
  )
}

function assetBytes(body: AssetBlockBody): Uint8Array {
  const fields = assetFields(body.account, body.op)
  return concat(
    preamble(BLOCK_TYPE_ASSET),
    accountBytes(body.account),
    hashBytes(body.previous, 'previous'),
    accountBytes(body.representative),
    amountBytes(body.balance, 'balance'),
    u8(fields.op),
    fields.assetId,
    fields.amount,
    fields.link,
    // The length is hashed alongside the bytes, so the hash covers exactly what
    // the wire carries.
    u16le(fields.payload.length),
    fields.payload,
  )
}

/**
 * Why this block has no §7 wire layout, or `null` if it has one.
 *
 * Two cases, and neither is something the SDK may decide on its own:
 *
 * - `commit`, `commit_close` and `claim` are SPEC §5.6.4 operations that land
 *   with M4 and M5, and are deliberately not members of `nano::asset_op` yet.
 * - A memo on a `state` block. decisions-m2.md §8 puts memos on the asset-family
 *   block and leaves inherited `state` blocks untouched, so the §14 layout has
 *   nowhere to put one. Covering it anyway would fork the hash; leaving it out
 *   of a consensus hash would leave the field unsigned and forgeable, which is
 *   worse than either.
 */
export function nodeLayoutGap(body: BlockBody): string | null {
  if (body.type === 'state') {
    return body.memo === undefined
      ? null
      : 'a memo on a state block — decisions-m2.md §8 carries memos on the asset block, and the §14 layout has no field for this one'
  }
  return ASSET_OP[body.op.kind] === undefined
    ? `the ${body.op.kind} operation — SPEC §5.6.4, which lands with M4/M5 and is not in nano::asset_op yet`
    : null
}

/**
 * The exact bytes the node hashes for this block.
 *
 * Throws when `nodeLayoutGap` is non-null: there is no answer to give, and a
 * plausible one would be worse than none.
 */
export function blockPreimage(body: BlockBody): Uint8Array {
  const gap = nodeLayoutGap(body)
  if (gap !== null) {
    fail('bad-block', `This block has no consensus wire layout: ${gap}.`)
  }
  return body.type === 'state' ? stateBytes(body) : assetBytes(body)
}
