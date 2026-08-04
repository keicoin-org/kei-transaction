import process from 'node:process'

const [expectedName, expectedVersion] = process.argv.slice(2)

if (!expectedName || !expectedVersion) {
  throw new Error('usage: node scripts/check-pack.mjs <name> <version>')
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

const paths = new Set(report.files.map((file) => file.path))
for (const required of [
  'package.json',
  'README.md',
  'LICENSE',
  'src/index.ts',
  'dist/index.js',
  'dist/index.d.ts',
]) {
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

console.log(
  `    ${expectedName}@${expectedVersion}: ${report.entryCount} files, ${report.unpackedSize} bytes unpacked`,
)
