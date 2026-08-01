/**
 * `kei-transaction` is what a game actually installs and bundles — Button
 * (`../../button`) builds it straight into the browser with `bun build
 * src/main.ts --target browser` (see `button/package.json`'s `build` script).
 * Before the M4 packaging fix, `@keicoin/work`'s package root imported
 * `node:http` for its server listener, so any game that pulled in the work
 * client (via `kei-transaction`'s re-export) dragged a Node-only module with
 * no browser polyfill for `createServer` into its browser bundle, and the
 * build failed outright. This pins the umbrella package to a successful
 * browser build so that regression cannot come back unnoticed.
 *
 * This shells out to the real `bun build` CLI rather than the in-process
 * `Bun.build()` API — see packages/work/test/browser.test.ts for why: the
 * in-process API shares a module-resolution cache with the rest of this test
 * run, which occasionally trips a transient EISDIR/ENOENT reading an
 * unrelated @bananocoin/bananojs file under this suite's concurrency. A
 * subprocess gets its own cache and reproduces what a real build actually
 * sees.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const packageRoot = resolve(import.meta.dir, '..')

describe('kei-transaction browser bundling (M4)', () => {
  test('bundles for a browser target', async () => {
    const outdir = await mkdtemp(join(tmpdir(), 'kei-transaction-browser-build-'))
    try {
      const proc = Bun.spawn(
        ['bun', 'build', resolve(packageRoot, 'src/index.ts'), '--target', 'browser', '--outdir', outdir],
        { cwd: packageRoot, stdout: 'pipe', stderr: 'pipe' },
      )
      const exitCode = await proc.exited
      expect(exitCode).toBe(0)
    } finally {
      await rm(outdir, { recursive: true, force: true })
    }
  }, 30_000)
})
