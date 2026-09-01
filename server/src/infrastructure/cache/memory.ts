/**
 * A small per-process TTL cache (§47).
 *
 * Deliberately minimal: a Map with expiry and explicit invalidation. It caches
 * values that are read on nearly every request and change rarely — the
 * role→permission matrix, and a user's roles and status.
 *
 * Per-process, so a second API instance would have its own copy. That is
 * acceptable at these TTLs; a shared cache is one of the documented triggers
 * for introducing Redis (§9.5).
 */
export interface CacheOptions {
  ttlMs: number
  /** Guards against unbounded growth when keys are user-supplied. */
  maxEntries?: number
}

interface Entry<V> {
  value: V
  expiresAt: number
}

export class TtlCache<V> {
  private readonly store = new Map<string, Entry<V>>()
  private readonly ttlMs: number
  private readonly maxEntries: number

  constructor(options: CacheOptions) {
    this.ttlMs = options.ttlMs
    this.maxEntries = options.maxEntries ?? 10_000
  }

  get(key: string): V | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: V): void {
    if (this.store.size >= this.maxEntries) {
      // Cheap eviction: drop the oldest insertion. Map preserves insertion order.
      const oldest = this.store.keys().next()
      if (!oldest.done) this.store.delete(oldest.value)
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs })
  }

  /** Reads through to `load` on a miss, caching the result. */
  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const cached = this.get(key)
    if (cached !== undefined) return cached
    const value = await load()
    this.set(key, value)
    return value
  }

  invalidate(key: string): void {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }

  get size(): number {
    return this.store.size
  }
}
