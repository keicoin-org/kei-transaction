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
 * One intent is open at a time, because `settle` holds a mutex across all four
 * steps and startup closes every intent it finds before anything is served. That
 * invariant is what makes step 3 recoverable *exactly*: while an intent is open,
 * the only blocks this issuer can write are the receives it collects by itself
 * and the one action that intent is for. So a mint of the item to that address
 * after that frontier is that intent's delivery, and a Kei send to that address
 * after it is that intent's refund. Nothing else could have put them there.
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
  /** Wallets whose in-flight answer could not be resolved. Never answered again. */
  const clouded = new Set<string>()

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

  /** Intents with no `done` or `void` after them: answers in flight when the process died. */
  const open = new Map<string, Intent>()
  for (const entry of readEntries(path)) {
    // Entries name their issuer, so two games sharing a directory — or one game
    // restarted on a new seed — do not read each other's answers.
    if (entry.issuer !== issuer) continue
    if (entry.k === 'intent') {
      open.set(entry.hash, entry)
      continue
    }
    open.delete(entry.hash)
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

  // Read before the history, so that a block landing between the two leaves the
  // history long rather than the frontier unaccounted for. It is the one hash on
  // the chain no `previous` field names, and an intent that got no further than
  // its own fsync recorded exactly it.
  const started = await node.accountInfo(issuer)
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

  /** Frontier hash to the index of the block written directly on top of it. */
  const builtOn = new Map<string, number>()
  for (let index = 0; index < history.length; index++) {
    const block = history[index]
    if (block) builtOn.set(block.previous, index)
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

  // -------------------------------------------------------- answers in flight

  // Oldest first. One open intent is the most a crash can leave, because nothing
  // opens a second while one is open. A file that somehow holds more gets each
  // window closed off at the next intent's frontier, so no two can claim one
  // block. All of them are settled here, before anything is served.
  const inFlight = [...open.values()].sort((left, right) => index(right.since) - index(left.since))
  for (let at = 0; at < inFlight.length; at++) {
    const intent = inFlight[at]
    if (!intent) continue
    const next = inFlight[at + 1]
    closeIntent(intent, next ? index(next.since) + 1 : 0)
  }

  /** Where the block written on top of a frontier sits, or -1 for a frontier nothing was written on. */
  function index(since: string): number {
    return builtOn.get(since) ?? -1
  }

  /**
   * Settle one intent against the chain, and write the entry that closes it.
   *
   * `newest` is the index the search stops at, 0 being the frontier. It is 0 for
   * the single open intent a crash can actually leave.
   */
  function closeIntent(intent: Intent, newest: number): void {
    const oldestInWindow = builtOn.get(intent.since)
    const known = oldestInWindow !== undefined || intent.since === started?.frontier
    if (!known) {
      // Its frontier is nowhere on the chain this game is running against, so
      // nothing about it can be proved. Nothing is claimed either: the intent
      // stays open and this wallet is refused from here on.
      clouded.add(intent.address)
      return
    }

    const found = new Set<Plan['kind']>()
    for (let at = newest; at <= (oldestInWindow ?? -1); at++) {
      const block = history[at]
      if (!block) continue
      const answer = answerIn(block, item)
      if (answer?.address === intent.address) found.add(answer.kind)
    }

    // Two kinds of answer inside one intent's window is the one thing the
    // invariant above rules out. If it happens the invariant is broken, and a
    // refusal is worth more than a guess.
    if (found.size > 1) {
      clouded.add(intent.address)
      return
    }

    if (found.size === 0) {
      // The process died before the block was written, or while writing one that
      // never landed. The payment is unanswered, and closing the intent lets an
      // ordinary repost answer it — which is exactly what should happen.
      append({ k: 'void', issuer, hash: intent.hash })
      return
    }

    const outcome = outcomeFor(found.has('deliver') ? 'deliver' : 'refund', intent.amount, item)
    answers.set(intent.hash, outcome)
    bump(onFile, intent.address)
    note({ hash: intent.hash, from: intent.address, amount: intent.amount })
    append({ k: 'done', issuer, hash: intent.hash, address: intent.address, amount: intent.amount, outcome })
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
    return !clouded.has(address) && (onFile.get(address) ?? 0) === (onChain.get(address) ?? 0)
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
        const recorded = answers.get(payment.hash)
        if (recorded) return { status: 'answered', outcome: recorded }
        if (!attributable(payment.from)) return { status: 'unattributable' }

        // Inside the mutex, so the read this plan is chosen on — whether the
        // player already holds a lantern — cannot go stale before it is acted on.
        const plan = await choose()

        const info = await node.accountInfo(issuer)
        if (!info) {
          throw new Error('The issuer has no chain to write on, which cannot happen once it has issued its own assets.')
        }

        append({
          k: 'intent',
          issuer,
          hash: payment.hash,
          address: payment.from,
          plan: plan.kind,
          amount: payment.amount,
          since: info.frontier,
        })

        try {
          await plan.perform()
        } catch (error) {
          // It may have landed anyway. Ask the chain the question a restart would
          // ask, over the same window, and close the intent either way — one left
          // open would cloud this wallet for good.
          if ((await wroteSince(info.frontier, payment.from)) !== plan.kind) {
            append({ k: 'void', issuer, hash: payment.hash })
            throw error
          }
        }

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

  /** The evidence `closeIntent` reads, for a frontier recorded a moment ago rather than a run ago. */
  async function wroteSince(since: string, address: string): Promise<Plan['kind'] | undefined> {
    const recent = await node.accountHistory(issuer, { limit: historyLimit })
    const found = new Set<Plan['kind']>()
    for (const block of recent) {
      if (!block) continue
      const answer = answerIn(block, item)
      if (answer?.address === address) found.add(answer.kind)
      // Everything from here down was already on the chain when the intent was
      // written, so it belongs to some earlier answer and not to this one.
      if (block.previous === since) return found.size === 1 ? first(found) : undefined
    }
    // Nothing at all was written on top of that frontier, so nothing landed.
    return undefined
  }
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
