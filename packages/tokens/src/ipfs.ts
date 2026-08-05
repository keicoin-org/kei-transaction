/**
 * Item images. The chain stores a pointer; the asset lives on IPFS (SPEC §7).
 *
 * M0 ships a stand-in that computes a stable content address without a network,
 * so the demo and the tests can run offline and the API does not change when a
 * real pinning service arrives at M4. Anything that already looks like a CID or
 * a URL is passed straight through.
 */

import { blake2b, bytesToHex, fail } from '@keicoin/core'

export interface IpfsUploader {
  upload(image: ImageSource): Promise<string>
}

export type ImageSource = string | Uint8Array

const LOOKS_LIKE_CID = /^(baf[a-z0-9]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/
const LOOKS_LIKE_URL = /^(https?|ipfs|data):/i

export class MockIpfsUploader implements IpfsUploader {
  async upload(image: ImageSource): Promise<string> {
    if (typeof image === 'string') {
      if (LOOKS_LIKE_CID.test(image) || LOOKS_LIKE_URL.test(image)) return image
      return contentAddress(await readLocalFile(image))
    }
    return contentAddress(image)
  }
}

/** Deterministic, obviously-fake, and stable for the same bytes. */
function contentAddress(bytes: Uint8Array): string {
  return `bafkmock${bytesToHex(blake2b(bytes, 26)).toLowerCase()}`
}

/**
 * Reads the file a path points at, or refuses.
 *
 * Hashing the path string when the read fails would produce a well-formed
 * pointer to nothing, and issuance metadata is written once and never edited
 * (SPEC §5.3, §7) — so a mistyped path would be permanent, and the only remedy
 * would be issuing a second asset. "There is no filesystem here" and "that file
 * is not there" are different sentences and neither of them is a CID.
 */
async function readLocalFile(path: string): Promise<Uint8Array> {
  const runtime = globalThis as { process?: { versions?: Record<string, string>; cwd?: () => string } }
  if (!runtime.process?.versions?.node && !runtime.process?.versions?.bun) {
    fail(
      'no-filesystem',
      `Cannot read '${path}': there is no filesystem to read it from here. Pass image bytes (Uint8Array), an IPFS CID, or a URL.`,
    )
  }
  try {
    const { readFile } = await import('node:fs/promises')
    return new Uint8Array(await readFile(path))
  } catch {
    const from = runtime.process?.cwd?.()
    fail(
      'image-unreadable',
      `Cannot read '${path}'${from === undefined ? '' : ` from ${from}`} — pass a path that exists, an IPFS CID, or a URL. A path that cannot be read is not uploaded, and issuance metadata cannot be corrected afterwards.`,
    )
  }
}
