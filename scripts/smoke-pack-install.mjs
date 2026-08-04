import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import process from 'node:process'

const [installRoot, ...manifestPaths] = process.argv.slice(2)
if (!installRoot || manifestPaths.length === 0) {
  throw new Error('usage: node scripts/smoke-pack-install.mjs <install-root> <package.json>...')
}

const imports = []
const bins = []
for (const manifestPath of manifestPaths) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!manifest.name || !manifest.exports) throw new Error(`${manifestPath} must declare a name and exports`)

  for (const key of Object.keys(manifest.exports)) {
    if (key.includes('*')) throw new Error(`${manifest.name} has an uncheckable wildcard export: ${key}`)
    imports.push(key === '.' ? manifest.name : `${manifest.name}${key.slice(1)}`)
  }
  if (typeof manifest.bin === 'string') bins.push([manifest.name, manifest.bin])
  else if (manifest.bin) {
    for (const target of Object.values(manifest.bin)) bins.push([manifest.name, target])
  }
}

const smokePath = join(installRoot, 'smoke.mjs')
await writeFile(smokePath, `${imports.map((specifier) => `await import(${JSON.stringify(specifier)})`).join('\n')}\n`)

const smoke = spawnSync(process.execPath, [smokePath], { cwd: installRoot, encoding: 'utf8' })
if (smoke.status !== 0) throw new Error(`packed public-entry import failed:\n${smoke.stdout}${smoke.stderr}`)

for (const [name, target] of bins) {
  const binPath = join(installRoot, 'node_modules', ...name.split('/'), target.replace(/^\.\//, ''))
  const syntax = spawnSync(process.execPath, ['--check', binPath], { encoding: 'utf8' })
  if (syntax.status !== 0) {
    throw new Error(`packed binary check failed for ${name} ${target}:\n${syntax.stdout}${syntax.stderr}`)
  }
}

console.log(`    imported ${imports.length} public entries and checked ${bins.length} binaries from packed installs`)
