import type { DatabaseSync } from "node:sqlite";
import type { RaidOutcome } from "./events.js";

/**
 * Raid journal (SPEC M2.8) — read/update helpers over the `raids` table
 * (CONTRACTS §4). Rows are written by the watcher (live) and backfill via
 * `ProfileStore.recordRaid`; @tac/insights consumes them read-only.
 *
 * Outcome inference, documented honestly: the logs contain NO survived/died/
 * extract signal (research/03 §2 — grep-verified against real raid sessions),
 * so every log-derived raid lands as `unknown`. `setRaidOutcome` exists for
 * manual entry and future OCR (M2.6) to upgrade rows; duration/queue times
 * ARE exact (from GameStarted/userMatchOver or the menu-return fallback).
 */

export interface RaidRow {
  id: number;
  sid: string | null;
  map: string | null;
  mode: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  queueSec: number | null;
  durationSec: number | null;
  outcome: RaidOutcome;
  source: "live" | "backfill";
  version: string | null;
}

interface RawRaidRow {
  id: number;
  sid: string | null;
  map: string | null;
  mode: string | null;
  queued_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  queue_sec: number | null;
  duration_sec: number | null;
  outcome: string;
  source: string;
  version: string | null;
}

function toRow(r: RawRaidRow): RaidRow {
  return {
    id: r.id,
    sid: r.sid,
    map: r.map,
    mode: r.mode,
    queuedAt: r.queued_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    queueSec: r.queue_sec,
    durationSec: r.duration_sec,
    outcome: (["survived", "died", "unknown"].includes(r.outcome) ? r.outcome : "unknown") as RaidOutcome,
    source: r.source === "backfill" ? "backfill" : "live",
    version: r.version,
  };
}

export function listRaids(db: DatabaseSync, opts: { map?: string; limit?: number } = {}): RaidRow[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts.map) {
    clauses.push("map = ?");
    params.push(opts.map);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = opts.limit !== undefined ? ` LIMIT ${Math.max(1, Math.floor(opts.limit))}` : "";
  const rows = db
    .prepare(`SELECT * FROM raids${where} ORDER BY COALESCE(started_at, queued_at, ended_at) DESC${limit}`)
    .all(...params) as unknown as RawRaidRow[];
  return rows.map(toRow);
}

/** Upgrade a journal row's outcome (manual entry / OCR — logs can't tell). */
export function setRaidOutcome(db: DatabaseSync, raidId: number, outcome: RaidOutcome): boolean {
  const res = db.prepare("UPDATE raids SET outcome = ? WHERE id = ?").run(outcome, raidId);
  return res.changes > 0;
}
