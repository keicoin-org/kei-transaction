/**
 * SPEC §6.6: a credential never reaches an error, a log, or a stack trace. Both
 * transports point at a URL a developer typed, so this is where the rule about
 * what a URL may say in public is pinned.
 */

import { describe, expect, test } from 'bun:test'
import { safeEndpoint } from '@keicoin/core'

describe('safeEndpoint', () => {
  test('scheme, host and path survive', () => {
    expect(safeEndpoint('https://node.example:8443/rpc')).toBe('https://node.example:8443/rpc')
  })

  test('userinfo, query and fragment do not', () => {
    const safe = safeEndpoint(
      'https://operator:hunter2-correct-horse@node.example:8443/rpc?apiKey=sk-live-9f8e7d6c5b4a3210&v=2#staging',
    )

    expect(safe).toBe('https://node.example:8443/rpc')
    expect(safe).not.toContain('operator')
    expect(safe).not.toContain('hunter2-correct-horse')
    expect(safe).not.toContain('sk-live-9f8e7d6c5b4a3210')
    expect(safe).not.toContain('staging')
  })

  test('a token carried as a path segment is redacted, and the host survives', () => {
    const safe = safeEndpoint('https://node.example/v3/0123456789abcdef0123456789abcdef')
    expect(safe).toBe('https://node.example/v3/[redacted]')
  })

  test('a URL with no scheme keeps its secrets too', () => {
    // `new URL` refuses this outright, so it is cut back as text instead.
    const safe = safeEndpoint('node.example/rpc?apiKey=sk-live-9f8e7d6c5b4a3210#tail')
    expect(safe).toContain('node.example/rpc')
    expect(safe).not.toContain('sk-live-9f8e7d6c5b4a3210')
    expect(safe).not.toContain('apiKey')
    expect(safe).not.toContain('tail')
  })

  test('userinfo inside a host-less URL is not a hiding place', () => {
    // This one does parse — as a scheme and one opaque path with the password
    // sitting in the middle of it, which the structural route would have kept.
    const safe = safeEndpoint('operator:hunter2-correct-horse@node.example/rpc')
    expect(safe).toContain('node.example/rpc')
    expect(safe).not.toContain('hunter2-correct-horse')
    expect(safe).not.toContain('operator')
  })
})
