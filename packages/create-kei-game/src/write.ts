/**
 * Putting the files down, and refusing to when that would destroy something.
 *
 * A scaffolder that overwrites is a scaffolder nobody runs twice, so a directory
 * with anything in it stops this unless `--force` says otherwise. `.git` does
 * not count: creating an empty repository and scaffolding into it is a normal
 * order to do things in.
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, posix, sep } from 'node:path'

import { fail } from './errors.js'
import type { GeneratedFile } from './scaffold.js'

/** Present in an otherwise empty directory, and not worth stopping for. */
export const IGNORED_WHEN_EMPTY: ReadonlySet<string> = new Set(['.git', '.gitkeep', '.DS_Store', 'Thumbs.db'])

/** What is in the way. Separated from the filesystem so the rule can be tested. */
export function blockingEntries(entries: readonly string[]): string[] {
  return entries.filter((entry) => !IGNORED_WHEN_EMPTY.has(entry))
}

export async function assertWritable(directory: string, force: boolean): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return // Does not exist yet, which is the usual case and the easy one.
  }

  const blocking = blockingEntries(entries)
  if (blocking.length === 0 || force) return

  const sample = blocking.slice(0, 3).join(', ')
  const rest = blocking.length > 3 ? `, and ${blocking.length - 3} more` : ''
  fail(
    `${directory} already has files in it (${sample}${rest}). Pick a different name, or pass --force to write into it anyway.`,
  )
}

export async function writeFiles(directory: string, files: readonly GeneratedFile[]): Promise<void> {
  for (const file of files) {
    const target = join(directory, file.path.split(posix.sep).join(sep))
    await mkdir(dirname(target), { recursive: true })
    // Bytes are written as bytes. Passing an encoding alongside a Uint8Array
    // would be ignored here and misleading to read, and a `.glb` that has been
    // through a utf8 round trip is a corrupt `.glb`.
    if (typeof file.contents === 'string') await writeFile(target, file.contents, 'utf8')
    else await writeFile(target, file.contents)
  }
}
