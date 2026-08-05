/**
 * Whether a root has room to be honoured.
 *
 * A claim mints, and minting past `maxSupply` is an invalid block (SPEC §5.6.6),
 * so an over-committed batch does not fail where it was written — it fails one
 * player at a time, whichever thousand of them happen to press claim last, and
 * there is no way to tell them apart afterwards. Better to refuse the whole
 * batch while it is still a number in a variable.
 *
 * Advisory, and it cannot be anything else. `circulating` counts units that
 * exist, and an entitlement nobody has claimed yet is not one; there is no call
 * that lists an asset's open roots, because that is an indexer and SPEC §9.4
 * says Kei does not provide one. So this refuses a batch that is over supply on
 * its own, and the node stays the only authority on whether a batch that fits
 * here still fits by the time the claims arrive.
 */

import { fail, formatRaw } from '@keicoin/core'

export interface CommitHeadroomOptions {
  /** Names the batch being refused — `This batch of "boss"`. */
  batch: string
  /** What to call the asset: a symbol for a currency, a name for an item. */
  asset: string
  decimals: number
  /** Raw, or null for an uncapped asset, which always has room. */
  maxSupplyRaw: bigint | null
  /** Raw units already in existence. */
  circulatingRaw: bigint
  /** Raw total this batch would promise. */
  committed: bigint
  /** What the issuer can do about it, as a sentence. */
  fixes: string
}

export function assertCommitHeadroom(options: CommitHeadroomOptions): void {
  const { asset, decimals, maxSupplyRaw, circulatingRaw, committed } = options
  if (maxSupplyRaw === null) return
  const headroom = maxSupplyRaw - circulatingRaw
  if (committed <= headroom) return
  const show = (raw: bigint): string => formatRaw(raw, decimals)
  fail(
    'no-headroom',
    `${options.batch} commits ${show(committed)} ${asset} and only ${show(headroom < 0n ? 0n : headroom)} more can exist: ${asset} caps circulating supply at ${show(maxSupplyRaw)} and ${show(circulatingRaw)} are already held (SPEC §5.6.6). ${options.fixes} Entitlements from earlier batches that nobody has claimed yet are not counted in circulating supply, so leave room for those too.`,
  )
}
