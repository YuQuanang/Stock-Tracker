/**
 * Bounded in-memory Least-Recently-Used (LRU) cache with TTL and in-flight
 * request deduplication.
 *
 * Keeps external provider traffic minimal and prevents duplicate concurrent
 * requests when multiple callers ask for the same symbol or FX pair at once.
 */

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<V> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly inFlight = new Map<string, Promise<V>>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = 250) {
    this.maxEntries = maxEntries;
  }

  get(key: string, now: number = Date.now()): V | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh insertion order for LRU eviction.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMilliseconds: number, now: number = Date.now()): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, {
      value,
      expiresAt: now + ttlMilliseconds,
    });
  }

  /**
   * Returns a cached value if fresh; otherwise deduplicates concurrent calls
   * for the same key and caches the resolved value for `ttlMilliseconds`.
   */
  async getOrFetch(
    key: string,
    ttlMilliseconds: number,
    fetcher: () => Promise<V>,
  ): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const pending = this.inFlight.get(key);
    if (pending !== undefined) {
      return pending;
    }

    const promise = fetcher()
      .then((value) => {
        this.set(key, value, ttlMilliseconds);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.store.clear();
    this.inFlight.clear();
  }
}

