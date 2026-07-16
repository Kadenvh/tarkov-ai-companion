/**
 * @tier T0 (in-memory TTL cache; no I/O — it only stores values other layers
 * already fetched, so nothing here touches disk, network, or the game).
 *
 * The per-source TTL + ETag cache (SPEC-10 M10.1, efficiency principle 1). This
 * is the "nothing re-fetches inside its TTL" discipline made concrete: static
 * game data gets a long TTL, prices a 5-minute TTL, and a stored ETag lets the
 * HTTP layer revalidate cheaply (a 304 costs no quota and no parse).
 *
 * PERSISTENCE NOTE: an in-memory `Map` is sufficient for this slice. Persisting
 * the cache (and the quota ledger) across restarts is a later concern — SPEC-10
 * open question ("persist the quota ledger where?"). When it lands it should sit
 * behind this same `get/set/isFresh` shape.
 */
import type { MsClock } from "./source.js";
import { systemMsClock } from "./source.js";

/** A cached payload plus the metadata the HTTP layer needs to revalidate it. */
export interface CacheEntry<T = unknown> {
  value: T;
  /** Entity tag for `If-None-Match` conditional requests. */
  etag?: string;
  /** Epoch ms the value was stored (drives `cacheAgeSec`). */
  storedAt: number;
  /** Epoch ms after which the value is stale. */
  expiresAt: number;
}

/** TTL cache keyed by request (URL or an explicit cache key). Inject a clock in tests. */
export class TtlCache {
  private readonly store = new Map<string, CacheEntry>();

  constructor(private readonly now: MsClock = systemMsClock) {}

  /** The raw entry (fresh or stale) — callers use `isFresh` to decide, or the ETag to revalidate. */
  get<T = unknown>(key: string): CacheEntry<T> | undefined {
    return this.store.get(key) as CacheEntry<T> | undefined;
  }

  /** Store `value` under `key` with a TTL (ms) and an optional ETag. */
  set<T>(key: string, value: T, ttlMs: number, etag?: string): void {
    const storedAt = this.now();
    this.store.set(key, {
      value,
      storedAt,
      expiresAt: storedAt + ttlMs,
      ...(etag !== undefined ? { etag } : {}),
    });
  }

  /** True when `key` is present and still within its TTL. */
  isFresh(key: string): boolean {
    const entry = this.store.get(key);
    return entry !== undefined && this.now() < entry.expiresAt;
  }

  /** Age of the cached value in seconds, or `undefined` if absent. */
  ageSec(key: string): number | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    return (this.now() - entry.storedAt) / 1000;
  }

  /** Drop a single key. */
  delete(key: string): void {
    this.store.delete(key);
  }

  /** Drop everything. */
  clear(): void {
    this.store.clear();
  }

  /** Number of entries (fresh or stale). */
  get size(): number {
    return this.store.size;
  }
}
