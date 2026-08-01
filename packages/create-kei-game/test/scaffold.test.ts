/**
 * What comes out, and the one property SPEC §11.3 makes a test:
 *
 *   "if deleting the harness from the machine breaks the generated game, it has
 *    become a framework and must be redesigned"
 *
 * So the generated project is read the way a bundler would read it — every
 * import of every file — and nothing may point back here.
 */

import { describe, expect, test } from 'bun:test'

import { projectFrom } from '../src/naming.js'
import { scaffold, type GeneratedFile } from '../src/scaffold.js'

const project = projectFrom({ name: 'Star Clicker', currency: 'Gold Pieces' })
const files = await scaffold(project, { sdkVersion: '^0.1.0' })

const at = (path: string): GeneratedFile => {
  const file = files.find((candidate) => candidate.path === path)
  if (!file) throw new Error(`${path} was not generated. Generated: ${files.map((f) => f.path).join(', ')}`)
  return file
}

const sources = files.filter((file) => file.path.endsWith('.ts'))
const manifest = JSON.parse(at('package.json').contents) as {
  name: string
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  scripts: Record<string, string>
}

describe('what it writes', () => {
  test('a runnable project, not a fragment', () => {
    expect(files.map((file) => file.path).sort()).toEqual([
      '.gitignore',
      'README.md',
      'index.html',
      'package.json',
      'server/game.ts',
      'server/main.ts',
      'server/orders.ts',
      'shared/game.ts',
      'src/economy.ts',
      'src/main.ts',
      'src/world.ts',
      'tsconfig.json',
    ])
  })

  test('nothing is empty', () => {
    for (const file of files) expect(file.contents.trim().length).toBeGreaterThan(0)
  })

  /** npm strips a published `.gitignore`, so it ships under another name. */
  test('the ignore file arrives named correctly and covers node_modules', () => {
    expect(at('.gitignore').contents).toContain('node_modules/')
    expect(files.some((file) => file.path === 'gitignore')).toBe(false)
  })
})

describe('the two answers reach every corner', () => {
  test('no placeholder survives', () => {
    for (const file of files) {
      expect(file.contents).not.toMatch(/__[A-Z][A-Z_]*__/)
    }
  })

  test('the project name names the package, the page, and the README', () => {
    expect(manifest.name).toBe('star-clicker')
    expect(at('index.html').contents).toContain('<title>Star Clicker</title>')
    expect(at('README.md').contents).toContain('# Star Clicker')
    expect(at('server/main.ts').contents).toContain('Star Clicker')
  })

  test('the currency and its derived ticker land in the price list', () => {
    const shared = at('shared/game.ts').contents
    expect(shared).toContain("name: 'Gold Pieces'")
    expect(shared).toContain("symbol: 'GOLD'")
  })

  test('the SDK version it was built alongside is the one it asks for', () => {
    expect(manifest.dependencies['kei-transaction']).toBe('^0.1.0')
  })
})

describe('it is a scaffolder, not a framework (SPEC §11.3)', () => {
  test('nothing generated depends on create-kei-game', () => {
    // The README is allowed to name the tool that wrote it — it says the game
    // survives deleting it, which is this same property in prose. Code and
    // manifests are not allowed to mention it at all.
    const mentions = files
      .filter((file) => !file.path.endsWith('.md'))
      .filter((file) => file.contents.includes('create-kei-game'))
      .map((file) => file.path)

    expect(mentions).toEqual([])
    expect(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })).not.toContain('create-kei-game')
  })

  test('the generated project depends on the SDK and a renderer, and nothing else', () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['@babylonjs/core', 'kei-transaction'])
  })

  test('every import resolves to a declared dependency or a file in the project', () => {
    const declared = new Set([...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)])
    const transpiler = new Bun.Transpiler({ loader: 'ts' })
    const undeclared: string[] = []

    for (const file of sources) {
      for (const imported of transpiler.scanImports(file.contents)) {
        if (imported.path.startsWith('.') || imported.path.startsWith('node:') || imported.path === 'bun') continue
        const [scope = '', name = ''] = imported.path.split('/')
        const packageName = scope.startsWith('@') ? `${scope}/${name}` : scope
        if (!declared.has(packageName)) undeclared.push(`${file.path} → ${imported.path}`)
      }
    }

    expect(undeclared).toEqual([])
  })
})

describe('the generated sources are sources', () => {
  test('every TypeScript file parses', () => {
    const transpiler = new Bun.Transpiler({ loader: 'ts' })
    for (const file of sources) {
      expect(() => transpiler.transformSync(file.contents)).not.toThrow()
    }
  })

  test('it can be run without reading anything else', () => {
    expect(manifest.scripts.dev).toBe('bun run server/main.ts')
    expect(at('README.md').contents).toContain('bun run dev')
  })

  /** SPEC §11.3: the harness picks the renderer and documents how to replace it. */
  test('the README says how to swap the renderer and how to add Colyseus', () => {
    const readme = at('README.md').contents
    expect(readme).toContain('Replace the renderer')
    expect(readme).toContain('Colyseus')
    expect(readme).toMatch(/never be the source of truth|must never own money|Do not let it own money/)
  })
})

describe('the shape of the game itself', () => {
  test('the issuer seed stays on the server', () => {
    expect(at('server/game.ts').contents).toContain('Kei.server(')
    expect(at('src/economy.ts').contents).toContain('Kei.start(')
    expect(at('src/economy.ts').contents).not.toContain('Kei.server(')
  })

  test('it exercises a currency, an item, and a payment', () => {
    const game = at('server/game.ts').contents
    expect(game).toContain('kei.token.issue(')
    expect(game).toContain('kei.items.create(')
    expect(game).toContain('kei.items.mint(')
    expect(game).toContain('.commit(')
    expect(at('src/economy.ts').contents).toContain('kei.pay(')

    // Watching for payments lives in `server/orders.ts` rather than next to the
    // delivery, because what a payment arriving means is "file this hash", and
    // what it is answered with has to be written down before it is answered.
    expect(at('server/orders.ts').contents).toContain('kei.onPayment(')
  })

  test('the renderer knows nothing about Kei', () => {
    const world = at('src/world.ts').contents
    expect(world).not.toContain('kei-transaction')
    expect(world).not.toContain('Kei.start')
  })
})
