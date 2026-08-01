/**
 * Putting the files down, and refusing to when that would destroy something.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HarnessError } from '../src/errors.js'
import { projectFrom } from '../src/naming.js'
import { scaffold } from '../src/scaffold.js'
import { assertWritable, blockingEntries, writeFiles } from '../src/write.js'

const made: string[] = []

async function temp(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'create-kei-game-'))
  made.push(directory)
  return directory
}

afterEach(async () => {
  for (const directory of made.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('blockingEntries', () => {
  test('an empty directory is not in the way', () => {
    expect(blockingEntries([])).toEqual([])
  })

  test('a fresh git repository is not in the way', () => {
    expect(blockingEntries(['.git', '.DS_Store'])).toEqual([])
  })

  test('anything else is', () => {
    expect(blockingEntries(['.git', 'src', 'README.md'])).toEqual(['src', 'README.md'])
  })
})

describe('assertWritable', () => {
  test('a directory that does not exist is the easy case', async () => {
    const directory = join(await temp(), 'not-there-yet')
    expect(await assertWritable(directory, false)).toBeUndefined()
  })

  test('refuses to write over an existing project, and says how to insist', async () => {
    const directory = await temp()
    await writeFile(join(directory, 'README.md'), 'mine')

    await expect(assertWritable(directory, false)).rejects.toThrow(HarnessError)
    await expect(assertWritable(directory, false)).rejects.toThrow(/--force/)
  })

  test('--force insists', async () => {
    const directory = await temp()
    await writeFile(join(directory, 'README.md'), 'mine')

    expect(await assertWritable(directory, true)).toBeUndefined()
  })
})

describe('writeFiles', () => {
  test('writes the whole tree, subdirectories and all', async () => {
    const directory = join(await temp(), 'star-clicker')
    const project = projectFrom({ name: 'Star Clicker', currency: 'Gems' })
    const files = await scaffold(project, { sdkVersion: '^0.1.0' })

    await writeFiles(directory, files)

    expect(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).name).toBe('star-clicker')
    expect(await readFile(join(directory, 'src', 'economy.ts'), 'utf8')).toContain('Kei.start(')
    expect(await readFile(join(directory, 'server', 'game.ts'), 'utf8')).toContain('Kei.server(')
    expect(await readFile(join(directory, '.gitignore'), 'utf8')).toContain('node_modules/')
  })

  test('creates the project directory if it is not there', async () => {
    const directory = join(await temp(), 'deep', 'star-clicker')
    await writeFiles(directory, [{ path: 'a/b/c.txt', contents: 'here' }])

    expect(await readFile(join(directory, 'a', 'b', 'c.txt'), 'utf8')).toBe('here')
  })

  test('leaves what was already there when forced', async () => {
    const directory = await temp()
    await mkdir(join(directory, 'notes'), { recursive: true })
    await writeFile(join(directory, 'notes', 'keep.md'), 'keep me')

    await writeFiles(directory, [{ path: 'package.json', contents: '{}' }])

    expect(await readFile(join(directory, 'notes', 'keep.md'), 'utf8')).toBe('keep me')
  })
})
