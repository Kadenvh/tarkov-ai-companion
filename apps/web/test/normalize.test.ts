import { describe, expect, it } from "vitest";
import {
  KAPPA_TOTAL_FALLBACK,
  LIGHTKEEPER_TOTAL_FALLBACK,
  readGraphSummary,
  readInsightsEconomy,
  readInsightsRaids,
  readPerfRows,
  readPlayerState,
  readSettingsDiffs,
} from "../src/lib/normalize";

describe("readPlayerState", () => {
  it("reads a flat state dump and counts record-shaped tasks", () => {
    const state = readPlayerState({
      level: 23,
      faction: "USEC",
      prestige: 1,
      gameMode: "regular",
      tasks: { a: { complete: true }, b: { complete: true, failed: false }, c: { failed: true } },
    });
    expect(state.level).toBe(23);
    expect(state.faction).toBe("USEC");
    expect(state.completedTasks).toBe(2);
    expect(state.failedTasks).toBe(1);
    expect(state.empty).toBe(false);
  });

  it("reads array-shaped task rows and nested xp estimates", () => {
    const state = readPlayerState({
      xp: { level: 30, xp: 3_500_000, confidence: { low: 3_400_000, high: 3_600_000 } },
      tasks: [{ taskId: "a", complete: true }, { taskId: "b" }],
    });
    expect(state.level).toBe(30);
    expect(state.xp).toEqual({ value: 3_500_000, low: 3_400_000, high: 3_600_000 });
    expect(state.completedTasks).toBe(1);
  });

  it("flags an untouched profile as empty (onboarding trigger) and never crashes on garbage", () => {
    expect(readPlayerState({ level: 1, tasks: {} }).empty).toBe(true);
    expect(readPlayerState(undefined).empty).toBe(true);
    expect(readPlayerState("garbage").level).toBe(1);
  });
});

describe("readGraphSummary", () => {
  it("reads nested kappa/lightkeeper tracks", () => {
    const summary = readGraphSummary({
      taskCount: 510,
      kappa: { total: 257, remaining: 100 },
      lightkeeper: { total: 102, remaining: 52 },
    });
    expect(summary.taskCount).toBe(510);
    expect(summary.kappa.done).toBe(157);
    expect(summary.kappa.pct).toBeCloseTo(157 / 257);
    expect(summary.lightkeeper.done).toBe(50);
  });

  it("falls back to the SPEC invariants when totals are missing", () => {
    const summary = readGraphSummary({ kappaRemaining: 200 });
    expect(summary.kappa.total).toBe(KAPPA_TOTAL_FALLBACK);
    expect(summary.kappa.done).toBe(57);
    expect(summary.lightkeeper.total).toBe(LIGHTKEEPER_TOTAL_FALLBACK);
    expect(summary.lightkeeper.done).toBeNull(); // remaining unknown
  });
});

describe("readSettingsDiffs", () => {
  const diff = [{ key: "Graphics.VSync", current: true, recommended: false, why: "latency" }];

  it("accepts nested { profiles: {...} } and bare record shapes", () => {
    expect(readSettingsDiffs({ profiles: { "max-fps": diff } })).toEqual({ "max-fps": diff });
    expect(readSettingsDiffs({ "max-fps": diff, balanced: [] })).toEqual({
      "max-fps": diff,
      balanced: [],
    });
  });

  it("returns {} for junk", () => {
    expect(readSettingsDiffs(null)).toEqual({});
    expect(readSettingsDiffs({ profiles: { x: "nope" } })).toEqual({});
  });
});

describe("readPerfRows / insights readers", () => {
  it("reads perf rows from bare arrays and nested regression objects", () => {
    const rows = readPerfRows([
      { map: "customs", n: 12, fps_avg: 110, fps_p1: 70, regression: { regressed: true, reasons: ["fps_avg -15%"] } },
    ]);
    expect(rows[0]?.regressed).toBe(true);
    expect(rows[0]?.regression?.reasons).toEqual(["fps_avg -15%"]);
    expect(readPerfRows({ maps: [{ map: "woods" }] })).toHaveLength(1);
    expect(readPerfRows("junk")).toEqual([]);
  });

  it("insights raids reader degrades to well-formed empties", () => {
    const empty = readInsightsRaids(undefined);
    expect(empty.byMap).toEqual([]);
    expect(empty.rhythm).toBeNull();
    const filled = readInsightsRaids({
      survivalByMap: [{ map: "customs", n: 10, survived: 6, died: 4, unknown: 0, survivalRate: 0.6, lowConfidence: false }],
      sessionRhythm: { sessions: [], summary: { sessionCount: 0 } },
    });
    expect(filled.byMap).toHaveLength(1);
    expect(filled.rhythm).not.toBeNull();
  });

  it("economy reader requires points arrays", () => {
    expect(readInsightsEconomy({ income: { bucket: "weekly", points: [] } }).income).not.toBeNull();
    expect(readInsightsEconomy({ income: { bucket: "weekly" } }).income).toBeNull();
    expect(readInsightsEconomy(undefined).netWorth).toBeNull();
  });
});
