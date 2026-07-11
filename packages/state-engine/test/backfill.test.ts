import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backfillHistory } from "../src/backfill.js";
import { openProfile } from "../src/store.js";
import { listRaids } from "../src/journal.js";

const LOGS = join(import.meta.dirname, "fixtures", "Logs");

describe("historical backfill (M2.3)", () => {
  it("reconstructs raids, quest state and flea history from all real sessions in one command", () => {
    const store = openProfile("backfill-regular", { memory: true });
    const result = backfillHistory(store, { logsDir: LOGS });

    expect(result.sessionsScanned).toBe(4); // 1.0.1 → 1.0.5 ×2 → 1.0.6
    expect(result.sessionsReplayed).toBe(4);
    // quest events across all sessions: 7 (jan) + 1 (may) + 2 (jul)
    expect(result.questEventsApplied).toBe(10);
    // raids: 5 (jan, incl. one scav raid) + 1 + 1 + 3 (jul)
    expect(result.raidsRecorded).toBe(10);
    expect(result.fleaSalesRecorded).toBe(7);

    // (profileId, version) breakpoints: one per version line (same profile throughout)
    expect(result.breakpoints.map((b) => b.version)).toEqual(["1.0.1.1.42751", "1.0.5.0.45272", "1.0.6.0.46010"]);
    expect(new Set(result.breakpoints.map((b) => b.profileId))).toEqual(new Set(["0123456789abcdef01234567"]));

    const raids = listRaids(store.db);
    expect(raids).toHaveLength(10);
    expect(raids.every((r) => r.source === "backfill")).toBe(true);
    const byMap = new Map<string | null, number>();
    for (const r of raids) byMap.set(r.map, (byMap.get(r.map) ?? 0) + 1);
    expect(byMap.get("bigmap")).toBe(2);
    expect(byMap.get("woods")).toBe(3); // 2 jan + 1 may evening session
    expect(byMap.get("factory4_day")).toBe(4); // 1 jan scav + 3 jul
    expect(byMap.get("sandbox_high")).toBe(1);

    // task state reconstructed: last transition wins
    expect(store.getTask("68400926706e0a55e90b0007")).toMatchObject({ complete: true });
    expect(store.getTask("66058ccf06ef1d50a60c1f48")).toMatchObject({ failed: true });
    expect(store.profileId).toBe("0123456789abcdef01234567");
    expect(store.toPlayerState().completedTasks.length).toBeGreaterThanOrEqual(5);
  });

  it("is idempotent — re-running changes nothing", () => {
    const store = openProfile("backfill2-regular", { memory: true });
    backfillHistory(store, { logsDir: LOGS });
    const raidsBefore = (store.db.prepare("SELECT COUNT(*) AS n FROM raids").get() as { n: number }).n;

    const second = backfillHistory(store, { logsDir: LOGS });
    expect(second.questEventsApplied).toBe(0);
    expect(second.raidsRecorded).toBe(0);
    expect(second.fleaSalesRecorded).toBe(0);
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM raids").get() as { n: number }).n).toBe(raidsBefore);
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM quest_events").get() as { n: number }).n).toBe(10);
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM flea_sales").get() as { n: number }).n).toBe(7);
  });

  it("skips sessions for a different profile id", () => {
    const store = openProfile("backfill3-regular", { memory: true });
    const result = backfillHistory(store, { logsDir: LOGS, profileId: "ffffffffffffffffffffffff" });
    expect(result.sessionsReplayed).toBe(0);
    expect(result.sessionsSkipped).toBe(4);
    expect(listRaids(store.db)).toHaveLength(0);
  });
});
