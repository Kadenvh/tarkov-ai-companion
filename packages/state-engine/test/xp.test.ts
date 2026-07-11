import { describe, expect, it } from "vitest";
import { openProfile, type ProfileStore } from "../src/store.js";
import { addCalibration, estimateXp, estimateLevelBand, type XpSource } from "../src/xp.js";

/** synthetic curve + task XP table — hermetic, no snapshot dependency */
const source: XpSource = {
  taskXp: (id) => ({ t1: 1000, t2: 2500, t3: 6000 })[id] ?? null,
  levels: [
    { level: 1, exp: 0 },
    { level: 2, exp: 1000 },
    { level: 3, exp: 3000 },
    { level: 4, exp: 6000 },
    { level: 5, exp: 10000 },
    { level: 6, exp: 15000 },
  ],
};

const raid = (endedAt: string, outcome: "survived" | "died" | "unknown"): Parameters<ProfileStore["recordRaid"]>[0] => ({
  sid: `sid-${endedAt}`,
  map: "woods",
  mode: "regular",
  shortId: null,
  queuedAt: null,
  startedAt: endedAt,
  endedAt,
  queueSec: null,
  durationSec: 1200,
  outcome,
  endInferred: false,
});

describe("XP estimator (M2.5)", () => {
  it("sums completed-task XP plus xpOffset when uncalibrated", () => {
    const store = openProfile("xp1-regular", { memory: true });
    store.setXpOffset(500);
    store.setTaskState("t1", { complete: true, ts: "2026-07-01T00:00:00" });
    store.setTaskState("t2", { complete: true, ts: "2026-07-02T00:00:00" });
    store.setTaskState("t3", { complete: false }); // not complete → not counted
    store.setTaskState("unknown-task", { complete: true, ts: "2026-07-03T00:00:00" }); // no data → 0

    const est = estimateXp(store, source);
    expect(est.xp).toBe(500 + 1000 + 2500);
    expect(est.level).toBe(3); // 4000 xp ≥ 3000, < 6000
    expect(est.confidence).toEqual({ low: est.xp, high: est.xp }); // no raids → exact
  });

  it("adds configurable raid-outcome heuristics with a widening confidence band", () => {
    const store = openProfile("xp2-regular", { memory: true });
    store.setTaskState("t1", { complete: true, ts: "2026-07-01T00:00:00" });
    store.recordRaid(raid("2026-07-02T00:00:00", "survived"), "backfill");
    store.recordRaid(raid("2026-07-03T00:00:00", "died"), "backfill");

    const est = estimateXp(store, source, { survived: 2000, died: 500, uncertainty: 0.5 });
    expect(est.xp).toBe(1000 + 2000 + 500);
    expect(est.confidence.low).toBe(est.xp - 1250);
    expect(est.confidence.high).toBe(est.xp + 1250);
    const band = estimateLevelBand(est, source);
    expect(band.low).toBeLessThanOrEqual(band.high);
  });

  it("calibration re-anchors: only contributions after the anchor count (±1 level acceptance)", () => {
    const store = openProfile("xp3-regular", { memory: true });
    // noisy pre-history that a calibration must override
    store.setTaskState("t1", { complete: true, ts: "2026-07-01T00:00:00" });
    for (let i = 0; i < 5; i++) store.recordRaid(raid(`2026-07-01T0${i}:00:00`, "unknown"), "backfill");

    // user calibrates: "I am exactly level 4" after all of that
    addCalibration(store, "level", 4, "2026-07-05T00:00:00");
    let est = estimateXp(store, source);
    expect(est.xp).toBe(6000); // exactly the level-4 threshold
    expect(est.level).toBe(4);
    expect(est.confidence).toEqual({ low: 6000, high: 6000 }); // nothing after the anchor

    // new progress after the calibration moves the estimate
    store.setTaskState("t2", { complete: true, ts: "2026-07-06T00:00:00" });
    store.recordRaid(raid("2026-07-07T00:00:00", "survived"), "live");
    est = estimateXp(store, source, { survived: 2000, uncertainty: 0.5 });
    expect(est.xp).toBe(6000 + 2500 + 2000);
    expect(est.level).toBe(5); // 10500 ≥ 10000
    // band = ± uncertainty × raid-bump total (tasks/calibration are exact)
    expect(est.confidence).toEqual({ low: 10500 - 1000, high: 10500 + 1000 });

    // an exact-xp calibration wins over everything again
    addCalibration(store, "xp", 12345, "2026-07-08T00:00:00");
    est = estimateXp(store, source);
    expect(est.xp).toBe(12345);
    expect(est.level).toBe(5);
  });
});
