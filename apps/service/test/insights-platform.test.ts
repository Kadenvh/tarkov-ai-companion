import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RaidDraft } from "@tac/state-engine";
import type { FastifyInstance } from "fastify";
import { closeApps, tempDir, testApp } from "./helpers.js";

function seedRaid(app: FastifyInstance, overrides: Partial<RaidDraft> = {}): void {
  const draft: RaidDraft = {
    sid: `sid-${Math.random().toString(16).slice(2)}`,
    map: "bigmap",
    mode: "regular",
    shortId: null,
    queuedAt: "2026-07-10T20:00:00.000",
    startedAt: "2026-07-10T20:03:00.000",
    endedAt: "2026-07-10T20:33:00.000",
    queueSec: 180,
    durationSec: 1800,
    outcome: "survived",
    endInferred: false,
    ...overrides,
  };
  app.tac.store.recordRaid(draft);
}

describe("insights routes (M7) + platform extensions", () => {
  afterEach(closeApps);

  it("GET /api/insights/raids aggregates survival + rhythm from the profile DB", async () => {
    const app = await testApp();
    seedRaid(app);
    seedRaid(app, { outcome: "died", startedAt: "2026-07-10T21:00:00.000", endedAt: "2026-07-10T21:20:00.000" });
    const body = (await app.inject({ method: "GET", url: "/api/insights/raids" })).json();
    expect(body.survivalByMap).toHaveLength(1);
    expect(body.survivalByMap[0]).toMatchObject({ map: "bigmap", n: 2 });
    expect(body.queues).toHaveProperty("byMap");
    expect(body.rhythm.summary.totalRaids).toBe(2);
  });

  it("GET /api/insights/economy reports flea income + net-worth estimate", async () => {
    const app = await testApp();
    app.tac.store.recordFleaSale({ itemId: "GP coin", amount: 25000, ts: "2026-07-10T20:10:00.000" }, false);
    app.tac.store.recordFleaSale({ itemId: "GP coin", amount: 25000, ts: "2026-07-11T20:10:00.000" }, false);
    const body = (await app.inject({ method: "GET", url: "/api/insights/economy" })).json();
    expect(body.daily.totalIncome).toBe(50000);
    expect(body.daily.points).toHaveLength(2);
    expect(body.weekly.bucket).toBe("weekly");
    expect(body.netWorth.isEstimate).toBe(true);
    expect(body.netWorth.caveats.length).toBeGreaterThan(0);
  });

  it("GET /api/insights/fingerprint exposes features with explanations (M7.3)", async () => {
    const app = await testApp();
    seedRaid(app);
    const body = (await app.inject({ method: "GET", url: "/api/insights/fingerprint" })).json();
    expect(Object.keys(body.features).length).toBeGreaterThan(0);
    expect(Object.keys(body.explanations)).toEqual(Object.keys(body.features));
    expect(body.sampleSizes.raids).toBe(1);
  });

  it("GET /api/metrics counts requests in-session and persists lifetime totals (M5.6)", async () => {
    const app = await testApp();
    await app.inject({ method: "GET", url: "/api/health" });
    await app.inject({ method: "GET", url: "/api/health" });
    const body = (await app.inject({ method: "GET", url: "/api/metrics" })).json();
    expect(body.session.requests).toBeGreaterThanOrEqual(3);
    expect(body.session.requestsByRoute["/api/health"]).toBe(2);
    expect(body.session.wsClients).toBe(0);
    expect(body.lifetime.requests).toBeGreaterThanOrEqual(3);
    // lifetime totals survive a flush into meta
    app.tac.metrics.persist();
    expect(app.tac.store.getMeta("metrics")).toContain("requests");
  });

  it("POST /api/notify broadcasts a WS notice (agent M4.4 path)", async () => {
    const app = await testApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/notify",
      payload: { title: "Briefing ready", body: "Next raid: Customs" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, clients: 0 });
    const bad = await app.inject({ method: "POST", url: "/api/notify", payload: {} });
    expect(bad.statusCode).toBe(400);
  });

  it("POST /api/state/backfill runs against an injected logs dir and returns counts", async () => {
    const logsDir = tempDir("tac-logs-");
    mkdirSync(join(logsDir, "not-a-session"), { recursive: true });
    const app = await testApp({ logsDir });
    const res = await app.inject({ method: "POST", url: "/api/state/backfill", payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.logsDir).toBe(logsDir);
    expect(body.sessionsScanned).toBe(0);
    // explicit body override wins over the runtime's logs dir
    const other = tempDir("tac-logs2-");
    const res2 = await app.inject({ method: "POST", url: "/api/state/backfill", payload: { logsDir: other } });
    expect(res2.json().logsDir).toBe(other);
  });
});
