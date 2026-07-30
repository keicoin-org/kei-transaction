/**
 * The in-game wallet, headless half.
 *
 * SPEC §6.5: most players will never open the standalone wallet, so the in-game
 * panel is what they actually use. M0 ships the data behind it — one summary
 * call and a change event — which is also the escape hatch for a developer
 * drawing their own UI. `WalletPanel.mount()` and the seed-reveal friction land
 * at M6, along with the `kei.pay()` confirmation dialog that §6.8 moved here.
 */

import type { AssetId, KeiClient } from '@keicoin/core'
import { KEI_DECIMALS, fromRaw } from '@keicoin/core'
import { looksLikeItem } from '@keicoin/tokens'
import type { ClaimsApi, PendingClaim } from '@keicoin/claims'

export interface TokenBalance {
  asset: AssetId
  symbol: string
  name: string
  amount: number
  issuer: string
}

export interface ItemHolding {
  asset: AssetId
  name: string
  symbol: string
  count: number
  issuer: string
  image?: string
  description?: string
}

export interface WalletSummary {
  address: string
  kei: number
  tokens: TokenBalance[]
  items: ItemHolding[]
  pending: PendingClaim[]
}

export interface WalletApi {
  summary(): Promise<WalletSummary>
  on(event: 'change', listener: (summary: WalletSummary) => void): () => void
}

export interface WalletOptions {
  claims?: ClaimsApi
}

export function createWallet(client: KeiClient, options: WalletOptions = {}): WalletApi {
  const summary = async (): Promise<WalletSummary> => {
    const [info, holdings] = await Promise.all([
      client.node.accountInfo(client.address),
      client.node.holdings(client.address),
    ])

    const tokens: TokenBalance[] = []
    const items: ItemHolding[] = []
    for (const holding of holdings) {
      const asset = await client.node.assetInfo(holding.asset)
      if (!asset) continue
      if (looksLikeItem(asset)) {
        items.push({
          asset: asset.id,
          name: asset.name,
          symbol: asset.symbol,
          count: Number(holding.balance),
          issuer: asset.issuer,
          ...(asset.image === undefined ? {} : { image: asset.image }),
          ...(asset.description === undefined ? {} : { description: asset.description }),
        })
      } else {
        tokens.push({
          asset: asset.id,
          symbol: asset.symbol,
          name: asset.name,
          amount: fromRaw(BigInt(holding.balance), asset.decimals),
          issuer: asset.issuer,
        })
      }
    }

    return {
      address: client.address,
      kei: info ? fromRaw(BigInt(info.balance), KEI_DECIMALS) : 0,
      tokens,
      items,
      pending: options.claims ? await options.claims.pending() : [],
    }
  }

  return {
    summary,
    on(event, listener) {
      if (event !== 'change') return () => undefined
      // Every block this wallet writes, and every arrival it collects, can move
      // one of the numbers above.
      return client.on('update', () => {
        void summary()
          .then(listener)
          .catch(() => undefined)
      })
    },
  }
}
