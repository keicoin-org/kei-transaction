import { readdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import process from 'node:process'

// Surfaces the documentation is written against, which importing a module does
// not exercise. `history`/`ohlc`/`ticker`/`chart` are aliases over `series()`
// and `candles()` — that is exactly why dropping one breaks no build, since the
// interface still declares it, and the first report would be a reader following
// the site's market docs against an installed package that has no such method.
const DOCUMENTED_SURFACES = [
  {
    package: '@keicoin/market',
    factory: 'createMarket',
    methods: ['series', 'history', 'candles', 'ohlc', 'ticker', 'chart'],
    // A stub client is enough: every client call in the market sits inside an
    // async method, and `autoCancelExpired: false` leaves the expiry sweep
    // unarmed, so building one reads no chain and starts no timer.
    construct: "factory({ address: 'kei_smoke', node: {} }, { autoCancelExpired: false })",
  },
]

const [installRoot, ...manifestPaths] = process.argv.slice(2)
if (!installRoot || manifestPaths.length === 0) {
  throw new Error('usage: node scripts/smoke-pack-install.mjs <install-root> <package.json>...')
}

const imports = []
const bins = []
const packageNames = new Set()
for (const manifestPath of manifestPaths) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!manifest.name || !manifest.exports) throw new Error(`${manifestPath} must declare a name and exports`)

  packageNames.add(manifest.name)
  for (const key of Object.keys(manifest.exports)) {
    if (key.includes('*')) throw new Error(`${manifest.name} has an uncheckable wildcard export: ${key}`)
    imports.push(key === '.' ? manifest.name : `${manifest.name}${key.slice(1)}`)
  }
  if (typeof manifest.bin === 'string') bins.push([manifest.name, manifest.bin])
  else if (manifest.bin) {
    for (const target of Object.values(manifest.bin)) bins.push([manifest.name, target])
  }
}

// Every installed copy of every workspace package, nested ones included. npm
// hoists what it can and nests what it cannot, so a package appearing twice is
// a range that could not reach the version one of its dependents asked for.
async function collectInstalledCopies(root) {
  const copies = new Map()
  const record = async (name, directory) => {
    let version
    try {
      version = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).version ?? '?'
    } catch {
      return
    }
    if (!copies.has(name)) copies.set(name, [])
    copies.get(name).push({ directory, version })
  }

  const pending = [join(root, 'node_modules')]
  while (pending.length > 0) {
    const modules = pending.pop()
    let entries
    try {
      entries = await readdir(modules, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.bin') continue

      if (entry.name.startsWith('@')) {
        let scoped
        try {
          scoped = await readdir(join(modules, entry.name), { withFileTypes: true })
        } catch {
          continue
        }
        for (const scopedEntry of scoped) {
          if (!scopedEntry.isDirectory()) continue
          const directory = join(modules, entry.name, scopedEntry.name)
          await record(`${entry.name}/${scopedEntry.name}`, directory)
          pending.push(join(directory, 'node_modules'))
        }
        continue
      }

      const directory = join(modules, entry.name)
      await record(entry.name, directory)
      pending.push(join(directory, 'node_modules'))
    }
  }

  return copies
}

const surfaceChecks = DOCUMENTED_SURFACES.filter((surface) => packageNames.has(surface.package)).map(
  (surface) => `
{
  const loaded = await import(${JSON.stringify(surface.package)})
  const factory = loaded[${JSON.stringify(surface.factory)}]
  if (typeof factory !== 'function') {
    throw new Error(${JSON.stringify(`${surface.package} no longer exports ${surface.factory}()`)})
  }
  const built = ${surface.construct}
  for (const method of ${JSON.stringify(surface.methods)}) {
    if (typeof built[method] !== 'function') {
      throw new Error(
        ${JSON.stringify(`${surface.package} ${surface.factory}() is missing the documented method `)} + method + '()',
      )
    }
  }
}`,
)

const smokePath = join(installRoot, 'smoke.mjs')
await writeFile(
  smokePath,
  `${[...imports.map((specifier) => `await import(${JSON.stringify(specifier)})`), ...surfaceChecks].join('\n')}\n`,
)

const smoke = spawnSync(process.execPath, [smokePath], { cwd: installRoot, encoding: 'utf8' })
if (smoke.status !== 0) throw new Error(`packed public-entry import failed:\n${smoke.stdout}${smoke.stderr}`)

// The defect behind #157 was never a failed import — it was an install that
// resolved four copies of @keicoin/core, because the umbrella's floor could not
// reach the version its siblings declared. Core owns the client and the shared
// asset cache, so duplication splits cache and identity state across copies of
// a thing the process is entitled to have one of, and every import still
// succeeds. Nothing else in the release checks it.
const copies = await collectInstalledCopies(installRoot)
const duplicated = []
for (const name of [...packageNames].sort()) {
  const installed = copies.get(name) ?? []
  if (installed.length === 0) throw new Error(`${name} is missing from the packed install`)
  if (installed.length > 1) {
    duplicated.push(
      `${name} resolved ${installed.length} copies:\n${installed
        .map((copy) => `        ${copy.version}  ${copy.directory}`)
        .join('\n')}`,
    )
  }
}
if (duplicated.length > 0) {
  throw new Error(
    `the packed graph is not dependency-closed — every workspace package must resolve to exactly one copy:\n    ${duplicated.join('\n    ')}`,
  )
}

for (const [name, target] of bins) {
  const binPath = join(installRoot, 'node_modules', ...name.split('/'), target.replace(/^\.\//, ''))
  const syntax = spawnSync(process.execPath, ['--check', binPath], { encoding: 'utf8' })
  if (syntax.status !== 0) {
    throw new Error(`packed binary check failed for ${name} ${target}:\n${syntax.stdout}${syntax.stderr}`)
  }
}

console.log(
  `    imported ${imports.length} public entries, checked ${surfaceChecks.length} documented surface(s), ` +
    `resolved ${packageNames.size} packages to one copy each and checked ${bins.length} binaries from packed installs`,
)
