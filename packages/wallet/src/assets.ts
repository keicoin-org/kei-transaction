/**
 * What `wallet.summary()` reads out of an asset's issuance record.
 *
 * The cache and the concurrency bound behind this used to live here and now
 * live in `@keicoin/core` (`asset-cache.ts`), because `items.ownedBy()` asks the
 * same question about the same account and a bound each is not a bound. The
 * argument for what may be remembered at all, and for the numbers, is there.
 * What is left here is the projection: the fields a summary renders, with the
 * item/currency split and the packed stat block already resolved.
 */

import type { AssetId, AssetRecord } from '@keicoin/core'
import { decodeDescription, looksLikeItem } from '@keicoin/tokens'
import type { ItemStats } from '@keicoin/tokens'

export {
  DEFAULT_ASSET_CACHE_LIMIT,
  DEFAULT_ASSET_CONCURRENCY,
  MAX_ASSET_CACHE_LIMIT,
  MAX_ASSET_CONCURRENCY,
} from '@keicoin/core'

/**
 * Everything the summary needs from an asset, and nothing that can change.
 *
 * `item` is `looksLikeItem` resolved at the read: it looks at `kind`,
 * `decimals` and `image`, all of them issuance metadata, so the answer is as
 * permanent as the fields behind it.
 */
export interface AssetFacts {
  asset: AssetId
  name: string
  symbol: string
  issuer: string
  decimals: number
  /** Whether this shows as an item rather than a currency. */
  item: boolean
  image?: string
  /** Prose only: the stat block packed in alongside it is split out. */
  description?: string
  stats?: ItemStats
}

export function assetFactsFrom(record: AssetRecord): AssetFacts {
  const base = {
    asset: record.id,
    name: record.name,
    symbol: record.symbol,
    issuer: record.issuer,
    decimals: record.decimals,
  }
  if (!looksLikeItem(record)) return { ...base, item: false }
  const { description, stats } = decodeDescription(record.description)
  return {
    ...base,
    item: true,
    ...(record.image === undefined ? {} : { image: record.image }),
    ...(description === undefined ? {} : { description }),
    ...(stats === undefined ? {} : { stats }),
  }
}
