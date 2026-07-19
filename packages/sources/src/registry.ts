/**
 * @tier T0 (in-memory registry + status aggregator; no I/O of its own — it only
 * orchestrates sources, which own the network reads).
 *
 * The source registry and status aggregator (SPEC-10 M10.1 + M10.3). One place
 * to register every remote feed, resolve by capability, and build the
 * "latest-status, approachable" array the UI and `GET /api/sources/status`
 * render. Mirror of `@tac/connectors`' `ConnectorRegistry` shape.
 */
import type { SourceCapability } from "./capabilities.js";
import type { HealthStatus, QuotaState, Source } from "./source.js";

/** Thrown when two sources try to register under the same id. */
export class DuplicateSourceError extends Error {
  constructor(readonly sourceId: string) {
    super(`A source with id "${sourceId}" is already registered.`);
    this.name = "DuplicateSourceError";
  }
}

/**
 * The M10.3 per-source status row. `up` collapses `health()` to reachable
 * (connected|stale) vs. not (missing|error). The rest is best-effort from the
 * source's optional `stats()` + `quota()`.
 */
export interface SourceStatus {
  id: string;
  up: boolean;
  apiVersion?: string;
  lastFetch?: string;
  cacheAgeSec?: number;
  quota?: QuotaState;
  lastError?: string;
}

/** Best-effort error-message extraction (Error → message, else String()). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SourceRegistry {
  private readonly sources = new Map<string, Source>();

  /** Register a source. Throws `DuplicateSourceError` on a repeated id. */
  register(source: Source): void {
    if (this.sources.has(source.id)) {
      throw new DuplicateSourceError(source.id);
    }
    this.sources.set(source.id, source);
  }

  /** All registered sources, in registration order. */
  list(): Source[] {
    return [...this.sources.values()];
  }

  /** A source by id, or `undefined`. */
  get(id: string): Source | undefined {
    return this.sources.get(id);
  }

  /** Every registered source advertising `cap`. */
  byCapability(cap: SourceCapability): Source[] {
    return this.list().filter((s) => s.capabilities.includes(cap));
  }

  /** Health of every registered source, keyed by id. */
  async healthAll(): Promise<Record<string, HealthStatus>> {
    const out: Record<string, HealthStatus> = {};
    for (const source of this.list()) {
      out[source.id] = await source.health();
    }
    return out;
  }

  /**
   * The M10.3 status array: `health()` + `quota()` + optional `stats()` per
   * source. A source whose `health()` throws is reported `up: false` with the
   * thrown message as `lastError` (the status probe must never itself throw).
   */
  async status(): Promise<SourceStatus[]> {
    const out: SourceStatus[] = [];
    for (const source of this.list()) {
      let up = false;
      let healthError: string | undefined;
      try {
        const health = await source.health();
        up = health === "connected" || health === "stale";
      } catch (err) {
        up = false;
        healthError = errorMessage(err);
      }

      const stats = source.stats?.() ?? {};
      const quota = source.quota?.();
      const lastError = healthError ?? stats.lastError;

      out.push({
        id: source.id,
        up,
        ...(stats.apiVersion !== undefined ? { apiVersion: stats.apiVersion } : {}),
        ...(stats.lastFetch !== undefined ? { lastFetch: stats.lastFetch } : {}),
        ...(stats.cacheAgeSec !== undefined ? { cacheAgeSec: stats.cacheAgeSec } : {}),
        ...(quota !== undefined ? { quota } : {}),
        ...(lastError !== undefined ? { lastError } : {}),
      });
    }
    return out;
  }
}
