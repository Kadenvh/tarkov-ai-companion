import { describe, expect, it } from "vitest";
import {
  KAPPA_TOTAL_FALLBACK,
  LIGHTKEEPER_TOTAL_FALLBACK,
  normalizePlanResponse,
  normalizeStoryResponse,
  readGraphSummary,
  readInsightsEconomy,
  readInsightsRaids,
  readPerfRows,
  readPlayerState,
  readSettingsDiffs,
} from "../src/lib/normalize";

describe("normalizePlanResponse", () => {
  const raid = {
    index: 1,
    map: "5704e3c2d2720bac5b8b4567",
    tasks: [{ id: "t1", name: "Debut", anyMap: false, reasons: ["Kappa-required"] }],
    levelBefore: 5,
    levelAfter: 6,
    score: 4.2,
  };
  const innerPlan = {
    raids: [raid],
    freeTasksCompleted: [{ id: "f1", name: "Shortage" }],
    goalTaskCount: 257,
    remainingGoalTasks: 200,
    levelStalls: [],
    reachedLevel: 12,
  };

  it("flattens the service PlanBundle (regression: live UI showed 'No plan yet' on a nested bundle)", () => {
    const flat = normalizePlanResponse({
      hash: "abc123",
      builtAt: "2026-07-11T20:00:00.000Z",
      buildMs: 5,
      horizon: 10,
      goals: [{ type: "kappa" }],
      weights: { task: 1, xp: 0.15, criticality: 0.4, mapCost: {} },
      plan: innerPlan,
      foresight: [
        {
          raidIndex: 1,
          warnings: [
            {
              kind: "task-exclusivity",
              completing: { id: "t1", name: "Debut" },
              fails: [{ id: "t9", name: "Other", kappaRequired: true, lightkeeperRequired: false }],
              severity: "critical",
            },
          ],
        },
      ],
      mapNames: { "5704e3c2d2720bac5b8b4567": "Woods", any: "Any map" },
    });
    expect(flat).not.toBeNull();
    expect(flat!.raids).toHaveLength(1);
    expect(flat!.hash).toBe("abc123");
    expect(flat!.generatedAt).toBe("2026-07-11T20:00:00.000Z");
    expect(flat!.mapNames?.["5704e3c2d2720bac5b8b4567"]).toBe("Woods");
    expect((flat!.warnings as Record<string, unknown[]>)["1"]).toHaveLength(1);
    expect(flat!.goalTaskCount).toBe(257);
  });

  it("passes an already-flat response through and rejects shapes without raids", () => {
    const already = { ...innerPlan, hash: "dd" };
    expect(normalizePlanResponse(already)).toBe(already);
    expect(normalizePlanResponse({ hello: true })).toBeNull();
    expect(normalizePlanResponse(null)).toBeNull();
    expect(normalizePlanResponse("junk")).toBeNull();
  });
});

describe("normalizeStoryResponse", () => {
  const dataset = {
    schemaVersion: 1,
    gameVersion: "1.0.6.0.46010",
    attribution: "wiki CC BY-NC-SA",
    chapters: [{ id: "tour", name: "Tour", stages: [] }],
    decisions: [{ id: "ticket_kerman", options: [] }],
    endings: [{ id: "savior", name: "Savior" }],
  };

  it("flattens the service {dataset, player} envelope (regression: Goals view white-screened)", () => {
    const flat = normalizeStoryResponse({
      dataset,
      player: {
        chapters: [{ chapterId: "tour", status: "not-started" }],
        stages: { "tour-01": true },
        decisions: { ticket_kerman: "refuse" },
        endings: { possible: ["savior"], locked: [], forced: null },
      },
    });
    expect(flat).not.toBeNull();
    expect(flat!.chapters).toHaveLength(1);
    expect(flat!.decisions).toHaveLength(1);
    expect(flat!.playerStatus?.stages?.["tour-01"]).toBe(true);
    expect(flat!.playerStatus?.decisions?.["ticket_kerman"]).toBe("refuse");
  });

  it("passes flat responses through and rejects junk", () => {
    const flat = { ...dataset };
    expect(normalizeStoryResponse(flat)).toBe(flat);
    expect(normalizeStoryResponse({ player: {} })).toBeNull();
    expect(normalizeStoryResponse(undefined)).toBeNull();
  });
});

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
