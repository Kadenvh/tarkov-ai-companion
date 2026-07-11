import { describe, expect, it, beforeAll } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openFixtureDb, seedStandardFixture, insertRaid } from "./fixtures/build.js";
import { playstyleFingerprint, mapSlug } from "../src/fingerprint.js";

// Hand-computed from the standard fixture (test/fixtures/build.ts):
//   24 raids: customs 10, factory 8, woods 4, interchange 2
//   outcomes: 11 survived, 10 died, 3 unknown -> survival 11/21 = 0.5238
//   durations: 8×600, 10×1200, 4×2500 -> median 1200 (2 raids NULL)
//   sessions: 6 -> raids/session mean 4; lengths 48,48,38,38,38,18 -> median 38
//   quest events: 36 -> task focus 36/24 = 1.5
//   start hours: 20×10, 21×8, 9×6 -> peak 20; none in 22:00-05:59 -> night 0

let db: DatabaseSync;

beforeAll(() => {
  db = openFixtureDb();
  seedStandardFixture(db);
});

describe("mapSlug", () => {
  it("slugs map names to stable feature keys", () => {
    expect(mapSlug("Ground Zero")).toBe("ground_zero");
    expect(mapSlug("customs")).toBe("customs");
    expect(mapSlug("The Lab!")).toBe("the_lab");
    expect(mapSlug("(unknown)")).toBe("unknown");
    expect(mapSlug("---")).toBe("unknown");
  });
});

describe("playstyleFingerprint", () => {
  it("computes the documented feature vector (hand-checked)", () => {
    const fp = playstyleFingerprint(db);
    expect(fp.features).toEqual({
      map_share_customs: 0.4167,
      map_share_factory: 0.3333,
      map_share_interchange: 0.0833,
      map_share_woods: 0.1667,
      median_raid_duration_sec: 1200,
      night_owl_share: 0,
      peak_hour: 20,
      raids_per_session: 4,
      session_length_median_min: 38,
      survival_rate: 0.5238,
      task_focus_ratio: 1.5,
    });
  });

  it("attaches honest sample sizes", () => {
    const fp = playstyleFingerprint(db);
    expect(fp.sampleSizes).toEqual({ raids: 24, decidedRaids: 21, questEvents: 36, sessions: 6 });
    expect(fp.lowConfidence).toBe(false);
  });

  it("provides an explanation for every feature — same keys, nothing more", () => {
    const fp = playstyleFingerprint(db);
    expect(Object.keys(fp.explanations)).toEqual(Object.keys(fp.features));
    for (const [key, text] of Object.entries(fp.explanations)) {
      expect(text, `explanation for ${key}`).toBeTruthy();
      expect(text.length).toBeGreaterThan(20);
    }
  });

  it("is deterministic: same DB -> byte-identical JSON, sorted keys", () => {
    const a = playstyleFingerprint(db);
    const b = playstyleFingerprint(db);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const keys = Object.keys(a.features);
    expect(keys).toEqual([...keys].sort());
  });

  it("honors the sessionGapMinutes option", () => {
    // With a huge gap threshold every fixture raid collapses into one session.
    const fp = playstyleFingerprint(db, { sessionGapMinutes: 60 * 24 * 30 });
    expect(fp.sampleSizes.sessions).toBe(1);
    expect(fp.features["raids_per_session"]).toBe(24);
  });

  it("counts night raids in the 22:00-05:59 window", () => {
    const mini = openFixtureDb();
    insertRaid(mini, { map: "woods", startedAt: "2026-07-01T23:10:00", endedAt: "2026-07-01T23:40:00", outcome: "survived" });
    insertRaid(mini, { map: "woods", startedAt: "2026-07-02T03:00:00", endedAt: "2026-07-02T03:30:00", outcome: "died" });
    insertRaid(mini, { map: "woods", startedAt: "2026-07-02T12:00:00", endedAt: "2026-07-02T12:30:00", outcome: "died" });
    const fp = playstyleFingerprint(mini);
    expect(fp.features["night_owl_share"]).toBe(0.6667);
  });

  it("degrades gracefully on an empty journal (zeros, low confidence)", () => {
    const mini = openFixtureDb();
    const fp = playstyleFingerprint(mini);
    expect(fp.features).toEqual({
      median_raid_duration_sec: 0,
      night_owl_share: 0,
      peak_hour: 0,
      raids_per_session: 0,
      session_length_median_min: 0,
      survival_rate: 0,
      task_focus_ratio: 0,
    });
    expect(Object.keys(fp.explanations)).toEqual(Object.keys(fp.features));
    expect(fp.sampleSizes).toEqual({ raids: 0, decidedRaids: 0, questEvents: 0, sessions: 0 });
    expect(fp.lowConfidence).toBe(true);
  });
});
