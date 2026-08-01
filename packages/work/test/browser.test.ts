/**
 * `@keicoin/work`'s package root is reachable from a game's browser bundle
 * (`kei-transaction` re-exports it), so it must never import `node:http` —
 * there is no browser polyfill for `createServer`, and bundling would fail
 * with exactly the error asserted below. The listener lives behind the
 * separate `@keicoin/work/server` entry point instead, which is server-only on
 * purpose and must keep failing a browser build for the same reason.
 *
 * These shell out to the real `bun build` CLI (what Button's own `build`
 * script runs — see `button/package.json`) rather than calling the in-process
 * `Bun.build()` API. In-process bundling shares its module-resolution cache
 * with everything else running in this test process, and under this suite's
 * concurrency that occasionally surfaces a transient EISDIR/ENOENT reading an
 * unrelated file inside @bananocoin/bananojs (a transitive dependency of
 * @keicoin/core) — a Bun/Windows cache artifact, not anything this package
 * does. A subprocess gets its own cache and reproduces what a real build
 * actually sees.
 *
 * Note on what these tests do *not* assert: `@keicoin/core` depends on
 * `@bananocoin/bananojs`, which itself references `node:https` for its own
 * transport. Bun's browser polyfill for that pulls in an inert, never-called
 * `createServer` stub as dead code, so the bundled *output* legitimately
 * contains the substrings `node:https` and `node:http` regardless of anything
 * this package does. Asserting the output is textually free of those strings
 * would fail on that unrelated bananojs noise rather than on the thing M4
 * actually broke. The signal that matters is whether the build *succeeds*,
 * and, for the server entry, that it fails on `node:http` specifically.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const packageRoot = resolve(import.meta.dir, '..')

async function buildForBrowser(entrypoint: string): Promise<{ exitCode: number; output: string }> {
  const outdir = await mkdtemp(join(tmpdir(), 'kei-work-browser-build-'))
  try {
    const proc = Bun.spawn(['bun', 'build', entrypoint, '--target', 'browser', '--outdir', outdir], {
      cwd: packageRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, output: `${stdout}\n${stderr}` }
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }
}

describe('@keicoin/work browser bundling (SPEC §6.3, M4)', () => {
  test('the package root bundles for a browser target', async () => {
    const { exitCode } = await buildForBrowser(resolve(packageRoot, 'src/index.ts'))
    expect(exitCode).toBe(0)
  }, 30_000)

  test('the /server entry refuses to bundle for a browser target, and refuses on node:http', async () => {
    const { exitCode, output } = await buildForBrowser(resolve(packageRoot, 'src/server.ts'))
    expect(exitCode).not.toBe(0)
    expect(output).toContain('node:http')
    expect(output).toContain('createServer')
  }, 30_000)
})
