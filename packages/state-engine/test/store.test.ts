import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openProfile } from "../src/store.js";
import { listRaids, setRaidOutcome } from "../src/journal.js";

const progressFixture = () =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "tarkovtracker-progress.json"), "utf8")) as unknown;

const mem = (key = "test-regular") => openProfile(key, { memory: true });

describe("ProfileStore basics (M2.1)", () => {
  it("persists tasks, objectives, hideout, traders and typed meta", () => {
    const store = mem();
    store.setTaskState("aaaaaaaaaaaaaaaaaaaaaaaa", { complete: true, ts: "2026-07-11T00:00:00" });
    store.setObjectiveState("obj-1", { count: 3, complete: false });
    store.setHideoutLevel("5d484fcd654e7668ec2ec322", 2);
    store.setTraderState("54cb50c76803fa8b248b4571", { level: 3, rep: 0.35 });
    store.setLevel(23);
    store.setXpOffset(1500);
    store.setPrestige(1);
    store.setFaction("USEC");

    expect(store.getTask("aaaaaaaaaaaaaaaaaaaaaaaa")).toMatchObject({ complete: true, failed: false });
    expect(store.getObjectives()[0]).toMatchObject({ objectiveId: "obj-1", count: 3, complete: false });
    expect(store.getHideout()[0]).toMatchObject({ stationId: "5d484fcd654e7668ec2ec322", level: 2 });
    expect(store.getTraders()[0]).toMatchObject({ level: 3, rep: 0.35 });
    expect(store.level).toBe(23);
    expect(store.xpOffset).toBe(1500);
    expect(store.prestige).toBe(1);
    expect(store.faction).toBe("USEC");
    expect(store.gameMode).toBe("regular");
    expect(mem("test-pve").gameMode).toBe("pve");
  });

  it("emits state.changed on mutations and quest.changed on quest events", () => {
    const store = mem();
    const reasons: string[] = [];
    const quests: string[] = [];
    store.events.on("state.changed", (e) => reasons.push(e.reason));
    store.events.on("quest.changed", (e) => quests.push(`${e.taskId}:${e.status}`));

    store.setLevel(5);
    store.applyQuestEvent({ taskId: "bbbbbbbbbbbbbbbbbbbbbbbb", status: "completed", ts: "2026-07-11T01:00:00" });
    expect(reasons).toContain("level");
    expect(reasons).toContain("quest");
    expect(quests).toEqual(["bbbbbbbbbbbbbbbbbbbbbbbb:completed"]);
  });

  it("quest events are idempotent and drive task_state transitions", () => {
    const store = mem();
    const ev = { taskId: "cccccccccccccccccccccccc", status: "completed" as const, ts: "2026-07-11T01:00:00" };
    expect(store.applyQuestEvent(ev, "backfill")).toBe(true);
    expect(store.applyQuestEvent(ev, "backfill")).toBe(false); // dedupe
    expect(store.getTask(ev.taskId)).toMatchObject({ complete: true, failed: false });

    store.applyQuestEvent({ taskId: ev.taskId, status: "failed", ts: "2026-07-11T02:00:00" });
    expect(store.getTask(ev.taskId)).toMatchObject({ complete: false, failed: true });
    const events = store.db.prepare("SELECT COUNT(*) AS n FROM quest_events").get() as { n: number };
    expect(events.n).toBe(2);
  });

  it("goals/weights/progressEpoch round-trip through meta", () => {
    const store = mem();
    store.setGoals([{ type: "kappa" }]);
    store.setWeights({ mapAversion: { lighthouse: 2 } });
    expect(store.getGoals()).toEqual([{ type: "kappa" }]);
    expect(store.getWeights()).toEqual({ mapAversion: { lighthouse: 2 } });
    expect(store.progressEpoch).toBe(0);
    expect(store.bumpProgressEpoch()).toBe(1);
    expect(store.progressEpoch).toBe(1);
  });
});

describe("raid journal (M2.8)", () => {
  const draft = {
    sid: "US-STL01G030_cafebabecafebabecafebabe_11.07.26_12-42-34",
    map: "factory4_day",
    mode: "regular" as const,
    shortId: "0JJW2J",
    queuedAt: "2026-07-11T05:10:00.299",
    startedAt: "2026-07-11T05:10:51.990",
    endedAt: "2026-07-11T05:22:07.133",
    queueSec: 51.7,
    durationSec: 675.1,
    outcome: "unknown" as const,
    endInferred: false,
  };

  it("journals raids, dedupes on sid, and supports outcome upgrades", () => {
    const store = mem();
    const id = store.recordRaid(draft, "live", "1.0.6.0.46010");
    expect(id).not.toBeNull();
    expect(store.recordRaid(draft, "backfill", "1.0.6.0.46010")).toBeNull(); // dedupe

    const rows = listRaids(store.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ map: "factory4_day", outcome: "unknown", source: "live", version: "1.0.6.0.46010" });

    expect(setRaidOutcome(store.db, id!, "survived")).toBe(true);
    expect(listRaids(store.db)[0]?.outcome).toBe("survived");
  });

  it("flea sales dedupe on (item, amount, ts)", () => {
    const store = mem();
    const sale = { itemId: "6389c8c5dbfd5e4b95197e6b", amount: 397777, ts: "2026-01-30T07:49:59.057" };
    expect(store.recordFleaSale(sale)).toBe(true);
    expect(store.recordFleaSale(sale)).toBe(false);
  });
});

describe("TarkovTracker import (M2.1 acceptance: lossless round-trip)", () => {
  it("imports a real-shaped GET /progress payload", () => {
    const store = mem();
    store.importTarkovTracker(progressFixture());

    expect(store.level).toBe(42);
    expect(store.faction).toBe("USEC");
    expect(store.getTask("5936d90786f7742b1420ba5b")).toMatchObject({ complete: true });
    expect(store.getTask("66058ccf06ef1d50a60c1f48")).toMatchObject({ complete: false, failed: true });
    // module ids `<stationId>-<level>` → station level = max completed
    expect(store.getHideout().find((h) => h.stationId === "5d484fcd654e7668ec2ec322")?.level).toBe(2);
    expect(store.getHideout().find((h) => h.stationId === "5d388e97081959000a123acf")?.level).toBe(1);
    expect(store.getHideout().some((h) => h.stationId === "5d494a0e5b56502f18c98a02")).toBe(false);
    expect(store.getObjectives().find((o) => o.objectiveId === "5967530a86f77462ba22226b-1")?.count).toBe(3);
  });

  it("round-trips losslessly through exportTarkovTracker", () => {
    const store = mem();
    const original = (progressFixture() as { data: Record<string, unknown> }).data;
    store.importTarkovTracker(progressFixture());
    const exported = store.exportTarkovTracker();

    const norm = (arr: { id: string; complete?: boolean | undefined; failed?: boolean | undefined; count?: number | undefined }[]) =>
      [...arr]
        .map((t) => ({ id: t.id, complete: t.complete ?? false, failed: t.failed ?? false, count: t.count ?? 0 }))
        .sort((a, b) => a.id.localeCompare(b.id));

    expect(norm(exported.tasksProgress)).toEqual(norm(original["tasksProgress"] as []));
    expect(norm(exported.taskObjectivesProgress)).toEqual(norm(original["taskObjectivesProgress"] as []));
    expect(exported.hideoutModulesProgress).toEqual(original["hideoutModulesProgress"]);
    expect(exported.hideoutPartsProgress).toEqual(original["hideoutPartsProgress"]);
    expect(exported.playerLevel).toBe(original["playerLevel"]);
    expect(exported.pmcFaction).toBe(original["pmcFaction"]);
    expect(exported.gameEdition).toBe(original["gameEdition"]);
    expect(exported.displayName).toBe(original["displayName"]);
  });
});

describe("toPlayerState (planner handoff)", () => {
  it("produces the PlayerState shape the planner consumes", () => {
    const store = mem();
    store.importTarkovTracker(progressFixture());
    store.setPrestige(0);
    store.setTraderState("54cb50c76803fa8b248b4571", { level: 2, rep: 0.21 });

    const state = store.toPlayerState();
    expect(state.gameMode).toBe("regular");
    expect(state.level).toBe(42);
    expect(state.faction).toBe("USEC");
    expect(state.completedTasks).toContain("5936d90786f7742b1420ba5b");
    expect(state.failedTasks).toEqual(["66058ccf06ef1d50a60c1f48"]);
    expect(state.traderRep["54cb50c76803fa8b248b4571"]).toBe(0.21);
  });
});
