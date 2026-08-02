/**
 * The templates that are not in this package.
 *
 * Two of the three are downloaded, which would make these tests a network
 * dependency if they were allowed to be. They are not: `filesFor` takes a
 * fetcher, and everything below hands it a tarball built a few lines earlier.
 * A test suite that downloads 30MB of 3D models to check a string substitution
 * is a test suite that fails on a train.
 *
 * What is actually being pinned here is the loudness. A rewrite that quietly
 * matches nothing emits a project still called `world-of-wonder`, still paying
 * in Gold, and the developer finds out much later — so every one of them is
 * required to throw, and there is a test for each.
 */

import { gzipSync } from 'node:zlib'
import { describe, expect, test } from 'bun:test'

import { HarnessError } from '../src/errors.js'
import { projectFrom } from '../src/naming.js'
import { extractTarGz } from '../src/tar.js'
import { DEFAULT_TEMPLATE, TEMPLATES, filesFor, templateNamed } from '../src/templates.js'
import type { GeneratedFile } from '../src/scaffold.js'

const project = projectFrom({ name: 'My Realm', currency: 'Shards' })

// ── Building tarballs, so the tests own their input ──────────────────────────

const BLOCK = 512

interface FixtureFile {
  path: string
  contents: string | Uint8Array
  typeflag?: string
}

/** The write half of `src/tar.ts`, and only as much of it as the fixtures need. */
function tarball(files: readonly FixtureFile[], root = 'repo-main'): Uint8Array {
  const blocks: Uint8Array[] = []

  for (const file of files) {
    const body = typeof file.contents === 'string' ? Buffer.from(file.contents, 'utf8') : Buffer.from(file.contents)
    const header = Buffer.alloc(BLOCK)

    header.write(`${root}/${file.path}`, 0, 100, 'utf8')
    header.write('000644 \0', 100, 8, 'utf8')
    header.write('000000 \0', 108, 8, 'utf8')
    header.write('000000 \0', 116, 8, 'utf8')
    header.write(`${body.length.toString(8).padStart(11, '0')} `, 124, 12, 'utf8')
    header.write('00000000000 ', 136, 12, 'utf8')
    header.write(file.typeflag ?? '0', 156, 1, 'utf8')
    header.write('ustar\0', 257, 6, 'utf8')
    header.write('00', 263, 2, 'utf8')

    // The checksum is computed with its own field read as spaces, which is the
    // one genuinely odd corner of the format.
    header.write('        ', 148, 8, 'utf8')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')

    blocks.push(header, body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK))
  }

  blocks.push(Buffer.alloc(BLOCK * 2))
  return new Uint8Array(Buffer.concat(blocks))
}

const gzip = (files: readonly FixtureFile[], root?: string): Uint8Array =>
  new Uint8Array(gzipSync(Buffer.from(tarball(files, root))))

const textOf = (file: GeneratedFile): string =>
  typeof file.contents === 'string' ? file.contents : Buffer.from(file.contents).toString('utf8')

const at = (files: readonly GeneratedFile[], path: string): GeneratedFile => {
  const found = files.find((file) => file.path === path)
  if (!found) throw new Error(`${path} is missing. Got: ${files.map((f) => f.path).join(', ')}`)
  return found
}

/** Enough of each downloaded repository that the rewrites have somewhere to land. */
const WORLD_OF_WONDER: FixtureFile[] = [
  {
    path: 'package.json',
    contents: JSON.stringify({ name: 'world-of-wonder', private: true, repository: { url: 'git+https://…' } }, null, 4),
  },
  {
    path: 'src/server/kei/Economy.ts',
    contents: ["export const COIN = {", "  name: 'Gold',", "  symbol: 'GOLD',", '} as const', ''].join('\n'),
  },
  { path: 'README.md', contents: '# world-of-wonder\n' },
  { path: 'public/models/rat.glb', contents: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x00, 0xff, 0x10]) },
  {
    path: 'package-lock.json',
    contents: JSON.stringify(
      {
        name: 'world-of-wonder',
        lockfileVersion: 3,
        packages: { '': { name: 'world-of-wonder' }, 'node_modules/left-pad': { version: '1.3.0' } },
      },
      null,
      4,
    ),
  },
]

const CARPET_MARKETS: FixtureFile[] = [
  { path: 'package.json', contents: JSON.stringify({ name: 'carpet-markets', private: true }, null, 4) },
  { path: 'README.md', contents: '# Carpet Markets\n' },
]

const fetcherFor = (files: readonly FixtureFile[]) => async () => gzip(files)

// ── The registry ─────────────────────────────────────────────────────────────

describe('the registry', () => {
  test('the default is the one that ships inside this package', () => {
    expect(templateNamed(DEFAULT_TEMPLATE).source.kind).toBe('local')
  })

  test('every template has a summary, because --help prints them', () => {
    for (const template of TEMPLATES) expect(template.summary.length).toBeGreaterThan(20)
  })

  test('an unknown name lists the ones that exist rather than just refusing', () => {
    let message = ''
    try {
      templateNamed('mmo')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('mmo')
    for (const template of TEMPLATES) expect(message).toContain(template.name)
  })

  test('only carpet-markets has no currency to name', () => {
    expect(TEMPLATES.filter((template) => !template.currency).map((t) => t.name)).toEqual(['carpet-markets'])
  })
})

// ── world-of-wonder ──────────────────────────────────────────────────────────

describe('world-of-wonder', () => {
  const build = () =>
    filesFor(templateNamed('world-of-wonder'), project, {
      sdkVersion: '^0.3.0',
      fetcher: fetcherFor(WORLD_OF_WONDER),
    })

  test('the archive s top-level directory does not end up in the project', async () => {
    const files = await build()
    for (const file of files) expect(file.path.startsWith('repo-main/')).toBe(false)
    expect(files.map((file) => file.path)).toContain('src/server/kei/Economy.ts')
  })

  test('the developer s currency reaches the one place that declares it', async () => {
    const economy = textOf(at(await build(), 'src/server/kei/Economy.ts'))
    expect(economy).toContain("name: 'Shards'")
    expect(economy).toContain("symbol: 'SHARD'")
    expect(economy).not.toContain('Gold')
  })

  test('the project is the developer s: their name, and none of our remotes', async () => {
    const manifest = JSON.parse(textOf(at(await build(), 'package.json'))) as Record<string, unknown>
    expect(manifest.name).toBe('my-realm')
    expect(manifest.repository).toBeUndefined()
    // `private` is the example's decision about itself, not the new project's.
    expect(manifest.private).toBeUndefined()
  })

  test('the lockfile stops calling the project by the example s name', async () => {
    const lockfile = textOf(at(await build(), 'package-lock.json'))
    expect(lockfile).not.toContain('world-of-wonder')
    // Both places it appears — the root and packages[""] — and nothing else.
    expect([...lockfile.matchAll(/"name": "my-realm"/g)]).toHaveLength(2)
    expect(lockfile).toContain('node_modules/left-pad')
  })

  test('the README is rewritten for the project, not inherited', async () => {
    const readme = textOf(at(await build(), 'README.md'))
    expect(readme).toContain('# My Realm')
    expect(readme).toContain('Shards')
    expect(readme).not.toContain('# world-of-wonder')
  })

  test('binary assets survive as bytes', async () => {
    const model = at(await build(), 'public/models/rat.glb')
    expect(model.contents).toBeInstanceOf(Uint8Array)
    expect([...(model.contents as Uint8Array)]).toEqual([0x67, 0x6c, 0x54, 0x46, 0x00, 0xff, 0x10])
  })

  test('a drift in the upstream repository fails here rather than scaffolding badly', async () => {
    const drifted = WORLD_OF_WONDER.map((file) =>
      file.path === 'src/server/kei/Economy.ts' ? { ...file, contents: "export const COIN = { name: 'Coins' }" } : file,
    )
    const attempt = filesFor(templateNamed('world-of-wonder'), project, {
      sdkVersion: '^0.3.0',
      fetcher: fetcherFor(drifted),
    })
    await expect(attempt).rejects.toThrow(HarnessError)
  })

  test('a missing file is named, not ignored', async () => {
    const without = WORLD_OF_WONDER.filter((file) => file.path !== 'package.json')
    const attempt = filesFor(templateNamed('world-of-wonder'), project, {
      sdkVersion: '^0.3.0',
      fetcher: fetcherFor(without),
    })
    await expect(attempt).rejects.toThrow(/package\.json/)
  })
})

// ── carpet-markets ───────────────────────────────────────────────────────────

describe('carpet-markets', () => {
  test('is renamed but keeps its own coins, because the player launches those', async () => {
    const files = await filesFor(templateNamed('carpet-markets'), project, {
      sdkVersion: '^0.3.0',
      fetcher: fetcherFor(CARPET_MARKETS),
    })
    const manifest = JSON.parse(textOf(at(files, 'package.json'))) as Record<string, unknown>
    expect(manifest.name).toBe('my-realm')
    expect(textOf(at(files, 'README.md'))).toContain('# My Realm')
    // The two answers do not include a currency here, so none is claimed.
    expect(textOf(at(files, 'README.md'))).not.toContain('Shards')
  })
})

// ── the tar reader itself ────────────────────────────────────────────────────

describe('unpacking', () => {
  test('directories carry no content worth keeping', () => {
    const entries = extractTarGz(
      gzip([{ path: 'src', contents: '', typeflag: '5' }, { path: 'src/main.ts', contents: 'export {}' }]),
    )
    expect(entries.map((entry) => entry.path)).toEqual(['src/main.ts'])
  })

  test('a path that would escape the project directory is refused', () => {
    expect(() => extractTarGz(gzip([{ path: '../../../etc/passwd', contents: 'root' }]))).toThrow(
      /outside the project directory/,
    )
  })

  test('a path still absolute after the top-level directory is removed is refused too', () => {
    // `repo-main//etc/passwd` strips to `/etc/passwd`, which is the shape that
    // gets past a check written only against the name as it appears.
    expect(() => extractTarGz(gzip([{ path: '/etc/passwd', contents: 'root' }]))).toThrow(
      /outside the project directory/,
    )
  })

  test('a Windows drive letter is refused', () => {
    expect(() => extractTarGz(gzip([{ path: 'C:/Windows/System32/drivers/etc/hosts', contents: 'x' }]))).toThrow(
      /outside the project directory/,
    )
  })

  test('an empty archive is a failure, not an empty project', () => {
    expect(() => extractTarGz(gzip([]))).toThrow(/not the one it was supposed to be/)
  })

  test('a file exactly one block long is not truncated', () => {
    const exact = 'x'.repeat(512)
    const entries = extractTarGz(gzip([{ path: 'a.txt', contents: exact }, { path: 'b.txt', contents: 'after' }]))
    expect(Buffer.from(entries[0]!.contents).toString('utf8')).toBe(exact)
    expect(Buffer.from(entries[1]!.contents).toString('utf8')).toBe('after')
  })

  test('symlinks and device nodes are dropped rather than recreated', () => {
    const entries = extractTarGz(
      gzip([{ path: 'link', contents: '', typeflag: '2' }, { path: 'real.ts', contents: 'export {}' }]),
    )
    expect(entries.map((entry) => entry.path)).toEqual(['real.ts'])
  })
})
