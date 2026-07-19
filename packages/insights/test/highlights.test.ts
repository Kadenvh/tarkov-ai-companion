import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  openFixtureDb,
  insertRaid,
  insertQuestEvent,
  insertFleaSale,
  insertPosition,
} from "./fixtures/build.js";
import { raidHighlights, recentHighlights } from "../src/highlights.js";

function lastRaidId(db: DatabaseSync): number {
  return Number((db.prepare(`SELECT MAX(id) AS id FROM raids`).get() as { id: number }).id);
}

describe("raidHighlights — timeline offsets", () => {
  it("anchors markers to the raid start as second offsets", () => {
    const db = openFixtureDb();
    insertRaid(db, {
      map: "customs",
      startedAt: "2026-07-01T20:00:00",
      endedAt: "2026-07-01T20:30:00",
      durationSec: 1800,
      outcome: "died",
    });
    const raidId = lastRaidId(db);
    // In-window events (offsets from 20:00:00):
    insertPosition(db, { map: "customs", x: 100.4, y: 2.6, z: -50.9, ts: "2026-07-01T20:05:00" }); // 300s
    insertFleaSale(db, "Salewa", 10_000, "2026-07-01T20:10:00"); // 600s
    insertQuestEvent(db, "task-complete", "completed", "2026-07-01T20:14:00"); // 840s
    insertQuestEvent(db, "task-fail", "failed", "2026-07-01T20:20:00"); // 1200s
    // Out-of-window event (before start) — must be excluded.
    insertQuestEvent(db, "task-early", "started", "2026-07-01T19:00:00");

    const h = raidHighlights(db, raidId)!;
    expect(h.map).toBe("customs");
    expect(h.outcome).toBe("died");
    expect(h.markers.map((m) => [m.kind, m.tOffsetSec, m.clock])).toEqual([
      ["raid-start", 0, "00:00"],
      ["position", 300, "05:00"],
      ["flea-sale", 600, "10:00"],
      ["quest-completed", 840, "14:00"],
      ["quest-failed", 1200, "20:00"],
      ["raid-end", 1800, "30:00"],
    ]);
    // The raid-end marker reflects the outcome (clippable "moment of death").
    expect(h.markers.at(-1)!.label).toBe("Died");
  });

  it("uses duration_sec for the end marker when ended_at is absent", () => {
    const db = openFixtureDb();
    insertRaid(db, { map: "woods", startedAt: "2026-07-02T09:00:00", durationSec: 600, outcome: "survived" });
    const h = raidHighlights(db, lastRaidId(db))!;
    const end = h.markers.at(-1)!;
    expect(end.kind).toBe("raid-end");
    expect(end.tOffsetSec).toBe(600);
    expect(end.label).toBe("Survived");
  });

  it("returns null for an unknown raid id", () => {
    const db = openFixtureDb();
    expect(raidHighlights(db, 999)).toBeNull();
  });

  it("returns null for a raid with no parseable start timestamp", () => {
    const db = openFixtureDb();
    insertRaid(db, { map: "factory", outcome: "unknown" }); // all timestamps null
    expect(raidHighlights(db, lastRaidId(db))).toBeNull();
  });
});

describe("recentHighlights", () => {
  it("returns the most recent raids first and honours the limit", () => {
    const db = openFixtureDb();
    insertRaid(db, { map: "customs", startedAt: "2026-07-01T20:00:00", durationSec: 600, outcome: "survived" });
    insertRaid(db, { map: "woods", startedAt: "2026-07-02T20:00:00", durationSec: 600, outcome: "died" });
    insertRaid(db, { map: "factory", startedAt: "2026-07-03T20:00:00", durationSec: 600, outcome: "survived" });
    // A timestamp-less raid is skipped, not crashed on.
    insertRaid(db, { map: "lighthouse", outcome: "unknown" });

    const all = recentHighlights(db);
    expect(all.map((h) => h.map)).toEqual(["factory", "woods", "customs"]);

    const limited = recentHighlights(db, 2);
    expect(limited.map((h) => h.map)).toEqual(["factory", "woods"]);
  });

  it("empty DB yields an empty list", () => {
    expect(recentHighlights(openFixtureDb())).toEqual([]);
  });
});
