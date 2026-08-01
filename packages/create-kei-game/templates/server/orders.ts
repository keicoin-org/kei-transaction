/**
 * Which payment got which answer.
 *
 * Everything else this server could have stored is a question the chain answers:
 * balances, inventories, who owns the lantern. This file exists for the one
 * question it cannot. A Kei send has no memo, so a payment is named by its hash
 * and the order that redeems it arrives out of band — and nothing the game
 * writes back carries that hash. A mint says who got the lantern. A refund says
 * who got their money back. Neither says *which payment* it settled.
 *
 * So the chain cannot attribute an answer to a hash, and no amount of counting
 * makes it able to. Counting is the trap worth naming, because it looks like it
 * works: "this wallet has made three payments and been answered twice, so one is
 * still owed" is both true and useless. It cannot say *which* one, and a wallet
 * with two payments and one answer will let a repost of the answered payment
 * spend the unanswered one's credit — answering one hash twice and stranding the
 * other. Aggregates are not attribution.
 *
 * What attributes is a write-ahead log, and this is one:
 *
 *   1. read the issuer's frontier
 *   2. append an `intent` naming the hash, the plan, and that frontier — fsync
 *   3. write the block (mint or refund)
 *   4. append a `done` naming the hash and the outcome — fsync
 *
 * A wallet has one intent open at a time, because `settle` holds a mutex across
 * all four steps and refuses a wallet whose last intent is still open. That is
 * what makes step 3 recoverable *exactly*: while an intent is open, the only
 * blocks this issuer can write for that wallet are the one action that intent is
 * for. So a mint of the item to that address after that frontier is that
 * intent's delivery, and a Kei send to that address after it is that intent's
 * refund. Nothing else could have put them there.
 *
 * Step 3 is also the step that can fail without saying so. A node can refuse a
 * block — time out, drop the connection, lose the reply — and accept the same
 * block a moment later, so an error is not evidence and neither is a chain that
 * has nothing on it yet. "Not there" and "not there *yet*" read identically, and
 * treating the second as the first is how one payment gets two answers: the
 * intent is closed as void, the block lands, and the next post sees a player who
 * already owns the item and refunds what they paid for it.
 *
 * So absence has to be *made* true rather than observed. One account has one
 * chain and every block names the block it builds on, so a block signed against
 * an older frontier is dead the moment anything else occupies that slot — see
 * `fence`. Until that has been done, a failed action is indeterminate: the
 * intent stays open, the wallet is answered nothing further, and the next
 * attempt or the next restart resolves it against the chain.
 *
 * The chain's second job is to catch this file going missing. Answers written to
 * one address are countable on the issuer's chain even though they are not
 * attributable, so if this file holds fewer answers for an address than the
 * chain shows, records were lost — and every hash for that address that is not
 * on file becomes unanswerable rather than guessed at. That is a refusal, and it
 * is the point: a guess here either mints a second lantern or refunds one the
 * player kept.
 *
 * The same startup read of the chain is what makes a payment survive a restart
 * at all. `Kei.server()` collects everything waiting before this file gets to
 * attach a handler, so the arrival of a payment made while the game was down is
 * never announced to anyone. It is on the chain, though, which is where this
 * looks.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

import { KEI_DECIMALS, addressFromPublicKey, type Block, type Kei } from 'kei-transaction'

import type { LanternOutcome } from '../shared/game.js'

export interface Payment {
  /** The hash `kei.pay()` handed the player: the send block they signed. */
  hash: string
  from: string
  amount: number
}

/**
 * What settling a payment is about to do. `perform` writes the block; it runs
 * once, after the intent naming it is on the disk, and never again after a crash
 * without the chain being asked first whether it already ran.
 */
export interface Plan {
  kind: 'deliver' | 'refund'
  /** What the player is told, and what is written down under their hash. */
  outcome: LanternOutcome
  perform(): Promise<void>
}

export type Settled =
  | { status: 'answered'; outcome: LanternOutcome }
  /**
   * This payment has been answered and this game can no longer say with what,
   * because records for the wallet that made it are missing. Refuse; do not
   * guess. Both possible answers are in the player's own account history.
   */
  | { status: 'unattributable' }
  /**
   * An action for this wallet was submitted and its fate is not known: the node
   * neither confirmed it nor can be shown to have rejected it. Nothing has been
   * answered and nothing has been given up on. Ask again — the next attempt
   * resolves it if the node will talk, and so does a restart.
   */
  | { status: 'indeterminate' }

export interface Orders {
  /** Wait for one named payment to reach this game, or give up. */
  payment(hash: string, timeoutMs: number): Promise<Payment | undefined>
  /**
   * Answer one payment exactly once. A hash that already has an answer gets that
   * answer back, whether this process gave it or one that has since died did.
   */
  settle(payment: Payment, choose: () => Promise<Plan>): Promise<Settled>
  close(): void
}

export interface OrdersOptions {
  kei: Kei
  /** The item on sale. Mints of it are the deliveries this game has written. */
  item: string
  /** Where answers are appended. */
  path: string
  /**
   * How much of the issuer's chain to read at startup. All of it, or startup
   * fails: a partial read cannot tell a record this file lost from one written
   * before the window began.
   */
  historyLimit?: number
}

type Intent = { k: 'intent'; issuer: string; hash: string; address: string; plan: Plan['kind']; amount: number; since: string }
type Done = { k: 'done'; issuer: string; hash: string; address: string; amount: number; outcome: LanternOutcome }
type Void = { k: 'void'; issuer: string; hash: string }
type Entry = Intent | Done | Void

/** What an issuer block did for somebody, which is not which payment it did it for. */
interface Answer {
  kind: Plan['kind']
  address: string
}

/**
 * What the chain has to say about the one action an intent's window can hold.
 *
 * These are four different things and the bug is writing code that has three.
 * `absent` in particular is a claim about the future — that nothing can land
 * there any more — and it is only ever returned once that has been made true.
 */
type Evidence =
  | { state: 'found'; kind: Plan['kind'] }
  /** Nothing landed in that window and nothing still can: the slot after it is taken. */
  | { state: 'absent' }
  /** Two kinds of answer in one window. The invariant is broken; refuse rather than pick. */
  | { state: 'ambiguous' }
  /** The chain could not be read back to that frontier, so it said nothing either way. */
  | { state: 'unknown' }

/** A reading taken before the door is shut, where `pending` means "not there *yet*". */
type Reading = Evidence | { state: 'pending' }

/** The `link` of a block that links to nothing. */
const NOTHING = '0'.repeat(64)

export async function openOrders(options: OrdersOptions): Promise<Orders> {
  const { kei, item, path } = options
  const node = kei.client.node
  const issuer = kei.address
  const historyLimit = options.historyLimit ?? 100_000

  /** Payment hash to the answer it got. The only thing that attributes one. */
  const answers = new Map<string, LanternOutcome>()
  /** Payment hash to the payment, whether it arrived live or was read off the chain. */
  const seen = new Map<string, Payment>()
  const waiting = new Map<string, Array<(payment: Payment) => void>>()

  /** Per address: answers on file, and answers on the chain. Equal, or records were lost. */
  const onFile = new Map<string, number>()
  const onChain = new Map<string, number>()
  /** Wallets whose answers can no longer be told apart. Never answered again by this process. */
  const clouded = new Set<string>()
  /** Wallets with an action whose fate is not known yet. Answered again once it is. */
  const unresolved = new Set<string>()
  /** Intents written and not yet closed, by payment hash. */
  const openIntents = new Map<string, Intent>()

  const bump = (counts: Map<string, number>, address: string): void => {
    counts.set(address, (counts.get(address) ?? 0) + 1)
  }

  const note = (payment: Payment): void => {
    if (seen.has(payment.hash)) return
    seen.set(payment.hash, payment)
    for (const arrived of waiting.get(payment.hash) ?? []) arrived(payment)
    waiting.delete(payment.hash)
  }

  // ------------------------------------------------------------------ the file

  mkdirSync(dirname(path), { recursive: true })

  // Intents with no `done` or `void` after them: answers in flight when the
  // process died, or ones it could never resolve before it did.
  for (const entry of readEntries(path)) {
    // Entries name their issuer, so two games sharing a directory — or one game
    // restarted on a new seed — do not read each other's answers.
    if (entry.issuer !== issuer) continue
    if (entry.k === 'intent') {
      openIntents.set(entry.hash, entry)
      continue
    }
    openIntents.delete(entry.hash)
    if (entry.k !== 'done') continue
    answers.set(entry.hash, entry.outcome)
    bump(onFile, entry.address)
    // A payment with an answer on file never needs looking up on the node below:
    // its own entry says who made it and for how much.
    note({ hash: entry.hash, from: entry.address, amount: entry.amount })
  }

  const file = openSync(path, 'a')
  const append = (entry: Entry): void => {
    writeSync(file, `${JSON.stringify(entry)}\n`)
    // The crash that matters is the one between answering a player and that
    // player asking again, so the line reaches the disk before either can happen.
    fsyncSync(file)
  }

  // ----------------------------------------------------------------- the chain

  // Attached before the chain is read, so a payment arriving between the two is
  // caught twice rather than missed once.
  const stop = kei.onPayment(async ({ from, amount, hash }) => {
    // `onPayment` reports the *receive* block this account wrote, which is not
    // the hash the payer holds. A receive names the send it collects in `link`.
    const receive = await node.blockInfo(hash)
    if (receive?.type !== 'state') return
    note({ hash: receive.link, from, amount })
  })

  // -------------------------------------------------------- answers in flight

  // Settled first, and before the chain is counted, because settling one can
  // write to the chain: it fences off an action that may still be in flight, and
  // that action can land in between. Counting afterwards counts what is actually
  // there rather than what was there a moment before the door was shut.
  //
  // More than one intent can be open at once: an action nobody could resolve
  // leaves its own open and the game goes on serving other wallets. Each is
  // settled over its own window and told apart by the wallet it names. Two open
  // intents for *one* wallet is the case no window can separate, and it is
  // refused rather than guessed at.
  const perAddress = new Map<string, number>()
  for (const intent of openIntents.values()) bump(perAddress, intent.address)
  for (const intent of [...openIntents.values()]) {
    if ((perAddress.get(intent.address) ?? 0) > 1) {
      clouded.add(intent.address)
      continue
    }
    await closeIntent(intent, { count: 'later' })
  }

  // ----------------------------------------------------------------- the chain

  // Read before the history, so that a block landing between the two leaves the
  // history long rather than the frontier unaccounted for. It is the one hash on
  // the chain no `previous` field names, and an intent that got no further than
  // its own fsync recorded exactly it.
  const history = await node.accountHistory(issuer, { limit: historyLimit })
  const oldest = history[history.length - 1]
  if (oldest && !/^0+$/.test(oldest.previous)) {
    throw new Error(
      `server/orders.ts read ${history.length} blocks of the issuer's chain and did not reach the start of it. ` +
        'It needs all of it: a partial read cannot tell an answer this file lost from one written before the ' +
        'window began, and answering on that basis is how one payment gets answered twice. Raise historyLimit ' +
        'past the length of the chain, or move this record to a store that does not re-derive itself at boot.',
    )
  }

  // One pass, newest first, for the two things the chain is read for: how many
  // answers this issuer has written to each wallet, and which payments reached
  // it while nothing was listening.
  for (let index = 0; index < history.length; index++) {
    const block = history[index]
    if (!block) continue

    const answer = answerIn(block, item)
    if (answer) {
      bump(onChain, answer.address)
      continue
    }

    if (block.type !== 'state') continue
    if (block.subtype !== 'receive' && block.subtype !== 'open') continue
    if (seen.has(block.link)) continue

    // What arrived is this block's balance less its predecessor's. The whole
    // chain is here and it came back in order, so the predecessor is the next
    // entry along — or nothing at all, at the very first block.
    const before = /^0+$/.test(block.previous) ? 0n : BigInt(history[index + 1]?.balance ?? '0')
    const arrived = BigInt(block.balance) - before
    if (arrived <= 0n) continue

    // An asset receive collects a token rather than Kei and cannot pay for
    // anything. `link` on one is an operation, not a send anybody signed.
    const send = await node.blockInfo(block.link)
    if (send?.type !== 'state' || send.subtype !== 'send') continue
    note({ hash: block.link, from: send.account, amount: keiFromRaw(arrived) })
  }

  // --------------------------------------------------------- asking the chain

  /** The issuer's chain, or nothing at all if the node would not answer for it. */
  async function readChain(): Promise<{ frontier: string | undefined; recent: Block[] } | undefined> {
    try {
      const info = await node.accountInfo(issuer)
      return { frontier: info?.frontier, recent: await node.accountHistory(issuer, { limit: historyLimit }) }
    } catch {
      return undefined
    }
  }

  /** What is in one intent's window right now, which is not yet what will be. */
  async function read(intent: { since: string; address: string }): Promise<Reading> {
    const chain = await readChain()
    if (!chain) return { state: 'unknown' }
    const window = blocksAfter(chain.recent, chain.frontier, intent.since)
    // The read did not reach that frontier — it is beyond `historyLimit`, or it
    // is not on the chain this game is running against at all. Either way the
    // window cannot be looked at, so nothing is claimed about it.
    if (!window) return { state: 'unknown' }

    const kinds = new Set<Plan['kind']>()
    for (const block of window) {
      const answer = answerIn(block, item)
      if (answer?.address === intent.address) kinds.add(answer.kind)
    }
    // Two kinds of answer inside one window is the one thing the invariant rules
    // out. If it happens the invariant is broken, and a refusal beats a guess.
    if (kinds.size > 1) return { state: 'ambiguous' }
    const only = first(kinds)
    return only ? { state: 'found', kind: only } : { state: 'pending' }
  }

  /**
   * Write a block that does nothing, so that one which might still be in flight
   * can never land.
   *
   * This is the whole answer to a submit that failed without saying whether it
   * failed. One account has one chain (SPEC §5.6.1) and every block names the
   * block it builds on, so a block already signed against some frontier is dead
   * the moment anything else occupies that slot — the node rejects it as a fork.
   * Any block written here is after the one in question was signed, so its slot
   * is at or before this one, and either way it is taken.
   *
   * A representative change to the representative already in place is the block
   * to do it with: it moves no Kei, mints nothing, and `answerIn` does not read
   * it as an answer to anybody. It is a door, not a decision.
   *
   * False if the node would not take it, in which case nothing is known and
   * nothing is claimed.
   */
  async function fence(): Promise<boolean> {
    try {
      await kei.client.submit((draft) => ({
        type: 'state',
        subtype: 'change',
        account: issuer,
        previous: draft.previous,
        representative: draft.representative,
        balance: draft.balance.toString(),
        link: NOTHING,
      }))
      return true
    } catch {
      return false
    }
  }

  /**
   * What an intent's action did, once the question can be answered for good.
   *
   * An empty window is the dangerous reading, because it is the one that looks
   * like proof and is not: a node can refuse a block and accept it a moment
   * later. So an empty window is fenced first and read again, and only a window
   * still empty behind a closed door counts as `absent`.
   */
  async function settled(intent: { since: string; address: string }): Promise<Evidence> {
    const seenNow = await read(intent)
    if (seenNow.state !== 'pending') return seenNow
    if (!(await fence())) return { state: 'unknown' }
    const afterwards = await read(intent)
    return afterwards.state === 'pending' ? { state: 'absent' } : afterwards
  }

  /**
   * Settle one intent against the chain and write the entry that closes it — or
   * leave it open, which is what everything short of an answer amounts to.
   *
   * `count` says whether the pass over the chain has already counted an answer
   * found here: at startup it has not run yet and will count it itself, and
   * while running it ran long ago and this is one more than it saw.
   */
  async function closeIntent(intent: Intent, { count }: { count: 'later' | 'now' }): Promise<void> {
    const evidence = await settled(intent)

    if (evidence.state === 'found') {
      openIntents.delete(intent.hash)
      unresolved.delete(intent.address)
      const outcome = outcomeFor(evidence.kind, intent.amount, item)
      answers.set(intent.hash, outcome)
      bump(onFile, intent.address)
      if (count === 'now') bump(onChain, intent.address)
      note({ hash: intent.hash, from: intent.address, amount: intent.amount })
      append({ k: 'done', issuer, hash: intent.hash, address: intent.address, amount: intent.amount, outcome })
      return
    }

    if (evidence.state === 'absent') {
      // The action never landed and never can now. The payment is unanswered,
      // and closing the intent lets an ordinary repost answer it — which is
      // exactly what should happen.
      openIntents.delete(intent.hash)
      unresolved.delete(intent.address)
      append({ k: 'void', issuer, hash: intent.hash })
      return
    }

    // Nothing is written, because nothing is known. The intent stays open, and
    // with it the one thing that matters: no second answer can start for this
    // wallet while its first one might still be on its way.
    if (evidence.state === 'ambiguous') clouded.add(intent.address)
    else unresolved.add(intent.address)
  }

  /**
   * Try again to settle whatever this wallet has open, before answering it
   * anything. This is the path that gets a stuck wallet moving without a
   * restart: the node that would not answer a moment ago may answer now.
   */
  async function resolveOpen(address: string): Promise<void> {
    if (clouded.has(address)) return
    const mine = [...openIntents.values()].filter((intent) => intent.address === address)
    if (mine.length > 1) {
      clouded.add(address)
      return
    }
    const only = mine[0]
    if (only) await closeIntent(only, { count: 'now' })
  }

  /**
   * Whether a hash this file has never heard of can be treated as unanswered.
   *
   * Only if every answer the chain shows for this wallet is also on file. One
   * missing entry and any of its hashes could be the one that entry named, so
   * none of them can be answered — including, and this is the expensive one, by
   * being refunded.
   */
  function attributable(address: string): boolean {
    return (onFile.get(address) ?? 0) === (onChain.get(address) ?? 0)
  }

  // ------------------------------------------------------------- one at a time

  let queue: Promise<unknown> = Promise.resolve()
  const serially = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run)
    queue = next.catch(() => undefined)
    return next
  }

  return {
    async payment(hash, timeoutMs) {
      const already = seen.get(hash)
      if (already) return already

      return new Promise<Payment | undefined>((arrive) => {
        let timer: ReturnType<typeof setTimeout>
        const arrived = (payment: Payment): void => {
          clearTimeout(timer)
          arrive(payment)
        }
        timer = setTimeout(() => {
          const listeners = (waiting.get(hash) ?? []).filter((listener) => listener !== arrived)
          if (listeners.length === 0) waiting.delete(hash)
          else waiting.set(hash, listeners)
          arrive(undefined)
        }, timeoutMs)

        waiting.set(hash, [...(waiting.get(hash) ?? []), arrived])
      })
    },

    settle(payment, choose) {
      return serially<Settled>(async () => {
        // An action this wallet has open and unresolved is asked about again
        // here, on the chance the node has come back. It is the difference
        // between a wallet stuck until somebody restarts the game and a wallet
        // that unsticks itself the next time the player presses the button.
        await resolveOpen(payment.from)

        const recorded = answers.get(payment.hash)
        if (recorded) return { status: 'answered', outcome: recorded }
        if (clouded.has(payment.from)) return { status: 'unattributable' }
        if (unresolved.has(payment.from)) return { status: 'indeterminate' }
        if (!attributable(payment.from)) return { status: 'unattributable' }

        // Inside the mutex, so the read this plan is chosen on — whether the
        // player already holds a lantern — cannot go stale before it is acted on.
        const plan = await choose()

        const info = await node.accountInfo(issuer)
        if (!info) {
          throw new Error('The issuer has no chain to write on, which cannot happen once it has issued its own assets.')
        }

        const intent: Intent = {
          k: 'intent',
          issuer,
          hash: payment.hash,
          address: payment.from,
          plan: plan.kind,
          amount: payment.amount,
          since: info.frontier,
        }
        append(intent)
        openIntents.set(intent.hash, intent)

        try {
          await plan.perform()
        } catch (error) {
          // The error says nothing on its own: a node that refuses a block can
          // accept it a moment afterwards. `closeIntent` asks the chain over
          // this intent's own window and shuts the door before believing an
          // empty one, so what the player is told is the chain's answer rather
          // than the exception's.
          await closeIntent(intent, { count: 'now' })
          const answered = answers.get(payment.hash)
          if (answered) return { status: 'answered', outcome: answered }
          if (clouded.has(payment.from)) return { status: 'unattributable' }
          if (openIntents.has(intent.hash)) return { status: 'indeterminate' }
          // Voided: nothing landed and nothing can now. The payment is untouched
          // and this hash can be posted again, so the failure is the answer.
          throw error
        }

        openIntents.delete(intent.hash)
        answers.set(payment.hash, plan.outcome)
        bump(onFile, payment.from)
        bump(onChain, payment.from)
        append({
          k: 'done',
          issuer,
          hash: payment.hash,
          address: payment.from,
          amount: payment.amount,
          outcome: plan.outcome,
        })
        return { status: 'answered', outcome: plan.outcome }
      })
    },

    close() {
      stop()
      closeSync(file)
    },
  }

}

/**
 * The blocks written on top of `since`, newest first — an intent's window.
 *
 * `undefined` is the fourth answer and the one that has to stay distinct: the
 * read cannot see that far back, so the window is not empty, it is unreadable.
 * The history is consulted first and the frontier only as a fallback, so a block
 * landing between the two reads makes the window longer rather than invisible.
 */
function blocksAfter(recent: Block[], frontier: string | undefined, since: string): Block[] | undefined {
  const at = recent.findIndex((block) => block.previous === since)
  if (at !== -1) return recent.slice(0, at + 1)
  // Nothing is built on it and it is the tip of the chain, so the window is
  // genuinely empty — which is not the same as nothing being able to arrive in it.
  return frontier === since ? [] : undefined
}

/**
 * What an issuer block did for somebody else, which is the only trace an answer
 * leaves. A mint of the item is a delivery; any Kei send is a refund.
 *
 * That second rule is the one to keep in mind when editing this game. If it
 * gains another reason to send a player Kei, that send is counted here as an
 * answer, this file will look short of an entry, and real purchases from that
 * wallet will be refused as unattributable. Refusing is the safe direction — a
 * miscount here cannot pay anybody twice — but it is still a bug, and the fix is
 * to teach this function how to tell the two apart.
 */
function answerIn(block: Block, item: string): Answer | undefined {
  if (block.type === 'asset') {
    if (block.op.kind !== 'mint' || block.op.asset !== item) return undefined
    return { kind: 'deliver', address: block.op.to }
  }
  if (block.subtype !== 'send') return undefined
  return { kind: 'refund', address: addressFromPublicKey(block.link) }
}

function outcomeFor(kind: Plan['kind'], amount: number, item: string): LanternOutcome {
  return kind === 'deliver'
    ? { outcome: 'delivered', item }
    : { outcome: 'refunded', amount, reason: 'You already have a lantern.' }
}

function first<T>(values: Set<T>): T | undefined {
  for (const value of values) return value
  return undefined
}

function readEntries(path: string): Entry[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }

  const entries: Entry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      // A half-written last line is what a crash mid-append leaves behind, and
      // dropping it is always safe. A torn `done` leaves its `intent` open, and
      // the chain says what that intent did. A torn `intent` was never followed
      // by an action at all, because the action comes after the write that tore.
      const parsed = JSON.parse(line) as Entry
      if (looksLikeEntry(parsed)) entries.push(parsed)
    } catch {
      continue
    }
  }
  return entries
}

function looksLikeEntry(entry: Entry): boolean {
  if (typeof entry?.issuer !== 'string' || typeof entry.hash !== 'string') return false
  if (entry.k === 'void') return true
  if (typeof entry.address !== 'string' || typeof entry.amount !== 'number') return false
  if (entry.k === 'intent') return typeof entry.since === 'string' && (entry.plan === 'deliver' || entry.plan === 'refund')
  return entry.k === 'done' && typeof entry.outcome?.outcome === 'string'
}

/**
 * Raw Kei as the plain number `onPayment` reports, by the same route: decimal
 * string first, so a payment read off the chain and the same payment seen
 * arriving compare equal.
 */
function keiFromRaw(raw: bigint): number {
  const digits = raw.toString().padStart(KEI_DECIMALS + 1, '0')
  const whole = digits.slice(0, digits.length - KEI_DECIMALS)
  const fraction = digits.slice(digits.length - KEI_DECIMALS).replace(/0+$/, '')
  return Number(fraction === '' ? whole : `${whole}.${fraction}`)
}
