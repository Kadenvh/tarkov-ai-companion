import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  openFixtureDb,
  insertFleaSale,
  insertRaid,
  insertCalibration,
  insertQuestEvent,
  setMeta,
} from "./fixtures/build.js";
import { parseGoal, netWorthGoal, KAPPA_TASK_TARGET } from "../src/goals.js";

/**
 * Goal-ETA fixture (hand-computable):
 *   flea sales  : 2026-07-01 = 10_000, 2026-07-06 = 50_000  -> net worth 60_000
 *   net-worth curve gap-fills 07-01..07-06; slope = (60_000-10_000)/5d = 10_000/day
 *   raids       : one per day 07-02..07-06 (5 raids, all in the 14-day window)
 *   level cal.  : 07-01 = 20, 07-06 = 30 -> +10 over 5 days = 2 levels/day
 *   completions : one distinct task per day 07-01..07-06 (6) = 1 task/day
 */
function seedGoalFixture(): DatabaseSync {
  const db = openFixtureDb();
  insertFleaSale(db, "Item A", 10_000, "2026-07-01T20:00:00");
  insertFleaSale(db, "Item B", 50_000, "2026-07-06T20:00:00");
  for (const day of ["2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05", "2026-07-06"]) {
    insertRaid(db, { map: "customs", startedAt: `${day}T20:00:00`, outcome: "survived" });
  }
  insertCalibration(db, "level", 20, "2026-07-01T20:00:00");
  insertCalibration(db, "level", 30, "2026-07-06T20:00:00");
  setMeta(db, "level", "30");
  const days = ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05", "2026-07-06"];
  days.forEach((day, i) => {
    const taskId = `task-${i}`;
    insertQuestEvent(db, taskId, "completed", `${day}T21:00:00`);
    db.prepare(`INSERT INTO task_state (task_id, complete, ts) VALUES (?, 1, ?)`).run(taskId, `${day}T21:00:00`);
  });
  return db;
}

describe("parseGoal", () => {
  it("parses each goal kind", () => {
    expect(parseGoal("rubles:50000000")).toEqual({ kind: "rubles", target: 50_000_000 });
    expect(parseGoal("roubles:5e7")).toEqual({ kind: "rubles", target: 50_000_000 });
    expect(parseGoal("level:40")).toEqual({ kind: "level", target: 40 });
    expect(parseGoal("tasks:150")).toEqual({ kind: "tasks", target: 150 });
    expect(parseGoal("kappa")).toEqual({ kind: "tasks", target: KAPPA_TASK_TARGET });
    expect(parseGoal("kappa:300")).toEqual({ kind: "tasks", target: 300 });
  });

  it("returns null for missing / blank / bogus goals", () => {
    expect(parseGoal(null)).toBeNull();
    expect(parseGoal("")).toBeNull();
    expect(parseGoal("   ")).toBeNull();
    expect(parseGoal("bananas:5")).toBeNull();
    expect(parseGoal("rubles:-5")).toBeNull();
    expect(parseGoal("level:0")).toBeNull();
    expect(parseGoal("rubles:abc")).toBeNull();
  });
});

describe("netWorthGoal — trajectory", () => {
  it("returns the net-worth series and current estimate", () => {
    const db = seedGoalFixture();
    const report = netWorthGoal(db, {});
    expect(report.series.map((p) => p.day)).toEqual([
      "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05", "2026-07-06",
    ]);
    expect(report.currentEstimate).toBe(60_000);
    expect(report.goal).toBeNull(); // no goal requested
    expect(report.netWorth.isEstimate).toBe(true);
  });
});

describe("netWorthGoal — rubles ETA", () => {
  it("projects days and raids from recent flea-income pace", () => {
    const db = seedGoalFixture();
    const report = netWorthGoal(db, { goal: { kind: "rubles", target: 100_000 } });
    const goal = report.goal!;
    expect(goal.kind).toBe("rubles");
    expect(goal.current).toBe(60_000);
    expect(goal.remaining).toBe(40_000);
    expect(goal.pace.perDay).toBe(10_000); // 50_000 gained over 5 days
    expect(goal.pace.perRaid).toBe(10_000); // 50_000 over 5 raids
    expect(goal.etaDays).toBe(4); // 40_000 / 10_000
    expect(goal.etaRaids).toBe(4); // ceil(40_000 / 10_000)
    expect(goal.reached).toBe(false);
    expect(goal.lowConfidence).toBe(false); // n=6 >= 5
  });

  it("reports reached=0 when already past the target (never a bogus ETA)", () => {
    const db = seedGoalFixture();
    const goal = netWorthGoal(db, { goal: { kind: "rubles", target: 50_000 } }).goal!;
    expect(goal.reached).toBe(true);
    expect(goal.remaining).toBe(0);
    expect(goal.etaDays).toBe(0);
    expect(goal.etaRaids).toBe(0);
  });
});

describe("netWorthGoal — level ETA", () => {
  it("projects from the calibrations level pace and flags low-n", () => {
    const db = seedGoalFixture();
    const goal = netWorthGoal(db, { goal: { kind: "level", target: 40 } }).goal!;
    expect(goal.kind).toBe("level");
    expect(goal.current).toBe(30); // meta.level
    expect(goal.remaining).toBe(10);
    expect(goal.pace.perDay).toBe(2); // +10 levels over 5 days
    expect(goal.etaDays).toBe(5);
    expect(goal.lowConfidence).toBe(true); // only 2 dated level readings
  });
});

describe("netWorthGoal — task-count (Kappa) ETA", () => {
  it("projects from completion pace using the task_state stock as current", () => {
    const db = seedGoalFixture();
    const goal = netWorthGoal(db, { goal: { kind: "tasks", target: 10 } }).goal!;
    expect(goal.kind).toBe("tasks");
    expect(goal.current).toBe(6); // 6 completed tasks
    expect(goal.remaining).toBe(4);
    expect(goal.pace.perDay).toBe(1); // 6 completions over ~span, slope 1/day
    expect(goal.etaDays).toBe(4);
  });
});

describe("netWorthGoal — sparse data degrades gracefully", () => {
  it("empty DB: empty series, zero current, no bogus ETA", () => {
    const db = openFixtureDb();
    const report = netWorthGoal(db, { goal: { kind: "rubles", target: 1_000_000 } });
    expect(report.series).toEqual([]);
    expect(report.currentEstimate).toBe(0);
    const goal = report.goal!;
    expect(goal.remaining).toBe(1_000_000);
    expect(goal.pace.perDay).toBeNull();
    expect(goal.etaDays).toBeNull();
    expect(goal.etaRaids).toBeNull();
    expect(goal.reached).toBe(false);
    expect(goal.lowConfidence).toBe(true);
  });

  it("level goal with no calibrations: current from meta, no pace, null ETA", () => {
    const db = openFixtureDb();
    setMeta(db, "level", "12");
    const goal = netWorthGoal(db, { goal: { kind: "level", target: 40 } }).goal!;
    expect(goal.current).toBe(12);
    expect(goal.pace.perDay).toBeNull();
    expect(goal.etaDays).toBeNull();
  });
});
