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

const DEFAULT_CHILD_TIMEOUT_MS = 30_000
const MAX_CAPTURED_OUTPUT = 64 * 1024
const CLEANUP_GRACE_MS = 500

type RunOptions = {
  ownedPidFiles?: string[]
  signal?: AbortSignal
  timeoutMs?: number
}

class FixtureProcessError extends Error {
  readonly kind: 'aborted' | 'timeout'

  constructor(kind: 'aborted' | 'timeout', timeoutMs: number, output: string) {
    const redactedOutput = redactSecrets(output)
    const lastStage = [...redactedOutput.matchAll(/^==>\s+.+$/gm)].at(-1)?.[0]
    const reason = kind === 'timeout' ? `timed out after ${timeoutMs}ms` : 'was aborted'
    super(
      `release fixture ${reason}; last stage: ${lastStage ?? '(no stage marker)'}\n` +
        `bounded output tail:\n${redactedOutput || '(no output)'}`,
    )
    this.name = 'FixtureProcessError'
    this.kind = kind
  }
}

function redactSecrets(output: string): string {
  return output
    .replace(/(--otp(?:=|\s+))\S+/gi, '$1[REDACTED]')
    .replace(/((?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_OTP)\s*=\s*)\S+/gi, '$1[REDACTED]')
    .replace(/\bnpm_[A-Za-z0-9]{16,}\b/g, '[REDACTED_NPM_TOKEN]')
}

function appendBounded(tail: { value: string }, chunk: string): void {
  tail.value = (tail.value + chunk).slice(-MAX_CAPTURED_OUTPUT)
}

function captureStream(stream: ReadableStream<Uint8Array>, tail: { value: string }) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const finished = (async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      appendBounded(tail, decoder.decode(value, { stream: true }))
    }
    appendBounded(tail, decoder.decode())
  })()
  return {
    cancel: () => reader.cancel().catch(() => undefined),
    finished,
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  do {
    if (predicate()) return true
    await delay(20)
  } while (Date.now() < deadline)
  return predicate()
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function terminateWindowsTree(pid: number): Promise<void> {
  const killer = Bun.spawn(['taskkill.exe', '/PID', String(pid), '/T', '/F'], {
    stderr: 'ignore',
    stdin: null,
    stdout: 'ignore',
  })
  const completed = await Promise.race([
    killer.exited.then(() => true),
    delay(5_000).then(() => false),
  ])
  if (!completed) {
    killer.kill()
    await Promise.race([killer.exited, delay(1_000)])
    throw new Error(`taskkill did not settle for owned fixture root PID ${pid}`)
  }
}

async function terminateOwnedProcessTree(
  processHandle: Bun.Subprocess<null, 'pipe', 'pipe'>,
  additionalOwnedPids: number[],
): Promise<void> {
  const pid = processHandle.pid
  if (process.platform === 'win32') {
    await terminateWindowsTree(pid)
  } else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    if (!(await waitUntil(() => !processGroupExists(pid), CLEANUP_GRACE_MS))) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  }

  const reaped = await Promise.race([
    processHandle.exited.then(() => true),
    delay(2_000).then(() => false),
  ])
  if (!reaped) {
    processHandle.kill('SIGKILL')
    if (
      !(await Promise.race([
        processHandle.exited.then(() => true),
        delay(1_000).then(() => false),
      ]))
    ) {
      throw new Error(`could not reap owned fixture root PID ${pid}`)
    }
  }

  if (process.platform !== 'win32') {
    const groupExited = await waitUntil(() => !processGroupExists(pid), 1_000)
    if (!groupExited) throw new Error(`owned fixture process group ${pid} survived cleanup`)
  }

  for (const ownedPid of additionalOwnedPids) {
    if (!processExists(ownedPid)) continue
    if (process.platform === 'win32') await terminateWindowsTree(ownedPid)
    else process.kill(ownedPid, 'SIGKILL')
  }
}

async function readOwnedPids(paths: string[] = []): Promise<number[]> {
  const pids: number[] = []
  for (const path of paths) {
    if (!(await Bun.file(path).exists())) continue
    const pid = Number(await readFile(path, 'utf8'))
    if (Number.isSafeInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid)
  }
  return pids
}

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
  options: RunOptions = {},
): Promise<{ exitCode: number; output: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS
  const processHandle = Bun.spawn(command, {
    cwd,
    detached: true,
    env: { ...process.env, ...env },
    stderr: 'pipe',
    stdin: null,
    stdout: 'pipe',
  })
  const output = { value: '' }
  const stdout = captureStream(processHandle.stdout, output)
  const stderr = captureStream(processHandle.stderr, output)

  let timeout: ReturnType<typeof setTimeout> | undefined
  let abortHandler: (() => void) | undefined
  const interrupted = new Promise<'aborted' | 'timeout'>((resolveInterruption) => {
    timeout = setTimeout(() => resolveInterruption('timeout'), timeoutMs)
    abortHandler = () => resolveInterruption('aborted')
    if (options.signal?.aborted) abortHandler()
    else options.signal?.addEventListener('abort', abortHandler, { once: true })
  })

  const completed = Promise.all([
    processHandle.exited,
    stdout.finished,
    stderr.finished,
  ]).then(([exitCode]) => ({ exitCode, kind: 'exit' as const }))
  const outcome = await Promise.race([
    completed,
    interrupted.then((kind) => ({ kind })),
  ])
  if (timeout) clearTimeout(timeout)
  if (abortHandler) options.signal?.removeEventListener('abort', abortHandler)

  if (outcome.kind === 'exit') {
    return { exitCode: outcome.exitCode, output: output.value }
  }

  let cleanupFailure: unknown
  try {
    const additionalOwnedPids = await readOwnedPids(options.ownedPidFiles)
    await terminateOwnedProcessTree(processHandle, additionalOwnedPids)
  } catch (error) {
    cleanupFailure = error
  }
  const streamsDrained = await Promise.race([
    Promise.allSettled([stdout.finished, stderr.finished]).then(() => true),
    delay(1_000).then(() => false),
  ])
  if (!streamsDrained) await Promise.all([stdout.cancel(), stderr.cancel()])
  if (cleanupFailure) {
    const cleanupMessage =
      cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)
    appendBounded(
      output,
      `\nfixture cleanup also failed: ${cleanupMessage}`,
    )
  }
  throw new FixtureProcessError(outcome.kind, timeoutMs, output.value)
}

async function git(cwd: string, ...arguments_: string[]): Promise<void> {
  const result = await run(['git', ...arguments_], cwd)
  expect(result.exitCode, result.output).toBe(0)
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

describe('release fixture process lifetime', () => {
  test('supplies EOF to a child instead of inheriting the test runner stdin', async () => {
    const result = await run(
      [findShell(), '-c', "cat >/dev/null; printf '%s\\n' 'stdin closed'"],
      workspace,
      {},
      { timeoutMs: 5_000 },
    )
    expect(result.exitCode, result.output).toBe(0)
    expect(result.output).toContain('stdin closed')
  })

  test('reports the last stage and reaps an intentionally stuck owned tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kei-publish-timeout-'))
    const childPidFile = join(root, 'child.pid')
    const nextSentinel = join(root, 'next-sentinel')
    const childScript = join(root, 'child.mjs')
    await writeFile(
      childScript,
      [
        "import { writeFile } from 'node:fs/promises'",
        "await writeFile(process.env.PUBLISH_TEST_CHILD_PID, String(process.pid))",
        "console.log('==> fixture child intentionally waiting')",
        'setInterval(() => {}, 1_000)',
        'await new Promise(() => {})',
        "await writeFile(process.env.PUBLISH_TEST_NEXT_SENTINEL, 'ran')",
      ].join('\n'),
    )
    const command = [
      findShell(),
      '-c',
      '"$PUBLISH_TEST_RUNTIME" "$PUBLISH_TEST_CHILD_SCRIPT" &',
    ]

    try {
      let failure: unknown
      try {
        const unexpected = await run(
          command,
          root,
          {
            PUBLISH_TEST_CHILD_PID: childPidFile,
            PUBLISH_TEST_CHILD_SCRIPT: shellPath(childScript),
            PUBLISH_TEST_NEXT_SENTINEL: nextSentinel,
            PUBLISH_TEST_RUNTIME: shellPath(process.execPath),
          },
          { ownedPidFiles: [childPidFile], timeoutMs: 2_000 },
        )
        failure = new Error(
          `stuck fixture unexpectedly exited ${unexpected.exitCode}: ${unexpected.output}`,
        )
      } catch (error) {
        failure = error
      }

      expect(failure).toBeInstanceOf(FixtureProcessError)
      expect((failure as FixtureProcessError).kind).toBe('timeout')
      expect((failure as Error).message).toContain('==> fixture child intentionally waiting')
      expect(await Bun.file(nextSentinel).exists()).toBe(false)

      const childPid = Number(await readFile(childPidFile, 'utf8'))
      expect(Number.isSafeInteger(childPid)).toBe(true)
      expect(await waitUntil(() => !processExists(childPid), 2_000)).toBe(true)
    } finally {
      if (await Bun.file(childPidFile).exists()) {
        const childPid = Number(await readFile(childPidFile, 'utf8'))
        if (Number.isSafeInteger(childPid) && processExists(childPid)) {
          if (process.platform === 'win32') await terminateWindowsTree(childPid)
          else process.kill(childPid, 'SIGKILL')
        }
      }
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)
})

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
      *) : ;;
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
