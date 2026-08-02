#!/usr/bin/env node
/**
 * `npm create kei-game` — SPEC §11.3.
 *
 * It asks two things, writes a project, and exits. It is not a runtime
 * dependency, not a framework, and not something the generated game imports:
 * delete this package afterwards and the game still builds and still runs. That
 * is the test the spec sets, and `test/scaffold.test.ts` enforces it.
 *
 * It also installs nothing of its own — only what Node already has — so the
 * first thing a developer waits for is their game's dependencies, not the
 * scaffolder's.
 */

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { argv, cwd, exit, platform, stdout, versions } from 'node:process'

import { DEFAULT_CURRENCY, DEFAULT_NAME, helpText, parseArgs } from './cli.js'
import { HarnessError } from './errors.js'
import { projectFrom, type GameProject } from './naming.js'
import { assertWritable, writeFiles } from './write.js'
import { createAsker, type Asker } from './prompt.js'
import { DEFAULT_TEMPLATE, filesFor, templateNamed, type Template } from './templates.js'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  devDependencies: { 'kei-transaction': string }
}
const { version } = manifest

async function main(): Promise<void> {
  const options = parseArgs(argv.slice(2))

  if (options.help) {
    stdout.write(helpText(version))
    return
  }
  if (options.version) {
    stdout.write(`${version}\n`)
    return
  }

  const template = templateNamed(options.template ?? DEFAULT_TEMPLATE)

  // Nothing is asked if nothing needs asking, which is what makes this usable
  // from a script (SPEC §12). A template with no currency of its own is asked
  // one question rather than two, because the second has nowhere to go.
  const wantsCurrency = template.currency && options.currency === undefined
  const needsAsking = !options.yes && (options.name === undefined || wantsCurrency)
  const asker = needsAsking ? createAsker() : undefined

  let project: GameProject
  try {
    if (asker) {
      const questions = template.currency ? 'Two questions' : 'One question'
      stdout.write(`\n  ${template.summary}\n  ${questions}.\n\n`)
    }
    project = await answer(options, asker, template.currency)
  } finally {
    asker?.close()
  }

  const directory = resolve(cwd(), project.slug)
  await assertWritable(directory, options.force)

  if (template.source.kind === 'github') {
    stdout.write(`\n  Downloading ${template.name} from ${template.source.repo}...\n`)
  }

  const files = await filesFor(template, project, { sdkVersion: manifest.devDependencies['kei-transaction'] })
  await writeFiles(directory, files)

  stdout.write(nextSteps(template, project, files.length))
}

/**
 * Asks until the answers are usable, because a scaffolder that exits on a typo
 * makes the developer retype the answer that was fine.
 */
async function answer(
  options: { name?: string; currency?: string },
  asker: Asker | undefined,
  wantsCurrency: boolean,
): Promise<GameProject> {
  let name = options.name
  // A template with no currency still gets one derived, because `GameProject`
  // has the field. Nothing reads it, and asking for it would be worse than
  // filling it in.
  let currency = options.currency

  for (;;) {
    if (asker && name === undefined) name = await asker.ask('Project name?', DEFAULT_NAME)
    if (asker && wantsCurrency && currency === undefined) currency = await asker.ask('Currency name?', DEFAULT_CURRENCY)

    try {
      return projectFrom({ name: name ?? DEFAULT_NAME, currency: currency ?? DEFAULT_CURRENCY })
    } catch (error) {
      if (!asker || !(error instanceof HarnessError)) throw error
      stdout.write(`\n  ${error.message}\n\n`)
      // Whichever answer was at fault, both are cheap to retype and only the
      // developer knows which one they meant.
      name = options.name
      currency = options.currency
    }
  }
}

function nextSteps(template: Template, project: GameProject, count: number): string {
  const head = `
  ${project.title} — ${count} files in ${project.slug}/
`
  if (template.name === 'world-of-wonder') {
    return `${head}
    cd ${project.slug}
    npm ci
    npm run server-build && npm run server-start    # http://localhost:3000
    npm run client-dev                              # http://localhost:8080

  Your currency is ${project.currency}, and the chain knows it as ${project.symbol}.
  It is declared once, as COIN in src/server/kei/Economy.ts.

  This settles on the public Kei testnet by default — a real network, with no
  uptime promise and nothing on it worth anything. KEI_NETWORK=mock runs a chain
  inside the process instead, which is what you want offline.

  Set KEI_GAME_SEED before you play twice. Without one the issuer changes every
  restart, and every balance from the run before becomes unreachable.
`
  }

  if (template.name === 'carpet-markets') {
    return `${head}
    cd ${project.slug}
    bun install
    bun run dev          # http://localhost:7788

  No currency was asked for because this one has none: every coin is launched by
  a player at runtime, and whether it can be rugged is the deed's transfer
  policy, chosen at launch and enforced by consensus.

  Read server/market.ts first — it is the launchpad, the curve, and the reserve.
`
  }

  const bun = hasBun()
  return `${head}
    cd ${project.slug}
    bun install
    bun run dev
${bun ? '' : `
  The dev server is a Bun program: it serves the game, bundles the client, and
  runs a Kei node in memory, with no build tooling in between. Install Bun from
  https://bun.sh first — nothing else is needed.
`}
  Your currency is ${project.currency}, and the chain knows it as ${project.symbol}.
  The node it runs against lives in memory and dies with the process, so nothing
  on it is worth anything yet — which is what you want while you are building.

  Open src/economy.ts first: it is every line of Kei in the browser. The whole
  backend is server/game.ts. Both are short.
`
}

/** Only to decide which sentence to print. The scaffold does not care. */
function hasBun(): boolean {
  if (versions.bun !== undefined) return true
  try {
    return spawnSync('bun', ['--version'], { stdio: 'ignore', shell: platform === 'win32' }).status === 0
  } catch {
    return false
  }
}

try {
  await main()
} catch (error) {
  if (error instanceof HarnessError) {
    stdout.write(`\n  ${error.message}\n\n`)
    exit(1)
  }
  throw error
}
