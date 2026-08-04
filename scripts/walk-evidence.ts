/**
 * Reproducible timing evidence for the bounded account-walk implementation.
 *
 * A mock ledger answers instantly, so a real link is simulated by delaying every
 * `account_swaps` by a fixed amount. That is the only thing being modelled here:
 * a chain walk's cost is round trips, and the question is how many of them are
 * serialised.
 *
 *   bun run scripts/walk-evidence.ts [roster] [latencyMs]
 */

import { Kei, randomSeed, type Item, type KeiNode, type MockNode, type SwapState } from 'kei-transaction'

const ROSTER = Number(process.argv[2] ?? 32)
const LATENCY = Number(process.argv[3] ?? 20)

function instrumented(base: KeiNode, latency: number): { node: KeiNode; calls: () => number } {
  let calls = 0
  const node = new Proxy(base, {
    get: (target, property, receiver) =>
      property === 'accountSwaps'
        ? async (address: string, options?: { limit?: number; state?: SwapState }) => {
            calls += 1
            await new Promise((resolve) => setTimeout(resolve, latency))
            return (target as KeiNode).accountSwaps(address, options)
          }
        : Reflect.get(target, property, receiver),
  }) as unknown as KeiNode
  return { node, calls: () => calls }
}

async function main(): Promise<void> {
  const ledger: MockNode = await Kei.mock()
  const game = await Kei.server({ seed: randomSeed(), node: ledger })
  await game.faucet(100_000)

  const sword: Item = await game.items.create({ name: 'Iron Sword', supply: 10_000 })
  const swords = await game.items.token(sword.id)

  const sellers = await Promise.all(
    Array.from({ length: ROSTER }, () =>
      Kei.start({ node: ledger, seed: randomSeed(), autoCancelExpired: false }),
    ),
  )
  for (const seller of sellers) {
    await game.send(seller.address, 100)
    await swords.mint(seller.address, 4)
  }
  await Promise.all(sellers.map((seller) => seller.sync()))
  for (const seller of sellers) await seller.market.sell({ asset: sword, price: 5 })

  const roster = sellers.map((seller) => seller.address)
  console.log(`roster ${ROSTER} chains, ${LATENCY} ms per account_swaps\n`)
  console.log('concurrency   calls   ms     rows')

  for (const concurrency of [1, 2, 4, 8, 16, 32]) {
    const { node, calls } = instrumented(ledger, LATENCY)
    const reader = await Kei.start({ node, seed: randomSeed(), autoCancelExpired: false })
    const started = performance.now()
    const book = await reader.market.book({ from: roster, asset: sword, concurrency })
    const ms = Math.round(performance.now() - started)
    console.log(
      `${String(concurrency).padStart(11)}${String(calls()).padStart(8)}${String(ms).padStart(7)}${String(
        book.asks.length,
      ).padStart(9)}   complete=${book.coverage.complete}`,
    )
    reader.close()
  }

  for (const seller of sellers) seller.close()
  game.close()
}

await main()
