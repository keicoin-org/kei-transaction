import process from 'node:process'
import { readFile } from 'node:fs/promises'

const [expectedName, expectedVersion, manifestPath, option] = process.argv.slice(2)

if (!expectedName || !expectedVersion || !manifestPath) {
  throw new Error(
    'usage: node scripts/check-pack.mjs <name> <version> <package.json> [--field=integrity|--field=filename]',
  )
}

let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk

// PowerShell can prefix piped UTF-8 with a BOM; POSIX shells do not, but the
// checker is intentionally usable from either release environment.
const parsed = JSON.parse(input.replace(/^\uFEFF/, ''))
const reports = Array.isArray(parsed) ? parsed : [parsed]
if (!Array.isArray(reports) || reports.length !== 1) {
  throw new Error(`expected one npm pack report for ${expectedName}@${expectedVersion}`)
}

const report = reports[0]
if (report.name !== expectedName || report.version !== expectedVersion) {
  throw new Error(
    `packed ${String(report.name)}@${String(report.version)}, expected ${expectedName}@${expectedVersion}`,
  )
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
  throw new Error(
    `manifest declares ${String(manifest.name)}@${String(manifest.version)}, expected ${expectedName}@${expectedVersion}`,
  )
}

const paths = new Set(report.files.map((file) => file.path))
const targets = new Set(['package.json', 'README.md', 'LICENSE'])

function addTarget(value, field) {
  if (typeof value === 'string') {
    if (value.includes('*')) {
      throw new Error(`${expectedName}@${expectedVersion} has an uncheckable wildcard in ${field}: ${value}`)
    }
    const path = value.replace(/^\.\//, '')
    if (!path || path.startsWith('../') || path.includes('/../')) {
      throw new Error(`${expectedName}@${expectedVersion} has an unsafe ${field} target: ${value}`)
    }
    targets.add(path)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) addTarget(child, `${field}.${key}`)
  }
}

addTarget(manifest.exports, 'exports')
addTarget(manifest.bin, 'bin')
addTarget(manifest.main, 'main')
addTarget(manifest.module, 'module')
addTarget(manifest.types, 'types')

for (const required of targets) {
  if (!paths.has(required)) throw new Error(`${expectedName}@${expectedVersion} omits ${required}`)
}

const residue = [...paths].filter((path) =>
  /(^|\/)(?:test|tests|node_modules|\.git|\.claude|worktrees?)(?:\/|$)|(^|\/)(?:bun\.lockb?|.*\.tsbuildinfo)$/i.test(
    path,
  ),
)
if (residue.length > 0) {
  throw new Error(`${expectedName}@${expectedVersion} contains release residue: ${residue.join(', ')}`)
}

if (option?.startsWith('--field=')) {
  const field = option.slice('--field='.length)
  if (!['integrity', 'filename'].includes(field) || typeof report[field] !== 'string') {
    throw new Error(`npm pack report has no supported string field ${field}`)
  }
  process.stdout.write(report[field])
  process.exit(0)
}
if (option) throw new Error(`unknown option: ${option}`)

console.log(
  `    ${expectedName}@${expectedVersion}: ${report.entryCount} files, ${report.unpackedSize} bytes unpacked`,
)
