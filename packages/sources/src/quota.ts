/**
 * @tier T0 (an in-memory budget ledger; parses response headers other layers
 * hand it and does arithmetic — no network, no disk, no game contact).
 *
 * The quota budgeter (SPEC-10 M10.1, efficiency principle 3 — the critical one
 * for TarkovTracker). TT Free = 1,000 reads / 100 writes per day, burst 30/min,
 * SHARED across ALL of the user's tools (and Kaden also runs TarkovMonitor,
 * which spends the same budget). This ledger tracks the `X-RateLimit-*` +
 * `Retry-After` headers the server returns and lets the source REFUSE a read
 * near the limit rather than eat a 429.
 *
 * PERSISTENCE NOTE: in-memory for this slice; see the cache.ts persistence note
 * and SPEC-10's open question (config.json vs a `source_quota` table).
 */
import type { MsClock } from "./source.js";
import { systemMsClock } from "./source.js";
import type { QuotaState } from "./source.js";

/** Kinds of budgeted operations. Writes are default-off in this slice (read-only). */
export type QuotaKind = "read" | "write";

/** Minimal case-insensitive header accessor (a `Headers`, or any `{ get }`). */
export interface QuotaHeaders {
  get(name: string): string | null;
}

/** Thrown when the layer refuses to spend an exhausted budget (avoids a 429). */
export class QuotaExhaustedError extends Error {
  constructor(
    readonly sourceId: string,
    readonly kind: QuotaKind,
  ) {
    super(
      `Source "${sourceId}" is out of ${kind} quota; refusing the request ` +
        `(would hit a 429 against a budget shared with the user's other tools).`,
    );
    this.name = "QuotaExhaustedError";
  }
}

/** Parse a header string to a non-negative integer, or `undefined`. */
function parseInt0(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Interpret `X-RateLimit-Reset`. Standard usage is a unix epoch in seconds;
 * some servers send seconds-until-reset. Heuristic: values that look like an
 * epoch (>= 1e9) are treated as absolute seconds, otherwise as a delta from now.
 * Returns epoch ms.
 */
function parseReset(value: string, nowMs: number): number | undefined {
  const n = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(n)) return undefined;
  return n >= 1_000_000_000 ? n * 1000 : nowMs + n * 1000;
}

/**
 * Per-source budget ledger. Reads/writes remaining stay `undefined` until the
 * first response teaches us the limit (optimistic: `canSpend` allows the first
 * request, then honors whatever the server reported).
 */
export class QuotaLedger {
  private reads?: number;
  private writes?: number;
  private resetMs?: number;
  private retryMs?: number;

  constructor(private readonly now: MsClock = systemMsClock) {}

  /**
   * Fold a response's rate-limit headers into the ledger. Reads come from
   * `X-RateLimit-Remaining`; writes from the (rarely present)
   * `X-RateLimit-Remaining-Write`. `X-RateLimit-Reset` and `Retry-After` set the
   * reset instant / backoff hint.
   */
  updateFromHeaders(headers: QuotaHeaders): void {
    const remaining = parseInt0(headers.get("X-RateLimit-Remaining"));
    if (remaining !== undefined) this.reads = remaining;

    const remainingWrite = parseInt0(headers.get("X-RateLimit-Remaining-Write"));
    if (remainingWrite !== undefined) this.writes = remainingWrite;

    const reset = headers.get("X-RateLimit-Reset");
    if (reset !== null) {
      const ms = parseReset(reset, this.now());
      if (ms !== undefined) this.resetMs = ms;
    }

    const retryAfter = parseInt0(headers.get("Retry-After"));
    if (retryAfter !== undefined) {
      this.retryMs = retryAfter * 1000;
      // If the server gave only Retry-After, use it as the reset horizon too.
      if (reset === null) this.resetMs = this.now() + retryAfter * 1000;
    }
  }

  /** Manually seed the read budget (e.g. from a persisted ledger). */
  seed(state: { readsRemaining?: number; writesRemaining?: number }): void {
    if (state.readsRemaining !== undefined) this.reads = state.readsRemaining;
    if (state.writesRemaining !== undefined) this.writes = state.writesRemaining;
  }

  /**
   * Whether a `kind` operation may be spent. `true` while the budget is unknown
   * (first request) or positive; `false` once the server reports 0 remaining.
   */
  canSpend(kind: QuotaKind): boolean {
    const remaining = kind === "read" ? this.reads : this.writes;
    if (remaining === undefined) return true;
    return remaining > 0;
  }

  /** Current budget snapshot for the status surface (M10.3). */
  state(): QuotaState {
    return {
      ...(this.reads !== undefined ? { readsRemaining: this.reads } : {}),
      ...(this.writes !== undefined ? { writesRemaining: this.writes } : {}),
      ...(this.resetMs !== undefined ? { resetsAt: new Date(this.resetMs).toISOString() } : {}),
    };
  }

  /** Server-suggested backoff (ms) from the last `Retry-After`, if any. */
  retryDelayMs(): number | undefined {
    return this.retryMs;
  }
}
