/* Temporary repro for the close-race hang. Not a test file. */
import { CountingNode, GateNode } from './net.js'
import { World } from './world.js'

const world = await World.create()
console.log('world ready')
const sword = await world.issue({ symbol: 'SWORD' })
console.log('issued')

const counting = new CountingNode(world.node)
const gate = new GateNode(counting)
gate.hold('accountSwaps')

const seller = await world.actor('seller', { node: gate, market: { autoCancelExpired: true } })
console.log('seller ready')
await world.mint(sword, seller, 1)
console.log('minted')

const offer = await seller.market.sell({
  asset: sword,
  amount: 1,
  price: 5,
  expiresAt: world.clock.at + 5,
})
console.log('sold', offer.hash.slice(0, 8))
world.clock.tick(100)

const held = await gate.captured()
console.log('captured', held.method, held.key.slice(0, 12))
seller.market.close()
console.log('closed')
held.release()
gate.open('accountSwaps')
console.log('released')

await new Promise((resolve) => setTimeout(resolve, 300))
const state = (await world.node.swapOffer(offer.hash))?.state
console.log('final state', state, 'process calls', counting.calls.process)
world.close()
process.exit(0)
