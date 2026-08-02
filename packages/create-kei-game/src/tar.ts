/**
 * Enough of tar to unpack one GitHub tarball, and nothing else.
 *
 * This package installs nothing of its own (SPEC §11.3, and the README says so
 * out loud), which rules out `tar` and every wrapper around it. What it needs is
 * the read half of one archive format whose layout has not changed since 1988:
 * 512-byte headers, octal sizes, data padded to the next block. `node:zlib`
 * already does the gzip.
 *
 * Deliberately not a general tar library. It reads regular files and ignores
 * everything else, because a scaffolder that restores symlinks, device nodes, or
 * setuid bits out of a downloaded archive is a scaffolder with a security
 * advisory in its future.
 */

import { gunzipSync } from 'node:zlib'

const BLOCK = 512

/** Where each field the reader cares about sits in the header block. */
const NAME = { at: 0, length: 100 }
const SIZE = { at: 124, length: 12 }
const TYPEFLAG = { at: 156, length: 1 }
const PREFIX = { at: 345, length: 155 }

export interface TarEntry {
  /** POSIX-separated, and already stripped of the archive's top-level directory. */
  path: string
  contents: Uint8Array
}

/**
 * Regular files only. `'0'` is the modern spelling and `'\0'` the historical
 * one; `'5'` is a directory, which carries no data worth keeping when every
 * parent gets created on write anyway.
 */
function isRegularFile(typeflag: string): boolean {
  return typeflag === '0' || typeflag === '\0' || typeflag === ''
}

/**
 * GitHub wraps the repository in one directory named for the ref
 * (`world-of-wonder-main/`), which nobody wants in their project. This is
 * `tar --strip-components=1`.
 */
function stripLeadingComponent(path: string): string | undefined {
  const slash = path.indexOf('/')
  if (slash === -1) return undefined
  const rest = path.slice(slash + 1)
  return rest === '' ? undefined : rest
}

function readString(block: Uint8Array, field: { at: number; length: number }): string {
  const raw = block.subarray(field.at, field.at + field.length)
  const end = raw.indexOf(0)
  return Buffer.from(end === -1 ? raw : raw.subarray(0, end)).toString('utf8')
}

/**
 * Sizes are octal text, space- or NUL-padded. GNU's base-256 extension for files
 * over 8GB is not handled: nothing in a game template is 8GB, and guessing wrong
 * about which encoding is in use is worse than saying so.
 */
function readSize(block: Uint8Array): number {
  const text = readString(block, SIZE).trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) {
    throw new Error(`this archive states a file size ("${text}") in a format this cannot read`)
  }
  return Number.parseInt(text, 8)
}

/** A header of all zeroes is the end-of-archive marker. */
function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0)
}

/**
 * The `path` record out of a pax extended header, which is how both git and GNU
 * tar carry a name too long for the 100-byte field. Records are
 * `"<length> <key>=<value>\n"`.
 */
function paxPath(contents: Uint8Array): string | undefined {
  for (const record of Buffer.from(contents).toString('utf8').split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(record)
    if (match) return match[1]
  }
  return undefined
}

/**
 * Unpacks a `.tar.gz` into its regular files, with the top-level directory
 * removed.
 *
 * Paths are checked rather than trusted. An archive that names `../../etc` or an
 * absolute path is refused outright — this content arrives over the network, and
 * "extract wherever the archive says" is how a scaffolder writes outside the
 * directory the developer asked for.
 */
export function extractTarGz(gzipped: Uint8Array): TarEntry[] {
  const tar = new Uint8Array(gunzipSync(gzipped))
  const entries: TarEntry[] = []

  /** Set by a pax or GNU long-name header, and consumed by the entry after it. */
  let overrideName: string | undefined

  let offset = 0
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (isZeroBlock(header)) break
    offset += BLOCK

    const size = readSize(header)
    const data = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / BLOCK) * BLOCK

    const typeflag = readString(header, TYPEFLAG)

    // 'x' and 'g' are pax headers, 'L' is GNU's older long-name entry. All three
    // describe the *next* entry rather than being one.
    if (typeflag === 'x' || typeflag === 'g') {
      overrideName = paxPath(data) ?? overrideName
      continue
    }
    if (typeflag === 'L') {
      overrideName = Buffer.from(data).toString('utf8').replace(/\0+$/, '')
      continue
    }

    const prefix = readString(header, PREFIX)
    const name = readString(header, NAME)
    const full = overrideName ?? (prefix === '' ? name : `${prefix}/${name}`)
    overrideName = undefined

    if (!isRegularFile(typeflag)) continue

    const path = stripLeadingComponent(full)
    if (path === undefined) continue
    assertContained(path)

    entries.push({ path, contents: data.slice() })
  }

  if (entries.length === 0) {
    throw new Error('this archive holds no files, which means it is not the one it was supposed to be')
  }
  return entries
}

/** Refuses anything that would escape the project directory. */
function assertContained(path: string): void {
  const escapes =
    path.startsWith('/') ||
    /^[a-zA-Z]:/.test(path) ||
    path.split('/').includes('..') ||
    path.includes('\0') ||
    path.includes('\\')

  if (escapes) {
    throw new Error(`this archive contains a path that would write outside the project directory ("${path}")`)
  }
}
