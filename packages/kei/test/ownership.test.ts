/**
 * Proving a player controls an address, which SPEC §6.3 says the SDK must make
 * structurally safe rather than merely document.
 *
 * The load-bearing test is the domain-separation one: the digest a wallet signs
 * here has to be disjoint from every digest a Kei *block* signature covers, or
 * the method is a signing oracle wearing a helpful name. It is asserted against
 * the real hasher, because a doc comment cannot fail when `@keicoin/core`
 * changes its layout.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  blake2b,
  bytesToHex,
  canonicalJson,
  containsSecret,
  createNonceStore,
  hashBlock,
  keiBlockDomain,
  keyPairFromSeed,
  ownershipChallengeHash,
  randomChallengeNonce,
  signHash,
  utf8,
  verifyOwnershipProof,
  type MockNode,
  type OwnershipChallenge,
  type StateBlockBody,
} from '@keicoin/core'
import { Kei } from 'kei-transaction'

const ALICE_SEED = 'A'.repeat(64)
const BOB_SEED = 'B'.repeat(64)
const ALICE = await keyPairFromSeed(ALICE_SEED, 0)
const BOB = await keyPairFromSeed(BOB_SEED, 0)

const DOMAIN = 'example.com/my-game/session/v1'
const NONCE = '7A1C0F5E'.repeat(8)

const CHALLENGE: OwnershipChallenge = {
  domain: DOMAIN,
  address: ALICE.address,
  nonce: NONCE,
  context: { roomId: 'room-7', sessionId: 'socket-3' },
}

/** A real, hashable block on Alice's chain — the thing that moves money. */
const SEND: StateBlockBody = {
  type: 'state',
  subtype: 'send',
  account: ALICE.address,
  previous: '0'.repeat(64),
  representative: ALICE.address,
  balance: '1000000',
  link: BOB.publicKey,
}

/** A block with no consensus layout, which `hashBlock` puts under its own preamble. */
const LOCAL: StateBlockBody = { ...SEND, memo: 'a memo has no state-block field' }

const open: Kei[] = []

afterEach(() => {
  while (open.length > 0) open.pop()?.close()
})

async function player(options: { seed?: string; reveal?: 'never' | 'always' } = {}): Promise<Kei> {
  const node: MockNode = await Kei.mock()
  const kei = await Kei.start({
    node,
    seed: options.seed ?? ALICE_SEED,
    ...(options.reveal === undefined ? {} : { reveal: options.reveal }),
  })
  open.push(kei)
  return kei
}

describe('domain separation', () => {
  test('the signed preimage is the ownership domain, and no block hash starts that way', () => {
    const preimage = utf8(`kei-ownership-challenge-v1\n${canonicalJson(CHALLENGE)}`)
    expect(ownershipChallengeHash(CHALLENGE)).toBe(bytesToHex(blake2b(preimage, 32)))

    // A consensus block opens with 32 raw bytes of blake2b("kei-block-v1"). An
    // ASCII domain string cannot be those bytes, and the first one says so.
    const blockDomain = keiBlockDomain()
    expect(preimage.slice(0, blockDomain.length)).not.toEqual(blockDomain)
    expect(preimage[0]).toBe('k'.charCodeAt(0))
    expect(blockDomain[0]).not.toBe('k'.charCodeAt(0))
  })

  test('a signature over a real block hash does not verify as an ownership proof', async () => {
    for (const body of [SEND, LOCAL]) {
      const blockHash = hashBlock(body)
      expect(blockHash).not.toBe(ownershipChallengeHash(CHALLENGE))

      // Alice really signs her own real block, with her own real key. It is
      // still not a proof of anything here, because it covers other bytes.
      const signature = await signHash(ALICE.privateKey, blockHash)
      const proof = { address: ALICE.address, signature, challenge: CHALLENGE }
      expect(await verifyOwnershipProof(proof, CHALLENGE)).toBe(false)
    }
  })

  test('an ownership proof is not a signature over any block this wallet could publish', async () => {
    const kei = await player()
    const proof = await kei.wallet.signOwnershipChallenge(CHALLENGE)
    expect(await verifyOwnershipProof(proof, CHALLENGE)).toBe(true)

    // The other direction of the same claim: what a server accepted cannot be
    // replayed at a node as the signature on a block.
    expect(proof.signature).not.toBe(await signHash(ALICE.privateKey, hashBlock(SEND)))
    expect(proof.signature).not.toBe(await signHash(ALICE.privateKey, hashBlock(LOCAL)))
  })

  test('the caller\'s domain is inside the signed bytes, not in front of them', async () => {
    const kei = await player()
    const proof = await kei.wallet.signOwnershipChallenge(CHALLENGE)

    // Every preimage this method produces begins with the same fixed bytes,
    // whatever namespace the caller picked, so no choice of domain can walk the
    // preimage towards a block's.
    const other = { ...CHALLENGE, domain: 'other-game.example/v1' }
    expect(ownershipChallengeHash(other)).not.toBe(ownershipChallengeHash(CHALLENGE))
    expect(await verifyOwnershipProof(proof, other)).toBe(false)
  })

  test('no field can be smuggled through the boundary of the one beside it', () => {
    // The classic concatenation bug: `a|bc` and `ab|c` hashing the same. JSON
    // quotes and escapes every value, so they cannot.
    const split = { ...CHALLENGE, context: { roomId: 'room', sessionId: 'a-session' } }
    const shifted = { ...CHALLENGE, context: { roomId: 'rooma', sessionId: '-session' } }
    expect(ownershipChallengeHash(split)).not.toBe(ownershipChallengeHash(shifted))

    const injected = { ...CHALLENGE, domain: `${DOMAIN}","address":"${BOB.address}` }
    expect(ownershipChallengeHash(injected)).not.toBe(ownershipChallengeHash(CHALLENGE))
  })
})

describe('a game server checking a proof', () => {
  test('a valid proof verifies from the address alone', async () => {
    const kei = await player()
    const address = kei.address
    const proof = await kei.wallet.signOwnershipChallenge(CHALLENGE)
    // No wallet, no client, no node, no key: everything the check needs is the
    // address the client claimed and the challenge the server issued.
    kei.close()

    expect(proof.address).toBe(address)
    expect(Object.keys(proof).sort()).toEqual(['address', 'challenge', 'signature'])
    expect(await verifyOwnershipProof(proof, { ...CHALLENGE, address })).toBe(true)
    expect(await Kei.verifyOwnershipProof(proof, { ...CHALLENGE, address })).toBe(true)
  })

  test('a replayed proof is refused by the nonce store, and the first is not', async () => {
    const kei = await player()
    const nonces = createNonceStore()
    const proof = await kei.wallet.signOwnershipChallenge(CHALLENGE)

    expect(await verifyOwnershipProof(proof, { ...CHALLENGE, nonces })).toBe(true)
    expect(await verifyOwnershipProof(proof, { ...CHALLENGE, nonces })).toBe(false)

    // A fresh challenge for the same session is a fresh proof, and it passes.
    const again = { ...CHALLENGE, nonce: randomChallengeNonce() }
    expect(await verifyOwnershipProof(
      await kei.wallet.signOwnershipChallenge(again),
      { ...again, nonces },
    )).toBe(true)
  })

  test('a wrong signature does not burn the nonce an honest client still holds', async () => {
    const kei = await player()
    const nonces = createNonceStore()
    const proof = await kei.wallet.signOwnershipChallenge(CHALLENGE)

    const forged = { ...proof, signature: 'F'.repeat(128) }
    expect(await verifyOwnershipProof(forged, { ...CHALLENGE, nonces })).toBe(false)
    expect(await verifyOwnershipProof(proof, { ...CHALLENGE, nonces })).toBe(true)
  })

  test('every field of the challenge is checked, and an unknown one is refused', async () => {
    const kei = await player()
    const proof = await kei.wallet.signOwnershipChallenge(CHALLENGE)

    const wrong = [
      { ...CHALLENGE, domain: 'example.com/my-game/session/v2' },
      { ...CHALLENGE, nonce: randomChallengeNonce() },
      { ...CHALLENGE, context: { roomId: 'room-7', sessionId: 'socket-4' } },
      // The same two values, swapped between the keys that carry them.
      { ...CHALLENGE, context: { roomId: 'socket-3', sessionId: 'room-7' } },
      { ...CHALLENGE, context: {} },
    ]
    for (const expected of wrong) expect(await verifyOwnershipProof(proof, expected)).toBe(false)

    // A proof carrying a field the SDK does not know is not this proof format.
    expect(await verifyOwnershipProof({ ...proof, expires: 1 }, CHALLENGE)).toBe(false)
    expect(await verifyOwnershipProof({ ...proof, address: BOB.address }, CHALLENGE)).toBe(false)
    expect(await verifyOwnershipProof(
      { ...proof, challenge: { ...CHALLENGE, expires: 1 } },
      CHALLENGE,
    )).toBe(false)
  })

  test('context key order is not part of the proof, because canonical JSON sorts it', async () => {
    const kei = await player()
    const proof = await kei.wallet.signOwnershipChallenge(CHALLENGE)
    const reordered = {
      ...CHALLENGE,
      context: { sessionId: 'socket-3', roomId: 'room-7' },
    }
    // Both sides build the challenge from their own object literal, so a
    // disagreement about insertion order must not read as a failed proof.
    expect(await verifyOwnershipProof(proof, reordered)).toBe(true)
  })

  test('another wallet\'s signature over the same challenge does not pass', async () => {
    const kei = await player()
    const proof = await kei.wallet.signOwnershipChallenge(CHALLENGE)
    const impostor = {
      ...proof,
      signature: await signHash(BOB.privateKey, ownershipChallengeHash(CHALLENGE)),
    }
    expect(await verifyOwnershipProof(impostor, CHALLENGE)).toBe(false)
  })

  test('nothing a client can send throws; a malformed expectation does', async () => {
    for (const junk of [null, undefined, 'proof', 42, [], {}, { signature: 'F'.repeat(128) }]) {
      expect(await verifyOwnershipProof(junk, CHALLENGE)).toBe(false)
    }
    await expect(verifyOwnershipProof({}, { ...CHALLENGE, nonce: 'nope' })).rejects.toThrow(
      /randomChallengeNonce/,
    )
    expect(() => createNonceStore({ limit: 0 })).toThrow(/whole number of nonces/)
  })

  test('a store with a limit forgets its oldest nonce, and says so in the docs', () => {
    const nonces = createNonceStore({ limit: 2 })
    expect(nonces.use('A'.repeat(64))).toBe(true)
    expect(nonces.use('B'.repeat(64))).toBe(true)
    expect(nonces.use('A'.repeat(64))).toBe(false)
    expect(nonces.use('C'.repeat(64))).toBe(true)
    // Evicted, and therefore usable again. This is the bound being honest
    // rather than a bug: size the store above the challenges you have out.
    expect(nonces.use('A'.repeat(64))).toBe(true)
  })
})

describe('what the wallet will and will not sign', () => {
  test('the method is on the object Kei.start() returns', async () => {
    const kei = await player()
    expect(typeof kei.wallet.signOwnershipChallenge).toBe('function')
  })

  test('a bare digest is refused, with the reason it is dangerous', async () => {
    const kei = await player()
    await expect(
      kei.wallet.signOwnershipChallenge(hashBlock(SEND) as never),
    ).rejects.toThrow(/not a digest/)
    await expect(kei.wallet.signOwnershipChallenge(hashBlock(SEND) as never)).rejects.toThrow(
      /hash of a send/,
    )
  })

  test('a supplied hash that disagrees is refused rather than corrected', async () => {
    const kei = await player()
    const honest = { ...CHALLENGE, hash: ownershipChallengeHash(CHALLENGE) }
    expect((await kei.wallet.signOwnershipChallenge(honest)).challenge).toEqual(CHALLENGE)
    expect(
      (await kei.wallet.signOwnershipChallenge({ ...honest, hash: honest.hash.toLowerCase() }))
        .signature,
    ).toBe((await kei.wallet.signOwnershipChallenge(honest)).signature)

    // The attack this exists to stop: a well-formed challenge carrying the hash
    // of a real send, in the hope the wallet signs the bytes not the structure.
    const oracle = { ...CHALLENGE, hash: hashBlock(SEND) }
    await expect(kei.wallet.signOwnershipChallenge(oracle)).rejects.toThrow(/not safe to sign/)
    // And nothing was signed on the way to refusing.
    const forged = { address: ALICE.address, signature: hashBlock(SEND), challenge: CHALLENGE }
    expect(await verifyOwnershipProof(forged, CHALLENGE)).toBe(false)
  })

  test('a challenge naming another wallet is refused, with a sentence', async () => {
    const kei = await player({ seed: BOB_SEED })
    await expect(kei.wallet.signOwnershipChallenge(CHALLENGE)).rejects.toThrow(
      /names a different wallet/,
    )
  })

  test('a getter is not a value, so nothing can answer twice between check and use', async () => {
    const kei = await player()
    let answered = false
    const trap = {
      ...CHALLENGE,
      get nonce(): string {
        const first = !answered
        answered = true
        return first ? NONCE : 'D'.repeat(64)
      },
    }
    await expect(kei.wallet.signOwnershipChallenge(trap)).rejects.toThrow(
      /accessor where a value belongs/,
    )
  })

  test('every bound is a sentence naming the fix', async () => {
    const kei = await player()
    const bad: Array<[unknown, RegExp]> = [
      [{ ...CHALLENGE, domain: '' }, /your own namespace/],
      [{ ...CHALLENGE, domain: 'x'.repeat(129) }, /your own namespace/],
      [{ ...CHALLENGE, address: `${ALICE.address}x` }, /names the Kei address/],
      [{ ...CHALLENGE, nonce: NONCE.slice(1) }, /randomChallengeNonce/],
      [{ ...CHALLENGE, roomId: 'room-7' }, /inside context/],
      [{ ...CHALLENGE, context: { nested: { a: 1 } } }, /Flatten it/],
      [{ ...CHALLENGE, context: { long: 'x'.repeat(257) } }, /printable characters/],
      [null, /not an object/],
      [[CHALLENGE], /not an object/],
    ]
    for (const [challenge, message] of bad) {
      await expect(kei.wallet.signOwnershipChallenge(challenge as never)).rejects.toThrow(message)
    }
  })
})

describe('the seed is irrelevant to it (SPEC §6.6)', () => {
  test('it works under reveal: \'never\', where there is no seed to reach for', async () => {
    const kei = await player({ reveal: 'never' })
    expect(() => kei.seed).toThrow(/cannot be read/)

    const proof = await kei.wallet.signOwnershipChallenge(CHALLENGE)
    expect(await verifyOwnershipProof(proof, CHALLENGE)).toBe(true)
  })

  test('no proof and no refusal carries the seed', async () => {
    const kei = await player({ reveal: 'never' })
    const proof = await kei.wallet.signOwnershipChallenge(CHALLENGE)

    expect(containsSecret(JSON.stringify(proof))).toBe(false)
    expect(containsSecret(JSON.stringify(proof.challenge))).toBe(false)
    expect(JSON.stringify(proof)).not.toContain(ALICE_SEED)
    expect(JSON.stringify(proof)).not.toContain(ALICE.privateKey)

    for (const challenge of [{ ...CHALLENGE, address: BOB.address }, { ...CHALLENGE, nonce: 'no' }]) {
      const caught = await kei.wallet.signOwnershipChallenge(challenge).catch((e: unknown) => e)
      expect(caught).toBeInstanceOf(Error)
      expect(containsSecret(String((caught as Error).message))).toBe(false)
      expect(containsSecret(String((caught as Error).stack))).toBe(false)
    }
  })
})

/**
 * The import a consumer actually writes.
 *
 * `kei-transaction` is the default install (SPEC §10.1), and #138 is what
 * happens when the umbrella does not re-export the real primitive: a repo
 * hand-rolled a weaker secret-scrubber rather than noticing the good one was
 * unreachable. Three repositories are waiting on this exact surface, so the
 * whole loop — a wallet producing a proof and a server checking it — is
 * asserted here against the package root, with nothing imported from a
 * sub-package.
 */
describe('reachable from the package root', () => {
  test('a wallet proves and a server verifies, importing only `kei-transaction`', async () => {
    const root = await import('kei-transaction')

    // The server half. A game server checking a proof has no wallet and no
    // seed, and needs these by name.
    expect(typeof root.verifyOwnershipProof).toBe('function')
    expect(typeof root.createNonceStore).toBe('function')
    expect(typeof root.randomChallengeNonce).toBe('function')
    expect(typeof root.ownershipChallengeHash).toBe('function')
    expect(typeof root.parseOwnershipChallenge).toBe('function')

    // The wallet half.
    const kei = await player()
    expect(typeof kei.wallet.signOwnershipChallenge).toBe('function')

    const challenge = {
      domain: DOMAIN,
      address: ALICE.address,
      nonce: root.randomChallengeNonce(),
      context: { roomId: 'room-7' },
    }
    const proof = await kei.wallet.signOwnershipChallenge(challenge)
    const nonces = root.createNonceStore()

    expect(await root.verifyOwnershipProof(proof, { ...challenge, nonces })).toBe(true)
    // The second presentation of one proof is a replay, and the store is where
    // that is caught — so a server wiring this up from the root alone gets the
    // protection too, not just the signature check.
    expect(await root.verifyOwnershipProof(proof, { ...challenge, nonces })).toBe(false)
  })
})
