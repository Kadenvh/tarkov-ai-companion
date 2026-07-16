/**
 * @tier T0 (network reads of PUBLIC EFT-wiki pages only; no auth, no game
 * contact, read-only).
 *
 * The `story` source (SPEC-10 M10.4). The EFT Fandom wiki is the canonical text
 * for narrative/story chapters — tarkov.dev carries none. This is the ONE source
 * that must send a proper `User-Agent`: Fandom's edge returns 403/402 to naive
 * fetchers, so `httpGet`'s real UA (default or override) is load-bearing here,
 * not incidental.
 *
 * Base: `https://escapefromtarkov.fandom.com`, MediaWiki API at `/api.php`.
 * A story read is `GET /api.php?action=parse&format=json&prop=wikitext&page=<page>`;
 * the response envelope is `{ parse: { title, pageid, wikitext: { "*": "…" } } }`
 * (or `wikitext` as a bare string under formatversion=2 — both tolerated).
 *
 * Discipline: cache-first with a LONG TTL — story content is static per patch, so
 * a re-read inside the TTL never touches the wire. ETag revalidation and
 * retry/backoff live in `http.ts`. Read-only: no `quota()` (the wiki API is
 * unauthenticated and not user-metered).
 *
 * REUSE NOTE: `@tac/data-core` owns the wiki *parser* (`parseQuestInfobox`,
 * story schema) but has NO MediaWiki *fetch client* — its `fetchJson` targets
 * json.tarkov.dev only. So this source implements the minimal tolerant
 * fetch+extract itself (envelope → raw wikitext) and hands the raw wikitext on;
 * downstream parsing stays in data-core. When data-core grows a MediaWiki client,
 * this source should wrap it (future consolidation).
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
  type Source,
  type SourceReading,
  type SourceRequest,
  type SourceStats,
} from "../source.js";
import { TtlCache } from "../cache.js";
import { httpGet, type FetchLike } from "../http.js";

const ID = "eft-wiki";
const DEFAULT_BASE_URL = "https://escapefromtarkov.fandom.com";
const STORY_CAPABILITY: SourceCapability = "story";

/** Story content is static per patch — a week keeps repeat reads off the wire. */
export const STORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The MediaWiki `action=parse&prop=wikitext` envelope, tolerant of shape:
 * `wikitext` is `{ "*": string }` (default format) or a bare string
 * (formatversion=2). Everything is optional + passthrough so a schema drift
 * never drops a read.
 */
const WikitextField = z.union([z.object({ "*": z.string() }).passthrough(), z.string()]);
export const MediaWikiParseResponse = z
  .object({
    parse: z
      .object({
        title: z.string(),
        pageid: z.number(),
        wikitext: WikitextField,
      })
      .partial()
      .passthrough()
      .optional(),
  })
  .passthrough();
export type MediaWikiParseResponse = z.infer<typeof MediaWikiParseResponse>;

/** A provenance-tagged story reading: the requested page + its raw wikitext. */
export interface WikiStoryContent {
  /** The wiki page requested (join key into data-core's story dataset). */
  page: string;
  /** Canonical page title from the API, when present. */
  title?: string;
  /** MediaWiki page id, when present. */
  pageId?: number;
  /** Raw wikitext (may be "" when the page is missing / the field is absent). */
  wikitext: string;
}

export interface EftWikiSourceOptions {
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
  /** Override the User-Agent (defaults to the layer's real UA — Fandom 403s naive fetchers). */
  userAgent?: string;
}

/**
 * Build the `?path=` for a story read of `page`. Callers hand this to
 * `source.fetch` (mirrors `TARKOVTRACKER_PROGRESS_REQUEST`).
 */
export function eftWikiStoryRequest(page: string): SourceRequest {
  const params = new URLSearchParams({
    action: "parse",
    format: "json",
    prop: "wikitext",
    page,
  });
  return { capability: STORY_CAPABILITY, path: `/api.php?${params.toString()}` };
}

/** Pull the requested page name back out of a `?path=` (for the reading label). */
function pageFromPath(path: string): string {
  const q = path.indexOf("?");
  if (q === -1) return "";
  return new URLSearchParams(path.slice(q + 1)).get("page") ?? "";
}

/** Tolerantly extract `{ title?, pageId?, wikitext }` from a parse envelope. */
function extractStory(page: string, body: unknown): WikiStoryContent {
  const parsed = MediaWikiParseResponse.safeParse(body);
  const parse = parsed.success ? parsed.data.parse : undefined;

  let wikitext = "";
  const wt = parse?.wikitext;
  if (typeof wt === "string") {
    wikitext = wt;
  } else if (wt !== null && typeof wt === "object" && typeof wt["*"] === "string") {
    wikitext = wt["*"];
  }

  return {
    page,
    ...(parse?.title !== undefined ? { title: parse.title } : {}),
    ...(parse?.pageid !== undefined ? { pageId: parse.pageid } : {}),
    wikitext,
  };
}

/** Sniff the MediaWiki version from a `siteinfo` probe (tolerant of shape). */
function extractGenerator(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const query = (body as Record<string, unknown>)["query"];
  if (query === null || typeof query !== "object") return undefined;
  const general = (query as Record<string, unknown>)["general"];
  if (general === null || typeof general !== "object") return undefined;
  const generator = (general as Record<string, unknown>)["generator"];
  return typeof generator === "string" && generator.length > 0 ? generator : undefined;
}

/**
 * Build the EFT-wiki `story` source. `fetch` is cache-first + conditional: a TTL
 * hit skips the network, a 304 revalidate refreshes the TTL without a re-parse.
 * Every request carries a real User-Agent (Fandom 403/402s naive fetchers).
 */
export function createEftWikiSource(opts: EftWikiSourceOptions = {}): Source {
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
    kind: "mediawiki",
    baseUrl,
    capabilities: [STORY_CAPABILITY],

    async fetch<T = unknown>(req: SourceRequest): Promise<SourceReading<T>> {
      if (req.capability !== STORY_CAPABILITY) {
        throw new Error(`Source "${ID}" cannot satisfy capability "${req.capability}".`);
      }
      const url = `${baseUrl}${req.path}`;
      const key = req.cacheKey ?? url;
      const ttl = req.ttlMs ?? STORY_TTL_MS;

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

      // 4) Fresh body → extract wikitext tolerantly, cache the story content.
      const content = extractStory(pageFromPath(req.path), result.body);
      const data = content as unknown as T;
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
      const url = `${baseUrl}/api.php?action=query&meta=siteinfo&siprop=general&format=json`;
      try {
        const result = await httpGet(httpOpts({ url }));
        const generator = extractGenerator(result.body);
        if (generator !== undefined) apiVersion = generator;
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
export const eftWikiSource = createEftWikiSource();
