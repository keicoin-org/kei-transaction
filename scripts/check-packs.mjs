// Pack every publishable package the way a release would, and prove the result
// installs and imports before any of it can reach the registry.
//
// `publish.sh` carried this loop inline, so the one check that reads the actual
// tarball only ever ran at release time — the moment when a mistake has already
// cost a version number. Packing is also what runs each package's `prepack`
// build, which makes this the check that a tarball can never ship an `exports`
// map pointing at `dist/` files the tarball does not contain (#158).
//
// The set of packages and the order they go out in are derived here from
// `packages/*` and the workspace-internal dependency edges, and written to
// `order.txt` for `publish.sh` to consume, so a package added later cannot be
// left out of a release by forgetting to name it in two places.

import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

// Kept identical to publish.sh: publishConfig.registry outranks even a
// per-command --registry flag at publish time, so a manifest may not name
// anything but the reviewed public registry.
const NPM_REGISTRY = 'https://registry.npmjs.org/'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const packagesDirectory = join(repositoryRoot, 'packages')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const argv = process.argv.slice(2)
let packDestination = ''
for (const argument of argv) {
  if (argument.startsWith('--pack-destination=')) {
    packDestination = argument.slice('--pack-destination='.length)
    continue
  }
  throw new Error(`unknown option: ${argument}`)
}

// npm on Windows is a .cmd shim, and since Node 20 spawning one without a shell
// fails outright with EINVAL. Under a shell Node does not quote for us, so every
// argument is quoted here — the temp directories this passes around are under
// paths like C:\Users\... that routinely contain spaces.
function run(command, args, options = {}) {
  const shell = process.platform === 'win32' && command.endsWith('.cmd')
  const result = spawnSync(command, shell ? args.map((a) => `"${a}"`) : args, {
    encoding: 'utf8',
    shell,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with status ${String(result.status)}:\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    )
  }
  return result.stdout ?? ''
}

const entries = await readdir(packagesDirectory, { withFileTypes: true })
const packages = []
for (const entry of entries) {
  if (!entry.isDirectory()) continue

  const manifestPath = join(packagesDirectory, entry.name, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.private) continue

  if (manifest.publishConfig?.access !== 'public') {
    throw new Error(`${manifest.name ?? entry.name} must declare publishConfig.access as public`)
  }

  const manifestRegistry = manifest.publishConfig?.registry
  if (manifestRegistry && manifestRegistry !== NPM_REGISTRY) {
    throw new Error(
      `${manifest.name} publishConfig.registry '${manifestRegistry}' is not the pinned public registry ${NPM_REGISTRY}`,
    )
  }

  // A package whose exports point into dist/ can only satisfy them if something
  // builds dist/, and `dist/` is gitignored. The hook is the mechanism; a
  // convention that everyone remembers to run publish.sh is not.
  if (manifest.scripts?.prepack !== 'tsc --build') {
    throw new Error(
      `${manifest.name} must declare scripts.prepack as "tsc --build" so a bare npm publish cannot ship an unbuilt tarball`,
    )
  }

  packages.push({ directory: entry.name, manifestPath, manifest })
}

if (packages.length === 0) throw new Error('no publishable packages found under packages/')

// Dependency order: nothing is packed or published before the thing it imports.
// Ties break on directory name so the order is stable across machines.
const byName = new Map(packages.map((entry) => [entry.manifest.name, entry]))
const ordered = []
const visiting = new Set()
const visited = new Set()

function visit(entry, trail) {
  if (visited.has(entry.manifest.name)) return
  if (visiting.has(entry.manifest.name)) {
    throw new Error(`dependency cycle among workspace packages: ${[...trail, entry.manifest.name].join(' -> ')}`)
  }

  visiting.add(entry.manifest.name)
  const dependencyNames = Object.keys(entry.manifest.dependencies ?? {}).sort()
  for (const name of dependencyNames) {
    const dependency = byName.get(name)
    if (dependency) visit(dependency, [...trail, entry.manifest.name])
  }
  visiting.delete(entry.manifest.name)
  visited.add(entry.manifest.name)
  ordered.push(entry)
}

for (const entry of [...packages].sort((a, b) => a.directory.localeCompare(b.directory))) {
  visit(entry, [])
}

const destination =
  packDestination || (await mkdtemp(join(tmpdir(), 'kei-release-packs-')))
await mkdir(destination, { recursive: true })
await writeFile(
  join(destination, 'order.txt'),
  `${ordered.map((entry) => entry.directory).join('\n')}\n`,
)

console.log(`==> Packing ${ordered.length} packages in dependency order: ${ordered.map((e) => e.directory).join(' ')}`)

const manifestPaths = []
const tarballs = []
for (const entry of ordered) {
  const { name, version } = entry.manifest
  // `npm pack` on the directory is what triggers prepack, so the tarball under
  // test is built by the same path a bare `npm publish` would take.
  const report = run(npm, ['pack', '--json', '--pack-destination', destination, `./packages/${entry.directory}`], {
    cwd: repositoryRoot,
  })
  // publish.sh reads these reports again for the registry-integrity comparison,
  // so they are written under the directory name it looks them up by.
  await writeFile(join(destination, `${entry.directory}.json`), report)

  run(process.execPath, [join(repositoryRoot, 'scripts', 'check-pack.mjs'), name, version, entry.manifestPath], {
    cwd: repositoryRoot,
    input: report,
    stdio: ['pipe', 'inherit', 'inherit'],
  })

  // Take the filename npm actually chose rather than reconstructing it.
  tarballs.push(join(destination, JSON.parse(report.replace(/^\uFEFF/, ''))[0].filename))
  manifestPaths.push(entry.manifestPath)
}

console.log('==> Smoke-testing the packed dependency graph under Node')
const installRoot = join(destination, 'install')
await mkdir(installRoot, { recursive: true })

run(npm, ['install', '--prefix', installRoot, '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs], {
  cwd: repositoryRoot,
  stdio: ['ignore', 'inherit', 'inherit'],
})

run(process.execPath, [join(repositoryRoot, 'scripts', 'smoke-pack-install.mjs'), installRoot, ...manifestPaths], {
  cwd: repositoryRoot,
  stdio: ['ignore', 'inherit', 'inherit'],
})

console.log(`Packs valid: ${ordered.length} tarballs built by prepack, installed together and imported.`)
