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
// Each test below also keeps an explicit 60-second bound.
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
case "\${1:-}" in
  pack) printf '%s\\n' '[]' ;;
  install) exit 0 ;;
  test)
    # 'npm test' sits between the two live-release gates, so these hooks let a
    # fixture deterministically race the preflight: advance the bare remote's
    # default branch, or mutate the worktree, exactly while the checks run.
    if [ -n "\${PUBLISH_TEST_ADVANCE_REMOTE_FROM:-}" ]; then
      git -C "$PUBLISH_TEST_ADVANCE_REMOTE_FROM" commit --quiet --allow-empty -m 'advance during preflight'
      git -C "$PUBLISH_TEST_ADVANCE_REMOTE_FROM" push --quiet origin master
    fi
    if [ -n "\${PUBLISH_TEST_MUTATE_WORKTREE_FILE:-}" ]; then
      printf '%s\\n' 'mutation during preflight' >> "$PUBLISH_TEST_MUTATE_WORKTREE_FILE"
    fi
    ;;
  whoami) [ "\${PUBLISH_TEST_WHOAMI_FAIL:-0}" -eq 0 ] && printf '%s\\n' 'release-test-user' || exit 1 ;;
  view)
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
      *publishConfig*registry*) printf '%s\\n' "\${PUBLISH_TEST_MANIFEST_REGISTRY:-}" ;;
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
    const whoami = calls.findIndex((call) => call.startsWith('whoami'))
    const firstPublish = calls.findIndex((call) => call.startsWith('publish'))
    expect(whoami).toBeGreaterThanOrEqual(0)
    expect(firstPublish).toBeGreaterThan(whoami)
  }, 60_000)

  test('refuses a default branch that advanced during preflight, before whoami or publish', async () => {
    const result = await publish({ PUBLISH_TEST_ADVANCE_REMOTE_FROM: shellPath(seed) })
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('must exactly match the freshly fetched origin/master')
    expect(result.output).toContain('immediately before publication')
    const calls = await npmCalls()
    expect(calls).not.toContain('whoami')
    expect(calls).not.toContain('publish')

    // The refusal is the point; catch the clone back up for the tests after it.
    await git(repository, 'fetch', 'origin')
    await git(repository, 'merge', '--ff-only', 'origin/master')
  }, 60_000)

  test('refuses tracked and untracked mutations created during preflight, before whoami or publish', async () => {
    const untracked = join(repository, 'mutation-during-preflight.txt')
    let result = await publish({ PUBLISH_TEST_MUTATE_WORKTREE_FILE: shellPath(untracked) })
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('worktree must be clean immediately before publication')
    let calls = await npmCalls()
    expect(calls).not.toContain('whoami')
    expect(calls).not.toContain('publish')
    await rm(untracked)

    const tracked = join(repository, 'bun.lock')
    result = await publish({ PUBLISH_TEST_MUTATE_WORKTREE_FILE: shellPath(tracked) })
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('worktree must be clean immediately before publication')
    calls = await npmCalls()
    expect(calls).not.toContain('whoami')
    expect(calls).not.toContain('publish')
    await git(repository, 'checkout', '--', 'bun.lock')
  }, 60_000)

  test('pins every live registry operation to the public npm registry despite ambient config', async () => {
    // The redirect attempt below is ambient npm configuration; the script must
    // hand each live command the reviewed target explicitly, which outranks it.
    const result = await publish({
      npm_config_registry: 'https://registry.attacker.invalid/',
      'npm_config_@keicoin:registry': 'https://scoped-registry.attacker.invalid/',
    })
    expect(result.exitCode, result.output).toBe(0)
    const calls = (await npmCalls()).trim().split('\n')
    const live = calls.filter(
      (call) =>
        call.startsWith('whoami') || call.startsWith('view') || call.startsWith('publish'),
    )
    expect(live.length).toBeGreaterThanOrEqual(1 + 2 * packageDirectories.length)
    for (const call of live) {
      expect(call).toContain('--registry=https://registry.npmjs.org/')
      expect(call).toContain('--@keicoin:registry=https://registry.npmjs.org/')
    }
    expect(result.output).not.toContain('registry.attacker.invalid')
    expect(result.output).not.toContain('scoped-registry.attacker.invalid')

    const redirected = await publish({
      PUBLISH_TEST_MANIFEST_REGISTRY: 'https://registry.attacker.invalid/',
    })
    expect(redirected.exitCode).not.toBe(0)
    expect(redirected.output).toContain('is not the pinned public registry')
    const redirectedCalls = await npmCalls()
    expect(redirectedCalls).not.toContain('whoami')
    expect(redirectedCalls).not.toContain('publish')
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
