/**
 * Fixture-DB builders for insights tests. Executes the contracted DDL
 * (schema.sql — verbatim from CONTRACTS.md §4) into an in-memory node:sqlite
 * database and inserts fully synthetic rows. All ids are fake 24-hex values;
 * no real profile/account/session ids appear anywhere.
 */

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function openFixtureDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  return db;
}

/** Deterministic fake 24-hex id (fixture rule: never real ids). */
export function fakeId(n: number): string {
  return n.toString(16).padStart(24, "0");
}

export interface RaidInput {
  sid?: string | null;
  map?: string | null;
  mode?: string;
  queuedAt?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  queueSec?: number | null;
  durationSec?: number | null;
  outcome?: "survived" | "died" | "unknown";
  source?: string;
  version?: string;
}

export function insertRaid(db: DatabaseSync, raid: RaidInput): void {
  db.prepare(
    `INSERT INTO raids (sid, map, mode, queued_at, started_at, ended_at,
                        queue_sec, duration_sec, outcome, source, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    raid.sid ?? null,
    raid.map ?? null,
    raid.mode ?? "regular",
    raid.queuedAt ?? null,
    raid.startedAt ?? null,
    raid.endedAt ?? null,
    raid.queueSec ?? null,
    raid.durationSec ?? null,
    raid.outcome ?? "unknown",
    raid.source ?? "live",
    raid.version ?? "1.0.6.100",
  );
}

export function insertFleaSale(db: DatabaseSync, itemName: string, amount: number, ts: string): void {
  db.prepare(`INSERT INTO flea_sales (item_name, amount, ts) VALUES (?, ?, ?)`).run(itemName, amount, ts);
}

export function insertQuestEvent(db: DatabaseSync, taskId: string, status: string, ts: string): void {
  db.prepare(`INSERT INTO quest_events (task_id, status, ts) VALUES (?, ?, ?)`).run(taskId, status, ts);
}

/** minutes -> "HH:MM:SS" clock fragment offset from a base "HH:MM:SS". */
function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

/**
 * The standard hand-computable fixture: 24 raids in 6 sessions across 6 days,
 * 4 flea sales, 36 quest events. Every expectation in the tests is derived by
 * hand from this table:
 *
 * | session | day        | map         | raids | start hour | queue_sec | duration_sec | outcomes      |
 * |---------|------------|-------------|-------|------------|-----------|--------------|---------------|
 * | 0       | 2026-07-01 | customs     | 5     | 20         | 100 each  | 1200 each    | S S S D U     |
 * | 1       | 2026-07-02 | customs     | 5     | 20         | 100 each  | 1200 each    | S S S D D     |
 * | 2       | 2026-07-03 | factory     | 4     | 21         | 30 each   | 600 each     | S D D D       |
 * | 3       | 2026-07-04 | factory     | 4     | 21         | 60 each   | 600 each     | S D D D       |
 * | 4       | 2026-07-05 | woods       | 4     | 9          | 200 each  | 2500 each    | S S S D       |
 * | 5       | 2026-07-06 | interchange | 2     | 9          | null      | null         | U U           |
 *
 * Within a session raids start 10 min apart and end 8 min after they start
 * (session length = 10·(count−1) + 8 minutes; wall-clock spacing is
 * intentionally independent of duration_sec, which is authoritative).
 */
export function seedStandardFixture(db: DatabaseSync): void {
  interface SessionSpec {
    day: string;
    map: string;
    startHour: number;
    queueSec: number | null;
    durationSec: number | null;
    outcomes: ("survived" | "died" | "unknown")[];
  }
  const sessions: SessionSpec[] = [
    { day: "2026-07-01", map: "customs", startHour: 20, queueSec: 100, durationSec: 1200,
      outcomes: ["survived", "survived", "survived", "died", "unknown"] },
    { day: "2026-07-02", map: "customs", startHour: 20, queueSec: 100, durationSec: 1200,
      outcomes: ["survived", "survived", "survived", "died", "died"] },
    { day: "2026-07-03", map: "factory", startHour: 21, queueSec: 30, durationSec: 600,
      outcomes: ["survived", "died", "died", "died"] },
    { day: "2026-07-04", map: "factory", startHour: 21, queueSec: 60, durationSec: 600,
      outcomes: ["survived", "died", "died", "died"] },
    { day: "2026-07-05", map: "woods", startHour: 9, queueSec: 200, durationSec: 2500,
      outcomes: ["survived", "survived", "survived", "died"] },
    { day: "2026-07-06", map: "interchange", startHour: 9, queueSec: null, durationSec: null,
      outcomes: ["unknown", "unknown"] },
  ];

  let raidNo = 0;
  for (const s of sessions) {
    s.outcomes.forEach((outcome, i) => {
      const startMin = i * 10;
      insertRaid(db, {
        sid: fakeId(0xa000 + raidNo),
        map: s.map,
        startedAt: `${s.day}T${clock(s.startHour, startMin)}`,
        endedAt: `${s.day}T${clock(s.startHour, startMin + 8)}`,
        queuedAt: `${s.day}T${clock(s.startHour, startMin)}`,
        queueSec: s.queueSec,
        durationSec: s.durationSec,
        outcome,
      });
      raidNo++;
    });
  }

  insertFleaSale(db, "Salewa first aid kit", 10_000, "2026-07-01T20:05:00");
  insertFleaSale(db, "Graphics card", 5_000, "2026-07-01T21:00:00");
  insertFleaSale(db, "Physical Bitcoin", 20_000, "2026-07-02T20:15:00");
  insertFleaSale(db, "Object 21WS keycard", 40_000, "2026-07-08T12:00:00");

  // 36 quest events over the play days -> task_focus_ratio = 36 / 24 = 1.5.
  for (let i = 0; i < 36; i++) {
    const day = `2026-07-0${(i % 6) + 1}`;
    insertQuestEvent(db, fakeId(0xb000 + i), i % 3 === 0 ? "completed" : "started", `${day}T21:00:00`);
  }
}
