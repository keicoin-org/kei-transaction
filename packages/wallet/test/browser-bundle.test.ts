/**
 * `@keicoin/wallet` is reachable from a game's browser bundle (`kei-transaction`
 * re-exports it), and M6 adds the one thing in this package that actually
 * touches a DOM: `WalletPanel`. It must keep bundling for a browser target —
 * `mount()` only reaches for `document`/`Element` inside function bodies, never
 * at module scope, so nothing here should need a Node-only polyfill.
 *
 * This shells out to the real `bun build` CLI rather than the in-process
 * `Bun.build()` API for the same reason packages/kei/test/browser-bundle.test.ts
 * and packages/work/test/browser.test.ts do: the in-process API shares a
 * module-resolution cache with the rest of this test run, which occasionally
 * trips a transient EISDIR/ENOENT reading an unrelated file under this suite's
 * concurrency. A subprocess gets its own cache and reproduces what a real
 * build actually sees.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const packageRoot = resolve(import.meta.dir, '..')

describe('@keicoin/wallet browser bundling (M6)', () => {
  test('bundles for a browser target', async () => {
    const outdir = await mkdtemp(join(tmpdir(), 'kei-wallet-browser-build-'))
    try {
      const proc = Bun.spawn(
        ['bun', 'build', resolve(packageRoot, 'src/index.ts'), '--target', 'browser', '--outdir', outdir],
        { cwd: packageRoot, stdout: 'pipe', stderr: 'pipe' },
      )
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
    } finally {
      await rm(outdir, { recursive: true, force: true })
    }
  }, 30_000)
})
