import type { FetchInit, FetchLike, HttpResponse } from "../src/http.js";

/** One recorded transport call (URL + the init the client emitted). */
export interface RecordedCall {
  url: string;
  init?: FetchInit;
}

/** A 2xx JSON response with an optional ETag + extra headers. */
export function jsonResponse(
  body: unknown,
  opts: { status?: number; etag?: string; headers?: Record<string, string> } = {},
): HttpResponse {
  const headers = new Headers(opts.headers ?? {});
  if (opts.etag !== undefined) headers.set("ETag", opts.etag);
  return {
    status: opts.status ?? 200,
    headers,
    json: async () => body,
  };
}

/** A bodyless status response (304 / 429 / 5xx / 4xx). `json()` throws if called. */
export function statusResponse(
  status: number,
  opts: { etag?: string; headers?: Record<string, string> } = {},
): HttpResponse {
  const headers = new Headers(opts.headers ?? {});
  if (opts.etag !== undefined) headers.set("ETag", opts.etag);
  return {
    status,
    headers,
    json: async () => {
      throw new Error(`no JSON body for status ${status}`);
    },
  };
}

/**
 * A `fetchImpl` that returns queued responses in order (repeating the last one
 * once exhausted, so all-5xx retry tests work) and records every call.
 */
export function scriptedFetch(responses: HttpResponse[]): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, ...(init !== undefined ? { init } : {}) });
    const res = responses[Math.min(i, responses.length - 1)];
    i++;
    if (res === undefined) throw new Error("scriptedFetch: no response queued");
    return res;
  };
  return { fetchImpl, calls };
}

/** A mutable epoch-ms clock for TTL/quota tests. */
export function mutableMsClock(start = 0): {
  now: () => number;
  set: (t: number) => void;
  advance: (delta: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    set: (value) => {
      t = value;
    },
    advance: (delta) => {
      t += delta;
    },
  };
}

/** A test sleep that never actually waits but records the requested delays. */
export function fakeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    sleep: async (ms) => {
      delays.push(ms);
    },
    delays,
  };
}
