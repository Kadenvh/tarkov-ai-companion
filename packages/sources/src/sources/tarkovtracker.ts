/**
 * @tier T0 (network read of the USER'S OWN progress from a third-party API using
 * a user-supplied token; never touches the game process/memory/input — the token
 * authenticates a REST read, nothing more). READ-ONLY in this slice.
 *
 * The `progress-read` source (SPEC-10 M10.2 + the §"read TarkovTracker, don't
 * fight it" pivot). Kaden runs TarkovMonitor → TarkovTracker, so TT is his live
 * progress source of truth; our tool is a quota-aware READER (GP scope). Writing
 * progress ourselves would double-spend the shared 100/day write budget and
 * collide with TarkovMonitor's cascades, so WRITES ARE DEFAULT-OFF — this source
 * implements none.
 *
 * Discipline:
 *  - base is pinned to `https://api.tarkovtracker.org` (the legacy host
 *    308-redirects and DROPS the Authorization header);
 *  - a real `User-Agent` is set (a naive fetch 403s on Cloudflare);
 *  - the quota ledger is fed from every response's `X-RateLimit-*` headers and
 *    the source REFUSES a read when `readsRemaining` hits 0 (`QuotaExhaustedError`)
 *    rather than eating a 429 against a budget shared with the user's other tools;
 *  - a short TTL + ETag keep repeat reads off the wire.
 */
import { z } from "zod";
import type { SourceCapability } from "../capabilities.js";
import {
  makeReading,
  systemClock,
  systemMsClock,
  type Clock,
  type HealthStatus,
  type MsClock,
  type QuotaState,
  type Source,
  type SourceReading,
  type SourceRequest,
  type SourceStats,
} from "../source.js";
import { TtlCache } from "../cache.js";
import { QuotaExhaustedError, QuotaLedger } from "../quota.js";
import { httpGet, unwrapData, type FetchLike } from "../http.js";

const ID = "tarkovtracker";
/** Pinned subdomain — the legacy host drops the Authorization header on its 308. */
const DEFAULT_BASE_URL = "https://api.tarkovtracker.org";
const PROGRESS_PATH = "/progress";
const PROGRESS_CAPABILITY: SourceCapability = "progress-read";
/** Repeat progress reads inside a minute serve from cache (well under the 30/min burst). */
export const PROGRESS_TTL_MS = 60 * 1000;

/** A single task's progress. Loose + passthrough — TT carries more per row. */
export const TaskProgress = z
  .object({
    id: z.string(),
    complete: z.boolean(),
    failed: z.boolean(),
    invalid: z.boolean(),
  })
  .partial()
  .passthrough();
export type TaskProgress = z.infer<typeof TaskProgress>;

/** A single objective's progress (count for kill/collect objectives). */
export const TaskObjectiveProgress = z
  .object({
    id: z.string(),
    count: z.number(),
    complete: z.boolean(),
  })
  .partial()
  .passthrough();
export type TaskObjectiveProgress = z.infer<typeof TaskObjectiveProgress>;

/** A single hideout module's build progress. */
export const HideoutModuleProgress = z
  .object({
    id: z.string(),
    complete: z.boolean(),
  })
  .partial()
  .passthrough();
export type HideoutModuleProgress = z.infer<typeof HideoutModuleProgress>;

/**
 * The `/progress` payload (GP scope). Every field optional + passthrough: the
 * real shape carries more, and we never want a schema drift to drop a read.
 */
export const TarkovTrackerProgress = z
  .object({
    tasksProgress: z.array(TaskProgress),
    taskObjectivesProgress: z.array(TaskObjectiveProgress),
    hideoutModulesProgress: z.array(HideoutModuleProgress),
    playerLevel: z.number(),
    pmcFaction: z.string(),
    displayName: z.string(),
  })
  .partial()
  .passthrough();
export type TarkovTrackerProgress = z.infer<typeof TarkovTrackerProgress>;

export interface TarkovTrackerSourceOptions {
  /** The user's API token (GP scope for read). Required. */
  token: string;
  /** Override the base URL (tests inject fetch, so this is unused there). */
  baseUrl?: string;
  /** Injectable transport (fixtures in tests). */
  fetchImpl?: FetchLike;
  /** Injectable quota ledger (share across a session, or isolate per test). */
  quota?: QuotaLedger;
  /** Injectable cache. */
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
}

/**
 * Build the TarkovTracker `progress-read` source. Quota-aware and read-only.
 * `fetch` refuses (throws `QuotaExhaustedError`) when the ledger reports the read
 * budget exhausted; otherwise it does a cache-first, conditional GET and folds
 * the response's rate-limit headers back into the ledger.
 */
export function createTarkovTrackerSource(opts: TarkovTrackerSourceOptions): Source {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const clock = opts.clock ?? systemClock;
  const now = opts.now ?? systemMsClock;
  const cache = opts.cache ?? new TtlCache(now);
  const quota = opts.quota ?? new QuotaLedger(now);
  const token = opts.token;

  let lastFetchIso: string | undefined;
  let lastKey: string | undefined;
  let lastError: string | undefined;

  const authHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
  });

  const httpOpts = (extra: { url: string; etag?: string }) => ({
    url: extra.url,
    headers: authHeaders(),
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
    capabilities: [PROGRESS_CAPABILITY],

    async fetch<T = unknown>(req: SourceRequest): Promise<SourceReading<T>> {
      if (req.capability !== PROGRESS_CAPABILITY) {
        throw new Error(`Source "${ID}" cannot satisfy capability "${req.capability}".`);
      }
      const url = `${baseUrl}${req.path}`;
      const key = req.cacheKey ?? url;
      const ttl = req.ttlMs ?? PROGRESS_TTL_MS;

      // 1) TTL hit → no network, no quota spend.
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

      // 2) Budget gate — refuse rather than eat a 429 against the shared budget.
      if (!quota.canSpend("read")) {
        throw new QuotaExhaustedError(ID, "read");
      }

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

      // Learn the real remaining budget from the response headers.
      quota.updateFromHeaders(result.headers);
      lastFetchIso = clock();
      lastKey = key;
      lastError = undefined;

      // 3) 304 → served from cache, refresh TTL, no re-parse, no extra spend.
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

      // 4) Fresh body → unwrap `{ data, errors? }`, parse tolerantly, cache.
      const parsed = TarkovTrackerProgress.parse(unwrapData(result.body) ?? {});
      const data = parsed as T;
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

    /**
     * Health WITHOUT a network probe, to conserve the shared quota. Liveness is
     * inferred from local state: no token → missing; a recorded error → error;
     * budget exhausted → stale; otherwise connected. (A live probe would spend a
     * read; SPEC-10 §"Status probe" only requires the probe to send a real UA
     * *when* it probes — which the `fetch` path does.)
     */
    async health(): Promise<HealthStatus> {
      if (token.length === 0) return "missing";
      if (lastError !== undefined) return "error";
      if (!quota.canSpend("read")) return "stale";
      return "connected";
    },

    quota(): QuotaState {
      return quota.state();
    },

    stats(): SourceStats {
      const out: SourceStats = {};
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

/** Convenience: the standard `/progress` request. */
export const TARKOVTRACKER_PROGRESS_REQUEST: SourceRequest = {
  capability: PROGRESS_CAPABILITY,
  path: PROGRESS_PATH,
};
