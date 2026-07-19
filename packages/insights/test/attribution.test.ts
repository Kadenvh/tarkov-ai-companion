import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openFixtureDb, insertRaid, insertPerfSample, insertConnectorReading } from "./fixtures/build.js";
import { attribution, ATTRIBUTION_MIN_SIDE } from "../src/attribution.js";

function streetsRaids(db: DatabaseSync, day: string, survived: number, died: number): void {
  let n = 0;
  const at = (): string => `${day}T20:${String(n++).padStart(2, "0")}:00`;
  for (let i = 0; i < survived; i++) insertRaid(db, { map: "streets", startedAt: at(), outcome: "survived" });
  for (let i = 0; i < died; i++) insertRaid(db, { map: "streets", startedAt: at(), outcome: "died" });
}

describe("attribution — survival shift around a settings-hash change", () => {
  it("flags a survival drop after the config change, with an honest label", () => {
    const db = openFixtureDb();
    // One config stream: hash A until 07-04, then B.
    insertConnectorReading(db, { connectorId: "eft-config", capability: "graphics", capturedAt: "2026-07-01T10:00:00", settingsHash: "A" });
    insertConnectorReading(db, { connectorId: "eft-config", capability: "graphics", capturedAt: "2026-07-04T10:00:00", settingsHash: "B" });
    // Before the change (5 survived / 1 died = 83%), after (1 survived / 5 died = 17%).
    streetsRaids(db, "2026-07-02", 5, 1);
    streetsRaids(db, "2026-07-05", 1, 5);

    const report = attribution(db);
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]).toMatchObject({ fromHash: "A", toHash: "B", capability: "graphics" });

    const finding = report.findings.find((f) => f.metric === "survival" && f.scope === "streets")!;
    expect(finding).toBeDefined();
    expect(finding.before).toBeCloseTo(0.8333, 3);
    expect(finding.after).toBeCloseTo(0.1667, 3);
    expect(finding.direction).toBe("down");
    expect(finding.nBefore).toBe(6);
    expect(finding.nAfter).toBe(6);
    expect(finding.confidence).toBe("ok"); // both sides >= 5
    expect(finding.label).toContain("Survival on streets dropped");
    expect(finding.label).toContain("2026-07-04");
    expect(report.lowConfidence).toBe(false);
  });
});

describe("attribution — minimum-sample guard", () => {
  it("does NOT flag a shift when one side is below the floor", () => {
    const db = openFixtureDb();
    insertConnectorReading(db, { connectorId: "eft-config", capability: "graphics", capturedAt: "2026-07-01T10:00:00", settingsHash: "A" });
    insertConnectorReading(db, { connectorId: "eft-config", capability: "graphics", capturedAt: "2026-07-04T10:00:00", settingsHash: "B" });
    // Before has only 2 raids (< ATTRIBUTION_MIN_SIDE), after has 6.
    expect(ATTRIBUTION_MIN_SIDE).toBe(3);
    streetsRaids(db, "2026-07-02", 2, 0);
    streetsRaids(db, "2026-07-05", 0, 6);

    const report = attribution(db);
    expect(report.findings.filter((f) => f.metric === "survival")).toHaveLength(0);
    expect(report.lowConfidence).toBe(true); // nothing attributable
  });

  it("does not flag when there is no settings change at all", () => {
    const db = openFixtureDb();
    insertConnectorReading(db, { connectorId: "eft-config", capability: "graphics", capturedAt: "2026-07-01T10:00:00", settingsHash: "A" });
    insertConnectorReading(db, { connectorId: "eft-config", capability: "graphics", capturedAt: "2026-07-04T10:00:00", settingsHash: "A" });
    streetsRaids(db, "2026-07-02", 5, 1);
    streetsRaids(db, "2026-07-05", 1, 5);
    const report = attribution(db);
    expect(report.changes).toHaveLength(0);
    expect(report.findings).toHaveLength(0);
  });
});

describe("attribution — FPS shift", () => {
  it("flags an avg-FPS drop and labels it low-confidence at 3 samples/side", () => {
    const db = openFixtureDb();
    insertConnectorReading(db, { connectorId: "eft-config", capability: "graphics", capturedAt: "2026-07-01T10:00:00", settingsHash: "A" });
    insertConnectorReading(db, { connectorId: "eft-config", capability: "graphics", capturedAt: "2026-07-04T10:00:00", settingsHash: "B" });
    for (const [day, fps] of [["2026-07-02", 120], ["2026-07-02", 122], ["2026-07-02", 118]] as const)
      insertPerfSample(db, { map: "streets", ts: `${day}T20:00:00`, fpsAvg: fps });
    for (const [day, fps] of [["2026-07-05", 90], ["2026-07-05", 92], ["2026-07-05", 88]] as const)
      insertPerfSample(db, { map: "streets", ts: `${day}T20:00:00`, fpsAvg: fps });

    const report = attribution(db);
    const fps = report.findings.find((f) => f.metric === "fps")!;
    expect(fps).toBeDefined();
    expect(fps.before).toBe(120);
    expect(fps.after).toBe(90);
    expect(fps.deltaPct).toBeCloseTo(-0.25, 5);
    expect(fps.confidence).toBe("low"); // 3 < LOW_CONFIDENCE_N
    expect(fps.label).toContain("Average FPS lost");
  });
});

describe("attribution — sparse data", () => {
  it("empty DB yields no changes / findings and never crashes", () => {
    const db = openFixtureDb();
    const report = attribution(db);
    expect(report.changes).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.counts).toEqual({ readings: 0, withHash: 0, raids: 0, perfSamples: 0 });
    expect(report.lowConfidence).toBe(true);
  });
});
