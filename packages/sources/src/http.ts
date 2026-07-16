/**
 * @tier T0 (network reads of PUBLIC data only — no game process, memory, input,
 * or packets are ever touched. The TarkovTracker read path adds a user token via
 * a header, but even that never contacts the game; it reads the user's own
 * progress from a third-party API).
 *
 * The disciplined HTTP client (SPEC-10 M10.1, efficiency principles 2 + 5).
 * Every source read goes through here so the discipline lives in ONE place:
 *  - conditional requests: send `If-None-Match` when an ETag is cached; a 304 is
 *    a cache hit (no body parsed, no quota spent);
 *  - retry with exponential backoff + jitter on 429 / 5xx, honoring `Retry-After`
 *    (jitter uses an INJECTABLE rng so tests are deterministic; `sleep` is
 *    injectable so tests don't actually wait);
 *  - a real `User-Agent` on every request (a naive fetch 403s on TT's Cloudflare);
 *  - tolerant of JSON bodies that carry both `data` and `errors` (partial
 *    GraphQL responses — the body is returned as-is, `errors` is not fatal).
 *
 * `fetchImpl` defaults to the global `fetch` and is injectable so unit tests run
 * with fixture responses and never touch the network.
 */

/** Default UA — real, identifying, and non-empty so Cloudflare-fronted APIs don't 403. */
export const DEFAULT_USER_AGENT =
  "tarkov-ai-companion/0.1 (+https://github.com/Kadenvh/tarkov-ai-companion)";

/** Minimal case-insensitive header accessor (a `Headers`, or any `{ get }`). */
export interface ResponseHeadersLike {
  get(name: string): string | null;
}

/** The subset of a `fetch` Response this layer relies on. `Response` satisfies it. */
export interface HttpResponse {
  status: number;
  headers: ResponseHeadersLike;
  json(): Promise<unknown>;
}

/** Request init this layer emits. A subset of `RequestInit`. */
export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  /** Serialized request body (POST submissions — the global `fetch` accepts it). */
  body?: string;
  signal?: AbortSignal;
}

/** Injectable transport. The global `fetch` is assignable to this. */
export type FetchLike = (url: string, init?: FetchInit) => Promise<HttpResponse>;

/** Thrown for non-retryable 4xx and for exhausted retries on 429/5xx. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

export interface HttpGetOptions {
  url: string;
  /** Transport (defaults to global `fetch`). Inject fixtures in tests. */
  fetchImpl?: FetchLike;
  /** Extra headers merged over the defaults (UA + Accept). */
  headers?: Record<string, string>;
  /** Cached ETag → sent as `If-None-Match` (enables 304 cache hits). */
  etag?: string;
  /** Override the User-Agent. */
  userAgent?: string;
  /** Max RETRIES after the first attempt (default 3 → up to 4 attempts). */
  maxRetries?: number;
  /** Base backoff delay in ms (default 300). */
  baseDelayMs?: number;
  /** Cap on any single backoff delay in ms (default 10s). */
  maxDelayMs?: number;
  /** Deterministic jitter source in [0,1) (default `Math.random`). */
  rng?: () => number;
  /** Injectable sleep so tests don't actually wait (default real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Optional abort signal. */
  signal?: AbortSignal;
}

export interface HttpGetResult {
  status: number;
  /** True on 304 — serve from cache, do not parse, do not spend quota. */
  notModified: boolean;
  /** ETag from the response, when present. */
  etag?: string;
  headers: ResponseHeadersLike;
  /**
   * Parsed JSON body (or `undefined` on 304 / unparseable). May carry both
   * `data` and `errors` for partial GraphQL responses — not treated as fatal.
   */
  body: unknown;
  /** Number of transport attempts made (1 = first-try success). */
  attempts: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const globalFetchImpl: FetchLike = (url, init) =>
  (globalThis.fetch as unknown as FetchLike)(url, init);

/** Retry only transient failures: 429 (rate-limited) and 5xx (server). */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** `Retry-After` in seconds → ms (ignores HTTP-date form; numeric is what TT sends). */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) ? n * 1000 : undefined;
}

/**
 * Backoff delay for `attempt` (0-based). Honors `Retry-After` exactly when the
 * server sent one; otherwise exponential (base·2^attempt) plus jitter (rng·base),
 * capped at `maxDelayMs`.
 */
function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  rng: () => number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, maxMs);
  const exp = baseMs * 2 ** attempt;
  const jitter = rng() * baseMs;
  return Math.min(exp + jitter, maxMs);
}

/**
 * GET with conditional requests, retry/backoff, and a real UA. Never throws on
 * 304 (returns `notModified`); throws `HttpError` on non-retryable 4xx and on
 * retryable failures once retries are exhausted; rethrows transport errors after
 * exhausting retries.
 */
export async function httpGet(opts: HttpGetOptions): Promise<HttpGetResult> {
  const fetchImpl = opts.fetchImpl ?? globalFetchImpl;
  const rng = opts.rng ?? Math.random;
  const sleep = opts.sleep ?? realSleep;
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 300;
  const maxDelayMs = opts.maxDelayMs ?? 10_000;

  const headers: Record<string, string> = {
    "User-Agent": opts.userAgent ?? DEFAULT_USER_AGENT,
    Accept: "application/json",
    ...opts.headers,
  };
  if (opts.etag !== undefined) headers["If-None-Match"] = opts.etag;

  const init: FetchInit = {
    method: "GET",
    headers,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };

  let attempts = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts++;
    let res: HttpResponse;
    try {
      res = await fetchImpl(opts.url, init);
    } catch (err) {
      // Transport-level failure (DNS, connection reset…): treat as transient.
      lastError = err;
      if (attempt < maxRetries) {
        await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs, rng));
        continue;
      }
      throw err;
    }

    if (res.status === 304) {
      const etag = res.headers.get("ETag") ?? undefined;
      return {
        status: 304,
        notModified: true,
        headers: res.headers,
        body: undefined,
        attempts,
        ...(etag !== undefined ? { etag } : {}),
      };
    }

    if (isRetryableStatus(res.status)) {
      lastError = new HttpError(res.status, opts.url);
      if (attempt < maxRetries) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get("Retry-After"));
        await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs, rng, retryAfterMs));
        continue;
      }
      throw lastError;
    }

    if (res.status >= 400) {
      // Non-retryable client error.
      throw new HttpError(res.status, opts.url);
    }

    // 2xx — parse the body. `data` + `errors` coexisting is tolerated (returned as-is).
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const etag = res.headers.get("ETag") ?? undefined;
    return {
      status: res.status,
      notModified: false,
      headers: res.headers,
      body,
      attempts,
      ...(etag !== undefined ? { etag } : {}),
    };
  }

  throw lastError ?? new Error("httpGet: retries exhausted");
}

/**
 * Unwrap a possibly-GraphQL-shaped body: if it carries a `data` field, return
 * `data` (partial `errors` alongside are ignored — principle 5); otherwise
 * return the body unchanged. REST JSON bodies pass straight through.
 */
export function unwrapData(body: unknown): unknown {
  if (body !== null && typeof body === "object" && "data" in body) {
    return (body as { data: unknown }).data;
  }
  return body;
}
