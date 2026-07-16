/**
 * @tier T0 (network reads of PUBLIC tarkov.dev data; no auth, no game contact,
 * read-only).
 *
 * The PRIMARY game-data + prices source (SPEC-10 M10.2, efficiency principle 4:
 * prefer the JSON API over the maintenance-mode GraphQL). Base:
 * `https://json.tarkov.dev`, verified live 2026-07-16 — GET
 * `/{gameMode}/tasks|items|maps|hideout|barters|crafts|traders`,
 * `/{gameMode}/prices/{itemId}`, and `/status`. gameMode ∈ regular|pve.
 *
 * Discipline: cache-first. Static game data gets a long TTL (snapshot-per-patch
 * territory); prices get a 5-minute TTL matching tarkov.dev's own server cache
 * ("no need to query faster than 5 min"). ETag revalidation and retry/backoff
 * live in http.ts. Read-only: no `quota()` (the JSON API is unauthenticated and
 * not user-metered).
 */
import type { GameMode } from "@tac/shared";
import type { SourceCapability } from "../capabilities.js";
import {
  makeReading,
  systemClock,
  systemMsClock,
  type Clock,
  type HealthStatus,
  type MsClock,
  type Source,
  type SourceReading,
  type SourceRequest,
  type SourceStats,
} from "../source.js";
import { TtlCache } from "../cache.js";
import { httpGet, type FetchLike } from "../http.js";

const ID = "tarkov-dev-json";
const DEFAULT_BASE_URL = "https://json.tarkov.dev";

/** Prices match tarkov.dev's 5-minute server cache. */
export const PRICES_TTL_MS = 5 * 60 * 1000;
/** Static game data is snapshot-grade — re-fetched per patch, not per run. */
export const STATIC_TTL_MS = 24 * 60 * 60 * 1000;

export interface TarkovDevJsonSourceOptions {
  /** Override the base URL (tests point this at nothing — fetch is injected). */
  baseUrl?: string;
  /** Injectable transport (fixtures in tests). */
  fetchImpl?: FetchLike;
  /** Injectable cache (share one across sources, or isolate per test). */
  cache?: TtlCache;
  /** Injectable ISO clock for deterministic `fetchedAt`. */
  clock?: Clock;
  /** Injectable epoch-ms clock for TTL math / cache age. */
  now?: MsClock;
  /** Deterministic jitter for backoff (tests). */
  rng?: () => number;
  /** Injectable sleep so tests don't wait on retries. */
  sleep?: (ms: number) => Promise<void>;
  /** Override the User-Agent. */
  userAgent?: string;
  /** Default game mode for the path helpers. */
  gameMode?: GameMode;
}

/** Sniff a version/build string from the `/status` body (tolerant of shape). */
function extractApiVersion(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const obj = body as Record<string, unknown>;
  for (const key of ["currentVersion", "version", "generatedTime", "generated", "updated"]) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

/** Default TTL policy by capability. */
function ttlFor(capability: SourceCapability): number {
  return capability === "prices" ? PRICES_TTL_MS : STATIC_TTL_MS;
}

/**
 * Build the tarkov.dev JSON source. `fetch` is cache-first + conditional; a TTL
 * hit skips the network entirely, a 304 revalidate refreshes the TTL without a
 * re-parse. Both return `fromCache: true`.
 */
export function createTarkovDevJsonSource(opts: TarkovDevJsonSourceOptions = {}): Source {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const clock = opts.clock ?? systemClock;
  const now = opts.now ?? systemMsClock;
  const cache = opts.cache ?? new TtlCache(now);

  let apiVersion: string | undefined;
  let lastFetchIso: string | undefined;
  let lastKey: string | undefined;
  let lastError: string | undefined;

  const httpOpts = (extra: { url: string; etag?: string }) => ({
    url: extra.url,
    ...(extra.etag !== undefined ? { etag: extra.etag } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.rng !== undefined ? { rng: opts.rng } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.userAgent !== undefined ? { userAgent: opts.userAgent } : {}),
  });

  return {
    id: ID,
    kind: "rest",
    baseUrl,
    capabilities: ["game-data", "prices"],

    async fetch<T = unknown>(req: SourceRequest): Promise<SourceReading<T>> {
      const url = `${baseUrl}${req.path}`;
      const key = req.cacheKey ?? url;
      const ttl = req.ttlMs ?? ttlFor(req.capability);

      // 1) TTL hit → serve from cache, no network.
      if (cache.isFresh(key)) {
        const entry = cache.get<T>(key)!;
        lastKey = key;
        return makeReading(
          {
            sourceId: ID,
            capability: req.capability,
            data: entry.value,
            fromCache: true,
            ...(entry.etag !== undefined ? { etag: entry.etag } : {}),
          },
          clock,
        );
      }

      // 2) Stale (or absent) → conditional GET (revalidate with any cached ETag).
      const cached = cache.get<T>(key);
      let result;
      try {
        result = await httpGet(
          httpOpts({ url, ...(cached?.etag !== undefined ? { etag: cached.etag } : {}) }),
        );
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        throw err;
      }

      lastFetchIso = clock();
      lastKey = key;
      lastError = undefined;

      // 3) 304 → cache still valid, refresh its TTL, no re-parse.
      if (result.notModified && cached !== undefined) {
        cache.set(key, cached.value, ttl, cached.etag);
        return makeReading(
          {
            sourceId: ID,
            capability: req.capability,
            data: cached.value,
            fromCache: true,
            ...(cached.etag !== undefined ? { etag: cached.etag } : {}),
          },
          clock,
        );
      }

      // 4) Fresh body → cache + return.
      const data = result.body as T;
      cache.set(key, data, ttl, result.etag);
      return makeReading(
        {
          sourceId: ID,
          capability: req.capability,
          data,
          fromCache: false,
          ...(result.etag !== undefined ? { etag: result.etag } : {}),
        },
        clock,
      );
    },

    async health(): Promise<HealthStatus> {
      try {
        const result = await httpGet(httpOpts({ url: `${baseUrl}/status` }));
        const version = extractApiVersion(result.body);
        if (version !== undefined) apiVersion = version;
        lastError = undefined;
        return "connected";
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        return "error";
      }
    },

    stats(): SourceStats {
      const out: SourceStats = {};
      if (apiVersion !== undefined) out.apiVersion = apiVersion;
      if (lastFetchIso !== undefined) out.lastFetch = lastFetchIso;
      if (lastKey !== undefined) {
        const age = cache.ageSec(lastKey);
        if (age !== undefined) out.cacheAgeSec = age;
      }
      if (lastError !== undefined) out.lastError = lastError;
      return out;
    },
  };
}

/** Default instance (live base URL, real fetch). */
export const tarkovDevJsonSource = createTarkovDevJsonSource();
