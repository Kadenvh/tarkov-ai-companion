import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LogWatcher } from "../src/logs/watcher.js";
import { openProfile } from "../src/store.js";
import { listRaids } from "../src/journal.js";
import type { EngineEventMap } from "../src/events.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "Logs");
const tmpDirs: string[] = [];

/** isolate a subset of session folders so the watcher's "newest" is deterministic */
function logsDirWith(...folders: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "tac-logs-"));
  for (const f of folders) cpSync(join(FIXTURES, f), join(dir, f), { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("pumpOnce summary (on-demand pull sync)", () => {
  it("reports what it applied and re-syncs are incremental (cursor at EOF)", () => {
    const store = openProfile("pull-summary-regular", { memory: true });
    const watcher = new LogWatcher({
      store,
      logsDir: logsDirWith("log_2026.07.11_4-38-37_1.0.6.0.46010"),
      snapshotVersion: "1.0.6.0.46010",
    });

    const first = watcher.pumpOnce();
    expect(first.session).toContain("1.0.6.0.46010");
    expect(first.parsedEvents).toBeGreaterThan(0);
    expect(first.raidsEnded).toBeGreaterThanOrEqual(1);

    // Cursor now sits at EOF — a second pull ingests nothing new.
    const second = watcher.pumpOnce();
    expect(second.parsedEvents).toBe(0);
    expect(second.raidsEnded).toBe(0);
    expect(second.quests).toBe(0);
  });

  it("returns an empty summary when the logs dir has no sessions", () => {
    const store = openProfile("pull-empty-regular", { memory: true });
    const empty = mkdtempSync(join(tmpdir(), "tac-empty-logs-"));
    tmpDirs.push(empty);
    const summary = new LogWatcher({ store, logsDir: empty }).pumpOnce();
    expect(summary).toEqual({ session: null, parsedEvents: 0, quests: 0, fleaSales: 0, raidsEnded: 0 });
  });
});

describe("live watcher replay (M2.2 acceptance: real 2026-05-25 session)", () => {
  it("detects the Ground Zero raid end-to-end from the real 1.0.5 session logs", () => {
    const store = openProfile("replay-may-regular", { memory: true });
    const emitted: string[] = [];
    const lifecycle: EngineEventMap["raid.ended"][] = [];
    store.events.on("raid.created", () => emitted.push("created"));
    store.events.on("raid.confirmed", (e) => emitted.push(`confirmed:${e.map}`));
    store.events.on("raid.started", (e) => emitted.push(`started:${e.map}`));
    store.events.on("raid.ended", (e) => {
      emitted.push(`ended:${e.map}`);
      lifecycle.push(e);
    });

    const watcher = new LogWatcher({
      store,
      logsDir: logsDirWith("log_2026.05.25_12-34-11_1.0.5.0.45272"),
      snapshotVersion: "1.0.5.0.45272",
    });
    watcher.pumpOnce();

    expect(emitted).toEqual([
      "created",
      "confirmed:sandbox_high",
      "started:sandbox_high",
      "ended:sandbox_high",
    ]);
    expect(lifecycle[0]?.mode).toBe("regular");
    // raid end inferred from the post-raid menu return (this session logged no userMatchOver)
    const raids = listRaids(store.db);
    expect(raids).toHaveLength(1);
    expect(raids[0]).toMatchObject({ map: "sandbox_high", mode: "regular", source: "live", version: "1.0.5.0.45272" });
    expect(raids[0]?.startedAt).toBe("2026-05-25T12:40:07.931");
    expect(raids[0]?.queueSec).toBeGreaterThan(50);
    expect(raids[0]?.durationSec).toBeGreaterThan(500);
  });

  it("replays the real 1.0.6 factory session: 3 raids, quests, profile, no dupes on re-pump", () => {
    const store = openProfile("replay-jul-regular", { memory: true });
    const quests: EngineEventMap["quest.changed"][] = [];
    const profiles: EngineEventMap["profile.detected"][] = [];
    store.events.on("quest.changed", (e) => quests.push(e));
    store.events.on("profile.detected", (e) => profiles.push(e));

    const watcher = new LogWatcher({
      store,
      logsDir: logsDirWith("log_2026.07.11_4-38-37_1.0.6.0.46010"),
      snapshotVersion: "1.0.6.0.46010",
    });
    watcher.pumpOnce();

    const raids = listRaids(store.db);
    expect(raids).toHaveLength(3);
    expect(raids.every((r) => r.map === "factory4_day")).toBe(true);

    // first raid ends with a clean userMatchOver; duration = GameStarted → matchOver
    const clean = raids.find((r) => r.sid?.includes("US-STL01G030"));
    expect(clean?.startedAt).toBe("2026-07-11T05:10:51.990");
    expect(clean?.endedAt).toBe("2026-07-11T05:22:07.133");
    expect(clean?.durationSec).toBeCloseTo(675.1, 0);
    expect(clean?.outcome).toBe("unknown"); // logs carry no survived/died signal

    expect(quests).toEqual([
      { taskId: "68400926706e0a55e90b0007", status: "completed", ts: "2026-07-11T05:04:09.929" },
      { taskId: "68400953506db3b4db0700e7", status: "started", ts: "2026-07-11T05:04:13.069" },
    ]);
    expect(store.getTask("68400926706e0a55e90b0007")).toMatchObject({ complete: true });
    expect(profiles[0]).toMatchObject({ profileId: "0123456789abcdef01234567", mode: "regular" });
    expect(store.profileId).toBe("0123456789abcdef01234567");

    // cursor persisted → a second pump reads nothing new and duplicates nothing
    watcher.pumpOnce();
    expect(listRaids(store.db)).toHaveLength(3);
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM quest_events").get() as { n: number }).n).toBe(2);
    const cursor = store.getLogCursor<{ session: string; offsets: Record<string, number> }>();
    expect(cursor?.session).toBe("log_2026.07.11_4-38-37_1.0.6.0.46010");
    expect(Object.values(cursor?.offsets ?? {}).every((o) => o > 0)).toBe(true);
  });

  it("emits patch.detected once when the log-folder version is ahead of the snapshot (M8.1)", () => {
    const store = openProfile("replay-patch-regular", { memory: true });
    const patches: EngineEventMap["patch.detected"][] = [];
    store.events.on("patch.detected", (e) => patches.push(e));

    const watcher = new LogWatcher({
      store,
      logsDir: logsDirWith("log_2026.05.25_20-57-56_1.0.5.0.45272", "log_2026.07.11_4-38-37_1.0.6.0.46010"),
      snapshotVersion: "1.0.5.0.45272", // pretend the snapshot is one patch behind
    });
    watcher.pumpOnce();
    watcher.pumpOnce();

    expect(patches).toHaveLength(1);
    expect(patches[0]?.version).toBe("1.0.6.0.46010");
  });

  it("switches to a NEW session folder appearing mid-run", () => {
    const store = openProfile("replay-switch-regular", { memory: true });
    const dir = logsDirWith("log_2026.05.25_12-34-11_1.0.5.0.45272");
    const watcher = new LogWatcher({ store, logsDir: dir, snapshotVersion: null });
    watcher.pumpOnce();
    expect(listRaids(store.db)).toHaveLength(1);

    // game restarts → a newer session folder appears
    cpSync(join(FIXTURES, "log_2026.07.11_4-38-37_1.0.6.0.46010"), join(dir, "log_2026.07.11_4-38-37_1.0.6.0.46010"), {
      recursive: true,
    });
    watcher.pumpOnce();
    const raids = listRaids(store.db);
    expect(raids).toHaveLength(4); // 1 (may) + 3 (july)
  });
});
