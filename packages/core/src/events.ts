export type Listener<Payload> = (payload: Payload) => void

/** A small typed emitter. `on` returns its own unsubscribe. */
export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>()

  on<Key extends keyof Events & string>(event: Key, listener: Listener<Events[Key]>): () => void {
    const set = (this.listeners.get(event) ?? new Set()) as Set<Listener<Events[Key]>>
    set.add(listener)
    this.listeners.set(event, set as unknown as Set<Listener<never>>)
    return () => this.off(event, listener)
  }

  off<Key extends keyof Events & string>(event: Key, listener: Listener<Events[Key]>): void {
    const set = this.listeners.get(event) as Set<Listener<Events[Key]>> | undefined
    set?.delete(listener)
  }

  emit<Key extends keyof Events & string>(event: Key, payload: Events[Key]): void {
    const set = this.listeners.get(event) as Set<Listener<Events[Key]>> | undefined
    if (!set) return
    for (const listener of [...set]) {
      try {
        listener(payload)
      } catch {
        // A listener that throws is the listener's problem, not the wallet's.
      }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
