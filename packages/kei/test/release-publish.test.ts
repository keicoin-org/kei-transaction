import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const workspace = resolve(import.meta.dir, '../../..')
const packageDirectories = [
  'core',
  'work',
  'claims',
  'tokens',
  'market',
  'wallet',
  'economy',
  'player-economy',
  'kei',
]

// Bun 1.3.0 applies this file default to hooks; its runtime does not yet accept
// the per-hook timeout argument described by the newer installed type package.
// Each test below retains its tighter explicit 30-second budget.
setDefaultTimeout(60_000)

function shellPath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized)
  return drive ? `/${drive[1]!.toLowerCase()}/${drive[2]}` : normalized
}

function findShell(): string {
  if (process.platform !== 'win32') return 'sh'
  return join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'sh.exe')
}

async function run(
  command: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number; output: string }> {
  const processHandle = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...env },
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])
  return { exitCode, output: stdout + stderr }
}

async function git(cwd: string, ...arguments_: string[]): Promise<void> {
  const result = await run(['git', ...arguments_], cwd)
  expect(result.exitCode, result.output).toBe(0)
}

describe('publish shell safety gate', () => {
  let root: string
  let seed: string
  let repository: string
  let remote: string
  let log: string
  let shell: string

  // This fixture creates, clones, and pushes local Git repositories. Windows
  // runners can exceed Bun's independent five-second hook default under load,
  // so budget the hooks themselves rather than masking it with test timeouts.
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'kei-publish-'))
    seed = join(root, 'seed')
    repository = join(root, 'repository')
    remote = join(root, 'remote.git')
    log = join(root, 'npm.log')
    shell = findShell()

    await mkdir(join(seed, 'scripts'), { recursive: true })
    await mkdir(join(seed, 'mock-bin'), { recursive: true })
    for (const directory of packageDirectories) {
      await mkdir(join(seed, 'packages', directory), { recursive: true })
      await writeFile(join(seed, 'packages', directory, 'package.json'), '{}\n')
    }
    await cp(join(workspace, 'scripts', 'publish.sh'), join(seed, 'scripts', 'publish.sh'))
    await writeFile(join(seed, 'bun.lock'), 'mock lock\n')

const npmMock = `#!/bin/sh
printf '%s\\n' "$*" >> "$PUBLISH_TEST_LOG"
case "\${1:-} \${2:-}" in
  "pack --json") printf '%s\\n' '[]' ;;
  "install --prefix") exit 0 ;;
  "whoami ") [ "\${PUBLISH_TEST_WHOAMI_FAIL:-0}" -eq 0 ] && printf '%s\\n' 'release-test-user' || exit 1 ;;
  "view "*)
    if [ -z "\${PUBLISH_TEST_REGISTRY_INTEGRITY:-}" ]; then
      printf '%s\\n' 'npm error code E404' >&2
      exit 1
    fi
    case "\${3:-}" in
      version) printf '%s\\n' '"9.9.9"' ;;
      dist.integrity) printf '"%s"\\n' "$PUBLISH_TEST_REGISTRY_INTEGRITY" ;;
      *) exit 2 ;;
    esac
    ;;
esac
exit 0
`
    const nodeMock = `#!/bin/sh
case "\${1:-}" in
  -p)
    case "\${2:-}" in
      *publishConfig*) printf '%s\\n' public ;;
      *.version*) printf '%s\\n' 9.9.9 ;;
      *) printf '%s\\n' mock-package ;;
    esac
    ;;
  -e) exec "$PUBLISH_TEST_REAL_NODE" "$@" ;;
  *)
    case "$*" in
      *--field=filename*) printf '%s' 'mock-package-9.9.9.tgz' ;;
      *--field=integrity*) printf '%s' 'sha512-release-test' ;;
      *) cat >/dev/null ;;
    esac
    ;;
esac
exit 0
`
    await writeFile(join(seed, 'mock-bin', 'npm'), npmMock)
    await writeFile(join(seed, 'mock-bin', 'node'), nodeMock)
    await writeFile(join(seed, 'mock-bin', 'bun'), '#!/bin/sh\nexit 0\n')
    await Promise.all(
      ['npm', 'node', 'bun'].map((name) => chmod(join(seed, 'mock-bin', name), 0o755)),
    )

    await git(root, 'init', '--bare', '--initial-branch=master', remote)
    await git(seed, 'init', '--initial-branch=master')
    await git(seed, 'config', 'user.email', 'release-test@keicoin.org')
    await git(seed, 'config', 'user.name', 'Release Test')
    await git(seed, 'add', '.')
    await git(seed, 'commit', '-m', 'release fixture')
    await git(seed, 'remote', 'add', 'origin', remote)
    await git(seed, 'push', '-u', 'origin', 'master')
    await git(root, 'clone', remote, repository)
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function publish(environment: Record<string, string> = {}, arguments_ = '') {
    await writeFile(log, '')
    const command = `PATH="$PWD/mock-bin:$PATH" PUBLISH_TEST_LOG="${shellPath(log)}" PUBLISH_TEST_REAL_NODE="${shellPath(process.execPath)}" sh scripts/publish.sh ${arguments_}`
    return run([shell, '-c', command], repository, environment)
  }

  async function npmCalls(): Promise<string> {
    return readFile(log, 'utf8')
  }

  test('refuses release branches and detached or stale default-branch commits before npm', async () => {
    await git(repository, 'switch', '-c', 'release/0.7.0')
    let result = await publish()
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain("publication requires the default branch 'master'")
    expect(await npmCalls()).toBe('')

    result = await publish({}, '--check')
    expect(result.exitCode, result.output).toBe(0)
    expect(result.output).toContain('Preflight passed. Nothing was published.')
    expect(await npmCalls()).not.toContain('whoami')
    expect(await npmCalls()).not.toContain('publish')

    await git(repository, 'switch', '--detach', 'HEAD')
    result = await publish()
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('not a detached HEAD')
    expect(await npmCalls()).toBe('')

    await git(repository, 'switch', 'master')
    await writeFile(join(seed, 'advanced.txt'), 'new remote commit\n')
    await git(seed, 'add', 'advanced.txt')
    await git(seed, 'commit', '-m', 'advance default branch')
    await git(seed, 'push', 'origin', 'master')

    result = await publish()
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('must exactly match the freshly fetched origin/master')
    expect(await npmCalls()).toBe('')
  }, 60_000)

  test('authenticates before publishing from the exact fetched default-branch commit', async () => {
    await git(repository, 'merge', '--ff-only', 'origin/master')

    let result = await publish({ PUBLISH_TEST_WHOAMI_FAIL: '1' })
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('npm authentication is required')
    expect(await npmCalls()).toContain('whoami')
    expect(await npmCalls()).not.toContain('publish')

    result = await publish()
    expect(result.exitCode, result.output).toBe(0)
    const calls = (await npmCalls()).trim().split('\n')
    const whoami = calls.indexOf('whoami')
    const firstPublish = calls.findIndex((call) => call.startsWith('publish'))
    expect(whoami).toBeGreaterThanOrEqual(0)
    expect(firstPublish).toBeGreaterThan(whoami)
  }, 60_000)

  test('skips only a registry artifact with the same reviewed integrity', async () => {
    let result = await publish({ PUBLISH_TEST_REGISTRY_INTEGRITY: 'sha512-different' })
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('exists with different tarball integrity')
    expect(await npmCalls()).not.toContain('publish')

    result = await publish({ PUBLISH_TEST_REGISTRY_INTEGRITY: 'sha512-release-test' })
    expect(result.exitCode, result.output).toBe(0)
    expect(result.output).toContain('artifact matches; skipping')
    expect(await npmCalls()).not.toContain('publish')
  }, 60_000)
})
