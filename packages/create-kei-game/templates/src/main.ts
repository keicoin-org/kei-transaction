/**
 * Click it, get paid.
 *
 * The whole game is three files, and this one joins the other two. Neither of
 * them knows anything about the other: the world takes a state object and
 * paints it, the economy talks to a chain, and this decides what a click means.
 */

import { connect } from './economy.js'
import { createWorld } from './world.js'

const canvas = document.getElementById('game') as HTMLCanvasElement
const world = createWorld(canvas)

const economy = await connect()

world.onClick(() => {
  economy.click()
  world.pop(`+${Math.floor(economy.state.perClick)}`)
  world.update(economy.state)
})

world.onBuy(() => {
  void economy.buyLantern()
})

economy.on((state) => world.update(state))
world.update(economy.state)

window.addEventListener('beforeunload', () => economy.close())
