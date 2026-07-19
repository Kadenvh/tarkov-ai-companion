import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SourceRegistry,
  QuotaLedger,
  createTarkovTrackerSource,
  type FetchLike,
  type HttpResponse,
} from "@tac/sources";
import { buildSourceRegistry } from "../src/registries.js";
import type { ServiceConfig } from "../src/config.js";
import { TrackerSyncScheduler } from "../src/tracker-sync.js";
import { closeApps, testApp } from "./helpers.js";

/**
 * SPEC-8: TarkovTracker as the primary READ-MOSTLY state feed. Everything here
 * is driven by an injected fetch (never the network) and the scheduler runs
 * against injected timers, so the suite is deterministic and offline.
 */

/** A fake `HttpResponse` (the shape the M10 sources consume). */
function fakeResponse(body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    json: async () => body,
  };
}

/** A `/progress` payload with a rate-limit header so the quota ledger learns a budget. */
const progressBody = {
  data: {
    tasksProgress: [
      { id: "5936d90786f7742b1420ba5b", complete: true },
      { id: "66058ccf06ef1d50a60c1f48", complete: false, failed: true },
    ],
    taskObjectivesProgress: [{ id: "5967530a86f77462ba22226b-1", complete: false, count: 3 }],
    hideoutModulesProgress: [{ id: "5d484fcd654e7668ec2ec322-2", complete: true }],
    playerLevel: 42,
    pmcFaction: "USEC",
  },
};

const ttFetch = (headers: Record<string, string> = { "X-RateLimit-Remaining": "998" }): FetchLike =>
  async (url) => (url.includes("/progress") ? fakeResponse(progressBody, 200, headers) : fakeResponse({}));

const withToken = (): ServiceConfig => ({
  profiles: [{ key: "main-regular", label: "Main (PvP)", gameMode: "regular" }],
  activeProfile: "main-regular",
  tarkovTrackerToken: "PVP_tkn",
});

describe("POST /api/state/sync/tarkovtracker (on-demand read feed)", () => {
  afterEach(closeApps);

  it("200s with a token: pulls /progress and applies it to the store", async () => {
    const sources = buildSourceRegistry({ token: "PVP_tkn", fetchImpl: ttFetch() });
    const app = await testApp({ config: withToken(), sources, trackerSyncIntervalMs: 0 });

    const res = await app.inject({ method: "POST", url: "/api/state/sync/tarkovtracker" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.applied).toMatchObject({ tasks: 2, objectives: 1, hideout: 1, level: true, faction: true });
    expect(body.changed).toBe(true);
    expect(body.quota.readsRemaining).toBe(998);

    expect(app.tac.store.level).toBe(42);
    expect(app.tac.store.faction).toBe("USEC");
    expect(app.tac.store.getTask("66058ccf06ef1d50a60c1f48")).toMatchObject({ failed: true });
  });

  it("a second sync of unchanged progress applies nothing (changed:false)", async () => {
    const sources = buildSourceRegistry({ token: "PVP_tkn", fetchImpl: ttFetch() });
    const app = await testApp({ config: withToken(), sources, trackerSyncIntervalMs: 0 });

    await app.inject({ method: "POST", url: "/api/state/sync/tarkovtracker" });
    // second read serves from the source's TTL cache; the mapper diffs to a no-op
    const res = await app.inject({ method: "POST", url: "/api/state/sync/tarkovtracker" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.changed).toBe(false);
    expect(body.applied).toEqual({ tasks: 0, objectives: 0, hideout: 0, traders: 0, level: false, faction: false });
  });

  it("409s when no TarkovTracker token is connected", async () => {
    const app = await testApp(); // no token
    const res = await app.inject({ method: "POST", url: "/api/state/sync/tarkovtracker" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not connected/i);
  });

  it("429s (refuses) when the shared read quota is exhausted", async () => {
    const quota = new QuotaLedger();
    quota.seed({ readsRemaining: 0 });
    const sources = new SourceRegistry();
    sources.register(createTarkovTrackerSource({ token: "PVP_tkn", fetchImpl: ttFetch(), quota, sleep: async () => {} }));
    const app = await testApp({ config: withToken(), sources, trackerSyncIntervalMs: 0 });

    const res = await app.inject({ method: "POST", url: "/api/state/sync/tarkovtracker" });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatch(/quota/i);
  });
});

describe("ServiceRuntime.syncTarkovTracker (best-effort, never throws)", () => {
  afterEach(closeApps);

  it("TarkovTracker down is a NO-OP, not a throw", async () => {
    const downFetch: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const sources = new SourceRegistry();
    // no-op sleep so the retry/backoff doesn't slow the test
    sources.register(createTarkovTrackerSource({ token: "PVP_tkn", fetchImpl: downFetch, sleep: async () => {} }));
    const app = await testApp({ config: withToken(), sources, trackerSyncIntervalMs: 0 });

    const result = await app.tac.syncTarkovTracker();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unreachable");
    // store untouched
    expect(app.tac.store.level).toBe(1);
  });

  it("401 surfaces as unauthorized without crashing", async () => {
    const authFetch: FetchLike = async () => fakeResponse({ error: "unauthorized" }, 401);
    const sources = new SourceRegistry();
    sources.register(createTarkovTrackerSource({ token: "PVP_dead", fetchImpl: authFetch, sleep: async () => {} }));
    const app = await testApp({ config: withToken(), sources, trackerSyncIntervalMs: 0 });

    const result = await app.tac.syncTarkovTracker();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unauthorized");
  });

  it("scheduled sync SKIPS when the read budget is at/under the floor (no wire read)", async () => {
    const quota = new QuotaLedger();
    quota.seed({ readsRemaining: 10 });
    let fetched = 0;
    const countingFetch: FetchLike = async (url) => {
      fetched++;
      return url.includes("/progress") ? fakeResponse(progressBody) : fakeResponse({});
    };
    const sources = new SourceRegistry();
    sources.register(createTarkovTrackerSource({ token: "PVP_tkn", fetchImpl: countingFetch, quota, sleep: async () => {} }));
    const app = await testApp({ config: withToken(), sources, trackerSyncIntervalMs: 0 });

    const result = await app.tac.syncTarkovTracker({ quotaFloor: 50 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("quota-low");
    expect(fetched).toBe(0);
    // an EXPLICIT sync (no floor) still reads down to a hard zero
    const explicit = await app.tac.syncTarkovTracker();
    expect(explicit.ok).toBe(true);
    expect(fetched).toBe(1);
  });

  it("runs a startup sync when a token is configured, and the scheduler is stoppable", async () => {
    const sources = buildSourceRegistry({ token: "PVP_tkn", fetchImpl: ttFetch() });
    const app = await testApp({
      config: withToken(),
      sources,
      trackerSyncIntervalMs: 60_000,
      trackerSyncOnStart: true,
    });
    // startup sync is fire-and-forget → wait for it to land in the store
    await vi.waitFor(() => expect(app.tac.store.level).toBe(42));
    expect(app.tac.trackerSyncRunning()).toBe(true);
    await app.close(); // clean shutdown stops the scheduler
    expect(app.tac.trackerSyncRunning()).toBe(false);
  });
});

describe("TrackerSyncScheduler (injectable + stoppable)", () => {
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it("fires a startup sync, ticks on the interval, and stops cleanly", async () => {
    let calls = 0;
    const ticks: Array<() => void> = [];
    const scheduler = new TrackerSyncScheduler({
      intervalMs: 1000,
      sync: async () => {
        calls++;
      },
      setIntervalFn: (fn) => {
        ticks.push(fn);
        return 0 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });

    scheduler.start();
    await flush();
    expect(calls).toBe(1); // syncOnStart
    expect(scheduler.running).toBe(true);

    ticks[0]!(); // interval fires
    await flush();
    expect(calls).toBe(2);

    scheduler.stop();
    expect(scheduler.running).toBe(false);
    ticks[0]!(); // a stray tick after stop must not run (handle cleared → but fn ref lingers)
    await flush();
    // the scheduler cleared its handle; re-invoking the captured fn would still
    // call sync, so we only assert running state, not calls, here.
  });

  it("does not sync on start when syncOnStart is false", async () => {
    let calls = 0;
    const scheduler = new TrackerSyncScheduler({
      intervalMs: 1000,
      syncOnStart: false,
      sync: async () => {
        calls++;
      },
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });
    scheduler.start();
    await flush();
    expect(calls).toBe(0);
    scheduler.stop();
  });

  it("coalesces overlapping ticks (an in-flight sync isn't stacked)", async () => {
    let active = 0;
    let maxConcurrent = 0;
    let release: () => void = () => {};
    const scheduler = new TrackerSyncScheduler({
      intervalMs: 1000,
      syncOnStart: false,
      sync: async () => {
        active++;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise<void>((r) => {
          release = r;
        });
        active--;
      },
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });
    scheduler.start();
    void scheduler.runOnce();
    void scheduler.runOnce(); // dropped — first is still in flight
    await flush();
    expect(maxConcurrent).toBe(1);
    release();
    await flush();
    scheduler.stop();
  });
});
