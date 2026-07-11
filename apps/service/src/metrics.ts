import type { ProfileStore } from "@tac/state-engine";

/**
 * M5.6 counter-metric — "between-raid cost" instrumentation. The NSM is time
 * NOT spent in menus/spreadsheets; this counts the app-side of that ledger:
 * WS-connected seconds (a client had the UI open) and API request counts.
 *
 * Counters live in memory for the current process (`session`) and accumulate
 * into the profile DB `meta.metrics` (`lifetime`). Persistence writes bypass
 * the store's event emitter on purpose — bookkeeping must not trigger
 * `state.changed` (which would debounce-rebuild the plan every flush).
 */

export interface MetricsSnapshot {
  session: {
    startedAt: string;
    requests: number;
    requestsByRoute: Record<string, number>;
    wsClients: number;
    wsConnectedSeconds: number;
  };
  lifetime: {
    requests: number;
    wsConnectedSeconds: number;
    updatedAt: string | null;
  };
}

interface PersistedMetrics {
  requests: number;
  wsConnectedSeconds: number;
  updatedAt: string;
}

const META_KEY = "metrics";

export class Metrics {
  private store: ProfileStore | null = null;
  private readonly startedAt = new Date().toISOString();
  private requests = 0;
  private requestsByRoute = new Map<string, number>();
  private wsSecondsClosed = 0;
  private readonly wsOpenSince = new Map<object, number>();
  /** counters already folded into the persisted lifetime totals */
  private persistedRequests = 0;
  private persistedWsSeconds = 0;
  private timer: NodeJS.Timeout | null = null;

  /** Point at (a new) profile store; flushes to the previous one first. */
  attachStore(store: ProfileStore, flushIntervalMs = 30_000): void {
    if (this.store) this.persist();
    this.store = store;
    // per-profile lifetime baselines restart with the new store
    this.persistedRequests = this.requests;
    this.persistedWsSeconds = this.wsSecondsElapsed();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.persist(), flushIntervalMs);
    this.timer.unref();
  }

  countRequest(url: string): void {
    this.requests += 1;
    const route = url.split("?")[0]!.split("/").slice(0, 4).join("/") || "/";
    this.requestsByRoute.set(route, (this.requestsByRoute.get(route) ?? 0) + 1);
  }

  wsConnected(socket: object): void {
    this.wsOpenSince.set(socket, Date.now());
  }

  wsDisconnected(socket: object): void {
    const since = this.wsOpenSince.get(socket);
    if (since !== undefined) {
      this.wsSecondsClosed += (Date.now() - since) / 1000;
      this.wsOpenSince.delete(socket);
    }
  }

  private wsSecondsElapsed(): number {
    const now = Date.now();
    let open = 0;
    for (const since of this.wsOpenSince.values()) open += (now - since) / 1000;
    return this.wsSecondsClosed + open;
  }

  private readPersisted(): PersistedMetrics {
    const raw = this.store?.getMeta(META_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<PersistedMetrics>;
        return {
          requests: Number(parsed.requests) || 0,
          wsConnectedSeconds: Number(parsed.wsConnectedSeconds) || 0,
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        };
      } catch {
        // fall through to zeros
      }
    }
    return { requests: 0, wsConnectedSeconds: 0, updatedAt: new Date().toISOString() };
  }

  /** Fold session deltas into the profile's lifetime totals (meta.metrics). */
  persist(): void {
    if (!this.store) return;
    const persisted = this.readPersisted();
    const wsSeconds = this.wsSecondsElapsed();
    const next: PersistedMetrics = {
      requests: persisted.requests + (this.requests - this.persistedRequests),
      wsConnectedSeconds:
        Math.round((persisted.wsConnectedSeconds + (wsSeconds - this.persistedWsSeconds)) * 10) / 10,
      updatedAt: new Date().toISOString(),
    };
    this.persistedRequests = this.requests;
    this.persistedWsSeconds = wsSeconds;
    // direct write: metrics bookkeeping must not emit state.changed
    this.store.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(META_KEY, JSON.stringify(next));
  }

  snapshot(): MetricsSnapshot {
    const persisted = this.store ? this.readPersisted() : null;
    const wsSeconds = this.wsSecondsElapsed();
    return {
      session: {
        startedAt: this.startedAt,
        requests: this.requests,
        requestsByRoute: Object.fromEntries(this.requestsByRoute),
        wsClients: this.wsOpenSince.size,
        wsConnectedSeconds: Math.round(wsSeconds * 10) / 10,
      },
      lifetime: {
        requests: (persisted?.requests ?? 0) + (this.requests - this.persistedRequests),
        wsConnectedSeconds:
          Math.round(((persisted?.wsConnectedSeconds ?? 0) + (wsSeconds - this.persistedWsSeconds)) * 10) / 10,
        updatedAt: persisted?.updatedAt ?? null,
      },
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.persist();
  }
}
