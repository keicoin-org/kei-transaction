/**
 * Item images. The chain stores a pointer; the asset lives on IPFS (SPEC §7).
 *
 * M0 ships a stand-in that computes a stable content address without a network,
 * so the demo and the tests can run offline and the API does not change when a
 * real pinning service arrives at M4. Anything that already looks like a CID or
 * a URL is passed straight through.
 */

import { blake2b, bytesToHex, utf8 } from '@keicoin/core'

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
      const bytes = await readLocalFile(image)
      return contentAddress(bytes ?? utf8(image))
    }
    return contentAddress(image)
  }
}

/** Deterministic, obviously-fake, and stable for the same bytes. */
function contentAddress(bytes: Uint8Array): string {
  return `bafkmock${bytesToHex(blake2b(bytes, 26)).toLowerCase()}`
}

/** Reads a path when running on a server; returns undefined in a browser. */
async function readLocalFile(path: string): Promise<Uint8Array | undefined> {
  const runtime = globalThis as { process?: { versions?: Record<string, string> } }
  if (!runtime.process?.versions?.node && !runtime.process?.versions?.bun) return undefined
  try {
    const { readFile } = await import('node:fs/promises')
    return new Uint8Array(await readFile(path))
  } catch {
    return undefined
  }
}
