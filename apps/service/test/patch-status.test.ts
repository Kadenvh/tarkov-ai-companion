import { afterEach, describe, expect, it } from "vitest";
import { closeApps, testApp } from "./helpers.js";

/**
 * M8.2 patch-drift sentinel route — `GET /api/patch/status`. Exercises the three
 * readiness states (no drift / drift with no local snapshot / drift with a local
 * snapshot + diff) plus the cache stability. No network: the "snapshot present"
 * case uses the two committed 1.0.6 snapshots on disk.
 */

describe("GET /api/patch/status (M8.2)", () => {
  afterEach(closeApps);

  it("reports invariants + no drift when the game version matches / is absent", async () => {
    const app = await testApp({ detectGameVersionFn: () => null });
    const res = await app.inject({ method: "GET", url: "/api/patch/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.snapshotVersion).toBe(app.tac.snapshotVersion());
    expect(body.detectedVersion).toBeUndefined();
    expect(body.drift).toBeUndefined();
    expect(body.invariants.ok).toBe(true);
    expect(body.invariants.acyclic).toBe(true);
    expect(typeof body.lastChecked).toBe("string");
    expect(Number.isNaN(Date.parse(body.lastChecked))).toBe(false);
  });

  it("flags drift with no local snapshot for an unknown detected version", async () => {
    const app = await testApp({ detectGameVersionFn: () => "9.9.9.99999" });
    const body = (await app.inject({ method: "GET", url: "/api/patch/status" })).json();
    expect(body.detectedVersion).toBe("9.9.9.99999");
    expect(body.drift).toBeDefined();
    expect(body.drift.snapshotAvailable).toBe(false);
    expect(body.drift.diff).toBeUndefined();
    expect(body.drift.note).toMatch(/pnpm snapshot/);
  });

  it("includes the structural diff when a snapshot for the detected version is on disk", async () => {
    // both 1.0.6 snapshots are committed; treat the older one as the "detected" build
    const app = await testApp({ detectGameVersionFn: () => "1.0.6.0.46010" });
    const body = (await app.inject({ method: "GET", url: "/api/patch/status" })).json();
    expect(body.detectedVersion).toBe("1.0.6.0.46010");
    expect(body.drift.snapshotAvailable).toBe(true);
    expect(body.drift.diff).toBeDefined();
    expect(body.drift.diff.fromVersion).toBe(app.tac.snapshotVersion());
    expect(body.drift.diff.toVersion).toBe("1.0.6.0.46010");
    expect(body.drift.diff.counts.tasks).toHaveProperty("delta");
    expect(body.drift.diff.invariants).toHaveProperty("ok");
  });

  it("caches the report so lastChecked is stable across polls", async () => {
    const app = await testApp({ detectGameVersionFn: () => "9.9.9.99999" });
    const a = (await app.inject({ method: "GET", url: "/api/patch/status" })).json();
    const b = (await app.inject({ method: "GET", url: "/api/patch/status" })).json();
    expect(b.lastChecked).toBe(a.lastChecked);
  });
});
