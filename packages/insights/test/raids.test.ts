import { describe, expect, it, beforeAll } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openFixtureDb, seedStandardFixture, insertRaid } from "./fixtures/build.js";
import {
  survivalByMap,
  survivalByHour,
  survivalByDuration,
  queuePatterns,
  sessionRhythm,
} from "../src/raids.js";

// All expectations below are hand-computed from the fixture table documented
// in test/fixtures/build.ts (24 raids, 6 sessions, 6 days).

let db: DatabaseSync;

beforeAll(() => {
  db = openFixtureDb();
  seedStandardFixture(db);
});

describe("survivalByMap", () => {
  it("computes per-map outcome counts and rates, sorted by n", () => {
    const rows = survivalByMap(db);
    expect(rows.map((r) => r.map)).toEqual(["customs", "factory", "woods", "interchange"]);

    const customs = rows[0]!;
    expect(customs).toMatchObject({ n: 10, survived: 6, died: 3, unknown: 1, survivalRate: 0.6667, lowConfidence: false });

    const factory = rows[1]!;
    expect(factory).toMatchObject({ n: 8, survived: 2, died: 6, unknown: 0, survivalRate: 0.25, lowConfidence: false });
  });

  it("flags small samples and null rates honestly", () => {
    const rows = survivalByMap(db);
    const woods = rows.find((r) => r.map === "woods")!;
    expect(woods).toMatchObject({ n: 4, survivalRate: 0.75, lowConfidence: true });

    const interchange = rows.find((r) => r.map === "interchange")!;
    expect(interchange).toMatchObject({ n: 2, survived: 0, died: 0, unknown: 2, survivalRate: null, lowConfidence: true });
  });

  it("groups NULL maps under (unknown)", () => {
    const mini = openFixtureDb();
    insertRaid(mini, { startedAt: "2026-07-01T12:00:00", outcome: "died" });
    expect(survivalByMap(mini)).toEqual([
      { map: "(unknown)", n: 1, survived: 0, died: 1, unknown: 0, survivalRate: 0, lowConfidence: true },
    ]);
  });
});

describe("survivalByHour", () => {
  it("buckets by wall-clock start hour", () => {
    const { rows, excluded } = survivalByHour(db);
    expect(excluded).toBe(0);
    expect(rows.map((r) => r.hour)).toEqual([9, 20, 21]);
    expect(rows[0]).toMatchObject({ hour: 9, n: 6, survived: 3, died: 1, unknown: 2, survivalRate: 0.75 });
    expect(rows[1]).toMatchObject({ hour: 20, n: 10, survivalRate: 0.6667 });
    expect(rows[2]).toMatchObject({ hour: 21, n: 8, survivalRate: 0.25 });
  });

  it("excludes raids with no parseable timestamp", () => {
    const mini = openFixtureDb();
    insertRaid(mini, { map: "customs", outcome: "survived" }); // no timestamps at all
    const { rows, excluded } = survivalByHour(mini);
    expect(rows).toEqual([]);
    expect(excluded).toBe(1);
  });
});

describe("survivalByDuration", () => {
  it("buckets on duration_sec with inclusive-lower/exclusive-upper edges", () => {
    const { rows, excluded } = survivalByDuration(db);
    expect(excluded).toBe(2); // interchange raids have NULL duration
    expect(rows.map((r) => r.bucket)).toEqual(["10-20m", "20-30m", "40m+"]);
    expect(rows[0]).toMatchObject({ bucket: "10-20m", n: 8, survivalRate: 0.25 }); // factory 600s
    expect(rows[1]).toMatchObject({ bucket: "20-30m", n: 10, survivalRate: 0.6667 }); // customs 1200s (boundary -> upper bucket)
    expect(rows[2]).toMatchObject({ bucket: "40m+", n: 4, survivalRate: 0.75, lowConfidence: true }); // woods 2500s
  });
});

describe("queuePatterns", () => {
  it("computes avg/median queue_sec by map and by hour", () => {
    const q = queuePatterns(db);
    expect(q.excluded).toBe(2); // interchange NULL queue_sec

    expect(q.byMap.map((r) => r.map)).toEqual(["customs", "factory", "woods"]);
    expect(q.byMap[0]).toMatchObject({ map: "customs", n: 10, avgSec: 100, medianSec: 100 });
    // factory: 30,30,30,30 (session 2) + 60,60,60,60 (session 3) -> avg 45, median 45
    expect(q.byMap[1]).toMatchObject({ map: "factory", n: 8, avgSec: 45, medianSec: 45 });
    expect(q.byMap[2]).toMatchObject({ map: "woods", n: 4, avgSec: 200, medianSec: 200, lowConfidence: true });

    expect(q.byHour.map((r) => r.hour)).toEqual([9, 20, 21]);
    expect(q.byHour[0]).toMatchObject({ hour: 9, n: 4, avgSec: 200 });
    expect(q.byHour[1]).toMatchObject({ hour: 20, n: 10, avgSec: 100 });
    expect(q.byHour[2]).toMatchObject({ hour: 21, n: 8, avgSec: 45 });
  });
});

describe("sessionRhythm", () => {
  it("groups the fixture into 6 sessions with hand-computed stats", () => {
    const r = sessionRhythm(db);
    expect(r.excluded).toBe(0);
    expect(r.summary.sessionCount).toBe(6);
    expect(r.summary.totalRaids).toBe(24);
    expect(r.sessions.map((s) => s.raidCount)).toEqual([5, 5, 4, 4, 4, 2]);
    expect(r.summary.raidsPerSession).toEqual({ mean: 4, median: 4 });
    // lengths: 48, 48, 38, 38, 38, 18 minutes
    expect(r.sessions.map((s) => s.lengthMin)).toEqual([48, 48, 38, 38, 38, 18]);
    expect(r.summary.sessionLengthMin).toEqual({ mean: 38, median: 38 });

    const first = r.sessions[0]!;
    expect(first).toMatchObject({
      index: 0,
      startTs: "2026-07-01T20:00:00",
      endTs: "2026-07-01T20:48:00",
      startHour: 20,
      maps: ["customs"],
      survived: 3,
      died: 1,
      unknown: 1,
      survivalRate: 0.75,
    });
  });

  it("finds best/worst sessions by survival rate (ties -> earliest; undecided excluded)", () => {
    const r = sessionRhythm(db);
    // 0.75 tie between session 0 (customs 07-01) and session 4 (woods 07-05) -> earliest
    expect(r.summary.best).toEqual({ index: 0, startTs: "2026-07-01T20:00:00", survivalRate: 0.75 });
    // 0.25 tie between factory sessions 2 and 3 -> earliest
    expect(r.summary.worst).toEqual({ index: 2, startTs: "2026-07-03T21:00:00", survivalRate: 0.25 });
    // the all-unknown interchange session has a null rate and never wins either slot
    expect(r.sessions[5]!.survivalRate).toBeNull();
  });

  it("handles a single raid as one session", () => {
    const mini = openFixtureDb();
    insertRaid(mini, {
      map: "factory",
      startedAt: "2026-07-01T10:00:00",
      endedAt: "2026-07-01T10:15:00",
      outcome: "survived",
    });
    const r = sessionRhythm(mini);
    expect(r.summary.sessionCount).toBe(1);
    expect(r.sessions[0]).toMatchObject({ raidCount: 1, lengthMin: 15, survivalRate: 1 });
    expect(r.summary.lowConfidence).toBe(true);
  });

  it("keeps a gap of exactly the threshold in the same session; one minute more splits", () => {
    const mini = openFixtureDb();
    // raid A ends 10:30; raid B starts 12:00 -> gap exactly 90 min -> SAME session
    insertRaid(mini, { map: "customs", startedAt: "2026-07-01T10:00:00", endedAt: "2026-07-01T10:30:00", outcome: "survived" });
    insertRaid(mini, { map: "customs", startedAt: "2026-07-01T12:00:00", endedAt: "2026-07-01T12:20:00", outcome: "died" });
    // raid C starts 13:51 -> gap 91 min from B's end -> NEW session
    insertRaid(mini, { map: "woods", startedAt: "2026-07-01T13:51:00", endedAt: "2026-07-01T14:10:00", outcome: "survived" });
    const r = sessionRhythm(mini);
    expect(r.sessions.map((s) => s.raidCount)).toEqual([2, 1]);
    expect(r.sessions[0]!.maps).toEqual(["customs"]);
    expect(r.sessions[1]!.maps).toEqual(["woods"]);
  });

  it("falls back to queued_at when started_at is missing", () => {
    const mini = openFixtureDb();
    insertRaid(mini, { map: "shoreline", queuedAt: "2026-07-01T09:00:00", outcome: "unknown" });
    const r = sessionRhythm(mini);
    expect(r.excluded).toBe(0);
    expect(r.sessions[0]).toMatchObject({ raidCount: 1, startHour: 9, lengthMin: 0 });
  });

  it("returns an empty rhythm for an empty journal", () => {
    const mini = openFixtureDb();
    const r = sessionRhythm(mini);
    expect(r.sessions).toEqual([]);
    expect(r.summary).toMatchObject({
      sessionCount: 0,
      totalRaids: 0,
      best: null,
      worst: null,
      raidsPerSession: { mean: null, median: null },
      lowConfidence: true,
    });
  });
});
