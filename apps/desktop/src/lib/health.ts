/**
 * Pure health-gate helper: poll a sidecar's `GET /api/health` until it returns
 * 200, backing off between attempts, and give up after a wall-clock timeout.
 * The shell uses this to hold the BrowserWindow closed until @tac/service is
 * actually serving, so the renderer never sees a blank connection-refused page.
 *
 * `fetch`, `sleep` and `now` are all injected so the retry / timeout logic is
 * fully deterministic under test with no real sockets or timers.
 *
 * @tier T0 — HTTP GET against OUR loopback service only.
 */

/** Minimal response shape we need — a real `Response` satisfies this. */
export interface HealthResponse {
  readonly ok: boolean;
  readonly status: number;
}

export type HealthFetch = (url: string) => Promise<HealthResponse>;

export interface HealthGateOptions {
  /** Full health URL, e.g. `http://127.0.0.1:3141/api/health`. */
  readonly url: string;
  readonly fetchImpl: HealthFetch;
  /** Total budget in ms before rejecting. Default 30_000. */
  readonly timeoutMs?: number;
  /** First inter-attempt delay in ms. Default 150. */
  readonly intervalMs?: number;
  /** Backoff cap in ms; delay doubles each miss up to this. Default 1_000. */
  readonly maxIntervalMs?: number;
  /** Injectable sleep; defaults to a real `setTimeout` promise. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class HealthGateTimeoutError extends Error {
  constructor(
    readonly url: string,
    readonly elapsedMs: number,
    readonly attempts: number,
  ) {
    super(`health gate for ${url} timed out after ${elapsedMs}ms (${attempts} attempts)`);
    this.name = "HealthGateTimeoutError";
  }
}

/**
 * Resolve (with the number of attempts made) as soon as the endpoint returns a
 * 200. A non-200 status or a thrown fetch (connection refused while the sidecar
 * boots) counts as a miss: we back off and retry until the budget is spent, at
 * which point we reject with {@link HealthGateTimeoutError}.
 */
export async function waitForHealth(options: HealthGateOptions): Promise<number> {
  const {
    url,
    fetchImpl,
    timeoutMs = 30_000,
    intervalMs = 150,
    maxIntervalMs = 1_000,
    sleep = realSleep,
    now = Date.now,
  } = options;

  const start = now();
  const deadline = start + timeoutMs;
  let delay = intervalMs;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    try {
      const res = await fetchImpl(url);
      if (res.ok && res.status === 200) return attempts;
    } catch {
      // sidecar not up yet — treated as a miss
    }

    const elapsed = now() - start;
    if (now() >= deadline) throw new HealthGateTimeoutError(url, elapsed, attempts);

    // Don't oversleep past the deadline.
    const remaining = deadline - now();
    await sleep(Math.max(0, Math.min(delay, remaining)));
    delay = Math.min(delay * 2, maxIntervalMs);
  }
}
