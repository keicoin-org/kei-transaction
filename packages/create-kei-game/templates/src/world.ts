/**
 * A crystal on a plinth, a screen showing what it is worth, and a plate you can
 * click to buy a lantern.
 *
 * Babylon.js and nothing else. Nothing in this file knows what Kei is: it takes
 * a state object and paints it, and reports clicks back. Replace it with Three,
 * PlayCanvas, or a 2D canvas and the other two files do not change — the SDK is
 * not tied to a renderer, and neither is your game.
 */

/*
 * Babylon 9 is assembled from pure modules plus registrars that attach them to
 * the engine, and a bundler is free to drop an import that exists only for its
 * side effects. Importing `@babylonjs/core` and hoping gets you a build where
 * every light dies on `createUniformBuffer is not a function`.
 *
 * So the extensions this scene needs are asked for by calling the functions
 * Babylon provides for exactly that, which nothing can tree-shake away.
 */
import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  DynamicTexture,
  Engine,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PointerEventTypes,
  RegisterFullEngineExtensions,
  RegisterRay,
  RegisterShadowGeneratorSceneComponent,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
  type AbstractMesh,
} from '@babylonjs/core/pure.js'

import type { EconomyState } from './economy.js'

type Ctx = CanvasRenderingContext2D

export interface World {
  onClick(handler: () => void): void
  onBuy(handler: () => void): void
  update(state: EconomyState): void
  pop(text: string): void
  dispose(): void
}

const SCREEN = { width: 640, height: 320 }
const PLATE = { width: 512, height: 256 }

const FONT = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif'
const MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace'
const INK = '#e6f0ff'
const DIM = '#7c8ba1'
const CYAN = '#5eead4'
const AMBER = '#fbbf24'
const RED = '#f87171'

const CRYSTAL_Y = 1.9

export function createWorld(canvas: HTMLCanvasElement): World {
  // Called here rather than at module scope: a bundler puts module-scope calls
  // before the classes they patch have finished initialising. Both are
  // idempotent, so calling them per-world is free.
  RegisterFullEngineExtensions()
  RegisterShadowGeneratorSceneComponent(ShadowGenerator)
  // Picking is ray casting, and ray casting is an opt-in module: without this,
  // `scene.pick` quietly misses every mesh and nothing is clickable.
  RegisterRay()

  const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false })
  const scene = new Scene(engine)
  scene.clearColor = new Color4(0.04, 0.05, 0.07, 1)

  // Explicit, because the camera taking the canvas is not the same thing as the
  // scene listening for picks.
  scene.attachControl()

  const camera = new ArcRotateCamera('camera', -Math.PI / 2, 1.15, 9.5, new Vector3(0, 1.9, 0), scene)
  camera.attachControl(canvas, true)
  camera.lowerRadiusLimit = 5
  camera.upperRadiusLimit = 18
  camera.upperBetaLimit = 1.45
  camera.wheelPrecision = 30

  const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), scene)
  sky.intensity = 0.7
  sky.groundColor = new Color3(0.08, 0.09, 0.13)

  const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, 0.5), scene)
  sun.position = new Vector3(8, 13, -8)
  sun.intensity = 1

  const shadows = new ShadowGenerator(1024, sun)
  shadows.usePercentageCloserFiltering = true

  // ------------------------------------------------------------------- ground

  const ground = MeshBuilder.CreateGround('ground', { width: 60, height: 60 }, scene)
  ground.material = solid(scene, 'ground', '#161c26')
  ground.receiveShadows = true

  const plinth = MeshBuilder.CreateCylinder('plinth', { diameter: 2.2, height: 0.4 }, scene)
  plinth.position.y = 0.2
  plinth.material = solid(scene, 'plinth', '#2b3442')
  plinth.receiveShadows = true

  // ------------------------------------------------------------------ crystal

  // Two cones base to base. Parented rather than merged, so the pair rotates and
  // squashes as one thing while staying two primitives anybody can read.
  const crystalMaterial = solid(scene, 'crystal', '#2dd4bf')
  crystalMaterial.emissiveColor = new Color3(0.05, 0.22, 0.2)

  const crystal = MeshBuilder.CreateCylinder('crystal', { diameterTop: 0, diameterBottom: 1, height: 1.5 }, scene)
  crystal.position.y = CRYSTAL_Y
  crystal.material = crystalMaterial

  const crystalBase = MeshBuilder.CreateCylinder('crystalBase', { diameterTop: 0, diameterBottom: 1, height: 0.7 }, scene)
  crystalBase.parent = crystal
  crystalBase.position.y = -1.1
  crystalBase.rotation.z = Math.PI
  crystalBase.material = crystalMaterial

  for (const mesh of [crystal, crystalBase]) shadows.addShadowCaster(mesh)

  // ------------------------------------------------------------------ lantern

  // Bought, not given. It appears when the chain says this wallet holds one.
  const lantern = MeshBuilder.CreateBox('lantern', { width: 0.4, height: 0.55, depth: 0.4 }, scene)
  lantern.position.set(1.5, 1.5, 0.2)
  const lanternMaterial = solid(scene, 'lantern', '#fbbf24')
  lanternMaterial.emissiveColor = new Color3(0.5, 0.36, 0.05)
  lantern.material = lanternMaterial
  lantern.isPickable = false
  lantern.setEnabled(false)

  const post = MeshBuilder.CreateCylinder('lanternPost', { diameter: 0.1, height: 1.5 }, scene)
  post.position.set(1.5, 0.75, 0.2)
  post.material = solid(scene, 'lanternPost', '#3f4a5c')
  post.isPickable = false
  post.setEnabled(false)

  // ------------------------------------------------------------------ screens

  const screen = panel(scene, 'screen', 3.2, 1.6, SCREEN)
  screen.mesh.position.set(0, 3.7, 0)

  const plate = panel(scene, 'plate', 1.9, 0.95, PLATE)
  plate.mesh.position.set(-2.4, 1.35, 0.4)
  plate.mesh.rotation.y = 0.4

  // -------------------------------------------------------------- interaction

  const clickHandlers: Array<() => void> = []
  const buyHandlers: Array<() => void> = []
  const clickable = new Set<AbstractMesh>([crystal, crystalBase, plinth])

  let squashFor = 0
  const doClick = (): void => {
    squashFor = 0.1
    for (const handler of clickHandlers) handler()
  }

  // A click is a press and a release in roughly the same place. Doing it by hand
  // rather than taking Babylon's POINTERPICK stops a camera drag from buying
  // something on the way past.
  let downAt: { x: number; y: number } | null = null

  scene.onPointerObservable.add((info) => {
    if (info.type === PointerEventTypes.POINTERDOWN) {
      downAt = { x: scene.pointerX, y: scene.pointerY }
      return
    }
    if (info.type !== PointerEventTypes.POINTERUP || !downAt) return

    const travelled = Math.hypot(scene.pointerX - downAt.x, scene.pointerY - downAt.y)
    downAt = null
    if (travelled > 6) return

    const pick = scene.pick(scene.pointerX, scene.pointerY)
    if (!pick?.hit || !pick.pickedMesh) return

    if (clickable.has(pick.pickedMesh)) doClick()
    else if (pick.pickedMesh === plate.mesh) for (const handler of buyHandlers) handler()
  })

  const onKey = (event: KeyboardEvent): void => {
    if (event.code !== 'Space' && event.code !== 'Enter') return
    event.preventDefault()
    if (!event.repeat) doClick()
  }
  window.addEventListener('keydown', onKey)

  // --------------------------------------------------------------------- pops

  const pops = Array.from({ length: 10 }, (_, index) => createPop(scene, index))
  let nextPop = 0

  // -------------------------------------------------------------------- frame

  let pending: EconomyState | null = null
  let repaintAt = 0

  scene.onBeforeRenderObservable.add(() => {
    const delta = engine.getDeltaTime() / 1000

    crystal.rotation.y += delta * 0.35
    squashFor = Math.max(0, squashFor - delta)
    const target = squashFor > 0 ? 0.86 : 1
    crystal.scaling.y += (target - crystal.scaling.y) * Math.min(1, delta * 20)

    for (const pop of pops) {
      if (pop.life <= 0) continue
      pop.life -= delta
      pop.mesh.position.y += delta * 1.3
      pop.mesh.visibility = Math.max(0, Math.min(1, pop.life / 0.5))
      if (pop.life <= 0) pop.mesh.setEnabled(false)
    }

    // Clicks can arrive twenty times a second and a canvas repaint is not free,
    // so the screens settle at twenty frames rather than every state change.
    const now = performance.now()
    if (pending && now >= repaintAt) {
      const state = pending
      pending = null
      repaintAt = now + 50

      drawScreen(screen.ctx, state)
      screen.texture.update()
      drawPlate(plate.ctx, state)
      plate.texture.update()

      const lit = state.lanterns > 0
      lantern.setEnabled(lit)
      post.setEnabled(lit)
      crystalMaterial.emissiveColor = lit ? new Color3(0.16, 0.42, 0.36) : new Color3(0.05, 0.22, 0.2)
    }
  })

  engine.runRenderLoop(() => scene.render())
  const onResize = (): void => engine.resize()
  window.addEventListener('resize', onResize)

  return {
    onClick(handler) {
      clickHandlers.push(handler)
    },
    onBuy(handler) {
      buyHandlers.push(handler)
    },
    update(state) {
      pending = state
    },
    pop(text) {
      const pop = pops[nextPop++ % pops.length]!
      drawPop(pop.ctx, text)
      pop.texture.update()
      pop.mesh.position.set((Math.random() - 0.5) * 0.8, CRYSTAL_Y + 1, -0.2)
      pop.mesh.setEnabled(true)
      pop.mesh.visibility = 1
      pop.life = 0.8
    },
    dispose() {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
      engine.stopRenderLoop()
      scene.dispose()
      engine.dispose()
    },
  }
}

// ------------------------------------------------------------------- painting

const count = (value: number): string => Math.floor(value).toLocaleString('en-US')

/** The balance is a screen in the world, not an overlay on top of it. */
function drawScreen(ctx: Ctx, state: EconomyState): void {
  const { width, height } = SCREEN
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#0b1220'
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = '#1e2c44'
  ctx.lineWidth = 6
  ctx.strokeRect(3, 3, width - 6, height - 6)

  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.fillStyle = DIM
  ctx.font = `600 24px ${FONT}`
  ctx.fillText(state.symbol, 32, 56)

  ctx.fillStyle = state.online ? CYAN : RED
  ctx.font = `700 96px ${MONO}`
  ctx.fillText(count(state.coins), 28, 152)

  ctx.fillStyle = INK
  ctx.font = `500 26px ${FONT}`
  ctx.fillText(`+${count(state.perClick)} per click`, 32, 200)

  ctx.textAlign = 'right'
  ctx.fillStyle = state.unsaved > 0 ? AMBER : DIM
  ctx.font = `600 26px ${MONO}`
  ctx.fillText(state.unsaved > 0 ? `${count(state.unsaved)} unsaved` : 'all saved', width - 32, 200)

  ctx.fillStyle = DIM
  ctx.font = `500 22px ${MONO}`
  const kei = state.online ? `${state.kei.toFixed(3)} kei` : 'offline'
  ctx.fillText(state.saving ? 'saving…' : state.claiming > 0 ? 'claiming…' : kei, width - 32, 56)

  // The one place errors are shown, and they are shown as the SDK wrote them.
  ctx.textAlign = 'left'
  ctx.font = `500 20px ${FONT}`
  ctx.fillStyle = state.message ? AMBER : DIM
  wrap(ctx, state.message ?? state.address, 32, 246, width - 64, 24, 2)
}

function drawPlate(ctx: Ctx, state: EconomyState): void {
  const { width, height } = PLATE
  const owned = state.lanterns > 0
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = owned ? '#132119' : '#1a1526'
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = owned ? '#265c3e' : '#3b2d5c'
  ctx.lineWidth = 6
  ctx.strokeRect(3, 3, width - 6, height - 6)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = INK
  ctx.font = `700 40px ${FONT}`
  ctx.fillText('Lantern', width / 2, 74)

  ctx.fillStyle = DIM
  ctx.font = `400 22px ${FONT}`
  ctx.fillText('Doubles every click.', width / 2, 116)

  if (owned) {
    ctx.fillStyle = CYAN
    ctx.font = `600 32px ${MONO}`
    ctx.fillText('owned', width / 2, 186)
    return
  }

  ctx.fillStyle = AMBER
  ctx.font = `700 42px ${MONO}`
  ctx.fillText(`${state.lanternPrice} kei`, width / 2, 178)
  ctx.fillStyle = DIM
  ctx.font = `500 20px ${FONT}`
  ctx.fillText('click to buy', width / 2, 214)
}

function drawPop(ctx: Ctx, text: string): void {
  ctx.clearRect(0, 0, 256, 128)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `700 60px ${MONO}`
  ctx.lineWidth = 10
  ctx.strokeStyle = '#050810'
  ctx.strokeText(text, 128, 64)
  ctx.fillStyle = CYAN
  ctx.fillText(text, 128, 64)
}

function wrap(ctx: Ctx, text: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number): void {
  let line = ''
  let lines = 0

  for (const word of text.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate
      continue
    }
    ctx.fillText(line, x, y + lines * lineHeight)
    lines++
    line = word
    if (lines >= maxLines - 1) break
  }
  if (lines < maxLines) ctx.fillText(line, x, y + lines * lineHeight)
}

// ------------------------------------------------------------------ materials

function solid(scene: Scene, name: string, hex: string): StandardMaterial {
  const material = new StandardMaterial(name, scene)
  material.diffuseColor = Color3.FromHexString(hex)
  material.specularColor = new Color3(0.05, 0.06, 0.07)
  return material
}

interface Panel {
  mesh: Mesh
  texture: DynamicTexture
  ctx: Ctx
}

/** A canvas on a plane, lit by nothing, so the colours drawn are the colours seen. */
function panel(scene: Scene, name: string, width: number, height: number, pixels: { width: number; height: number }): Panel {
  const mesh = MeshBuilder.CreatePlane(name, { width, height }, scene)
  const texture = new DynamicTexture(`${name}Texture`, pixels, scene, false)
  const material = new StandardMaterial(`${name}Material`, scene)
  material.diffuseTexture = texture
  material.emissiveColor = new Color3(1, 1, 1)
  material.disableLighting = true
  material.backFaceCulling = false
  mesh.material = material
  return { mesh, texture, ctx: texture.getContext() as unknown as Ctx }
}

interface Pop extends Panel {
  life: number
}

function createPop(scene: Scene, index: number): Pop {
  const mesh = MeshBuilder.CreatePlane(`pop${index}`, { width: 1, height: 0.5 }, scene)
  mesh.billboardMode = Mesh.BILLBOARDMODE_ALL
  mesh.isPickable = false
  mesh.setEnabled(false)

  const texture = new DynamicTexture(`pop${index}Texture`, { width: 256, height: 128 }, scene, false)
  texture.hasAlpha = true

  const material = new StandardMaterial(`pop${index}Material`, scene)
  material.diffuseTexture = texture
  material.emissiveColor = new Color3(1, 1, 1)
  material.disableLighting = true
  material.useAlphaFromDiffuseTexture = true
  material.backFaceCulling = false
  mesh.material = material

  return { mesh, texture, ctx: texture.getContext() as unknown as Ctx, life: 0 }
}
