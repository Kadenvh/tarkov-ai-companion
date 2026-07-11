/**
 * Typed fetch wrapper over the service REST API (CONTRACTS §5).
 * Pure logic (no React, no DOM beyond fetch/Response) so it is unit-testable
 * in node with an injected fetch.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }

  /** 409 from POST /api/environment/settings/apply etc. — "game running". */
  get isConflict(): boolean {
    return this.status === 409;
  }

  /** status 0 — the service itself is unreachable. */
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

export type QueryValue = string | number | boolean | undefined;

/** Build a request URL from a path + query record (undefined values dropped). */
export function buildUrl(path: string, query?: Record<string, QueryValue>, base = ""): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return `${base}${path}${qs ? `?${qs}` : ""}`;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  fetchFn?: FetchLike;
  /** e.g. "" in the browser (vite proxy / same-origin), "http://localhost:3141" in tools */
  base?: string;
  /** invoked for every failed call (toast hook) — errors still throw */
  onError?: (error: ApiError) => void;
}

export interface ApiClient {
  get<T>(path: string, query?: Record<string, QueryValue>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

async function readError(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`.trim();
  let body: unknown;
  try {
    body = await res.json();
    if (body && typeof body === "object" && "error" in body) {
      const err = (body as { error: unknown }).error;
      if (typeof err === "string" && err.length > 0) message = err;
    }
  } catch {
    // non-JSON error body — keep the status line
  }
  return new ApiError(res.status, message, body);
}

export function createClient(opts: ClientOptions = {}): ApiClient {
  const base = opts.base ?? "";
  const doFetch: FetchLike =
    opts.fetchFn ?? ((input, init) => fetch(input, init));

  async function request<T>(path: string, init: RequestInit, query?: Record<string, QueryValue>): Promise<T> {
    const url = buildUrl(path, query, base);
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (cause) {
      const err = new ApiError(0, "Service unreachable — is the daemon running on port 3141?", cause);
      opts.onError?.(err);
      throw err;
    }
    if (!res.ok) {
      const err = await readError(res);
      opts.onError?.(err);
      throw err;
    }
    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch {
      const err = new ApiError(res.status, "Invalid JSON in response body");
      opts.onError?.(err);
      throw err;
    }
  }

  return {
    get: <T>(path: string, query?: Record<string, QueryValue>) =>
      request<T>(path, { method: "GET" }, query),
    post: <T>(path: string, body?: unknown) =>
      request<T>(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
      ),
  };
}
