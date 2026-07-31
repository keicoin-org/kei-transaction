/**
 * Templates in, files out. No disk is touched here.
 *
 * `scaffold()` returns what *would* be written, which is what makes the emitted
 * project testable: `test/scaffold.test.ts` reads every generated file, parses
 * the TypeScript ones, and checks that none of them import this package —
 * SPEC §11.3's test for whether the harness has quietly become a framework.
 *
 * The templates are ordinary files rather than strings in a module, so that
 * editing the generated game is editing a game, and a diff against
 * `examples/button` still reads as a diff.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, posix, sep } from 'node:path'

import type { GameProject } from './naming.js'

export interface GeneratedFile {
  /** Relative, POSIX-separated, and where it goes under the project directory. */
  path: string
  contents: string
}

export interface ScaffoldOptions {
  /** The `kei-transaction` range written into the generated `package.json`. */
  sdkVersion: string
  /** Overridable so tests can read templates from somewhere else. */
  templates?: string
}

/**
 * Resolves to `packages/create-kei-game/templates` from both `src/` and `dist/`,
 * which are the same depth. `files` in `package.json` ships it.
 */
export const TEMPLATE_ROOT = fileURLToPath(new URL('../templates/', import.meta.url))

/**
 * npm deletes a file called `.gitignore` from a published package and always
 * has, so it is shipped under a name npm will leave alone and renamed on the
 * way out. A generated project whose `node_modules` is not ignored is a bad
 * first commit.
 */
const RENAME_ON_WRITE: Readonly<Record<string, string>> = { gitignore: '.gitignore' }

export async function scaffold(project: GameProject, options: ScaffoldOptions): Promise<GeneratedFile[]> {
  const root = options.templates ?? TEMPLATE_ROOT
  const substitutions: Readonly<Record<string, string>> = {
    __PROJECT_TITLE__: project.title,
    __PROJECT_SLUG__: project.slug,
    __CURRENCY_NAME__: project.currency,
    __CURRENCY_SYMBOL__: project.symbol,
    __SDK_VERSION__: options.sdkVersion,
  }

  const files: GeneratedFile[] = []
  for (const relative of (await listFiles(root)).sort()) {
    const contents = await readFile(join(root, relative.split(posix.sep).join(sep)), 'utf8')
    files.push({ path: rename(relative), contents: substitute(contents, substitutions) })
  }
  return files
}

/** Every placeholder, everywhere. Unreplaced ones are a test failure, not a warning. */
function substitute(contents: string, substitutions: Readonly<Record<string, string>>): string {
  let result = contents
  for (const [token, value] of Object.entries(substitutions)) {
    result = result.split(token).join(value)
  }
  return result
}

function rename(relative: string): string {
  const slash = relative.lastIndexOf(posix.sep)
  const directory = slash === -1 ? '' : relative.slice(0, slash + 1)
  const name = relative.slice(slash + 1)
  return `${directory}${RENAME_ON_WRITE[name] ?? name}`
}

/** Hand-rolled rather than `readdir({ recursive: true })`, whose result shape moved between Node 20 releases. */
async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(join(root, prefix.split(posix.sep).join(sep)))) {
    const relative = prefix === '' ? entry : `${prefix}${posix.sep}${entry}`
    const info = await stat(join(root, relative.split(posix.sep).join(sep)))
    if (info.isDirectory()) found.push(...(await listFiles(root, relative)))
    else found.push(relative)
  }
  return found
}
