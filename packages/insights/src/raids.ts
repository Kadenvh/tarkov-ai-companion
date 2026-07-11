/**
 * M7.1 — Raid analytics over the per-profile SQLite raid journal.
 *
 * Contract: every function takes a `node:sqlite` DatabaseSync handle opened by
 * the caller (read-only use; @tac/state-engine owns writes/migrations — see
 * docs/spec/CONTRACTS.md §4). All results are typed, JSON-serializable, and
 * carry sample sizes (`n`) with a `lowConfidence` flag when n < 5.
 *
 * Conventions:
 * - A raid's timestamp = started_at ?? queued_at ?? ended_at.
 * - `duration_sec` is authoritative for in-raid duration (queue/load excluded);
 *   timestamps are wall-clock and only used for hours, days, and gaps.
 * - Survival rate = survived / (survived + died); `unknown` outcomes count
 *   toward `n` but not the rate; rate is null when nothing is decided.
 *
 * @tier T0 — pure computation over the app-owned profile DB.
 */

import type { DatabaseSync } from "node:sqlite";
import { epochMs, hourOf, lowConfidence, mean, median, round4 } from "./util.js";

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
  outcome: "survived" | "died" | "unknown";
  source: string;
  version: string | null;
}

export function loadRaids(db: DatabaseSync): RaidRow[] {
  const rows = db
    .prepare(
      `SELECT id, sid, map, mode, queued_at, started_at, ended_at,
              queue_sec, duration_sec, outcome, source, version
       FROM raids ORDER BY id`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r["id"]),
    sid: (r["sid"] as string | null) ?? null,
    map: (r["map"] as string | null) ?? null,
    mode: (r["mode"] as string | null) ?? null,
    queuedAt: (r["queued_at"] as string | null) ?? null,
    startedAt: (r["started_at"] as string | null) ?? null,
    endedAt: (r["ended_at"] as string | null) ?? null,
    queueSec: r["queue_sec"] == null ? null : Number(r["queue_sec"]),
    durationSec: r["duration_sec"] == null ? null : Number(r["duration_sec"]),
    outcome: normalizeOutcome(r["outcome"]),
    source: String(r["source"] ?? "live"),
    version: (r["version"] as string | null) ?? null,
  }));
}

function normalizeOutcome(v: unknown): RaidRow["outcome"] {
  return v === "survived" || v === "died" ? v : "unknown";
}

/** started_at ?? queued_at ?? ended_at — the raid's representative timestamp. */
export function raidTs(r: RaidRow): string | null {
  return r.startedAt ?? r.queuedAt ?? r.endedAt;
}

/** ended_at ?? started_at ?? queued_at — the raid's end-of-activity timestamp. */
export function raidEndTs(r: RaidRow): string | null {
  return r.endedAt ?? r.startedAt ?? r.queuedAt;
}

// ---------------------------------------------------------------------------
// Survival breakdowns
// ---------------------------------------------------------------------------

export interface SurvivalStat {
  n: number;
  survived: number;
  died: number;
  unknown: number;
  /** survived / (survived + died); null when no decided outcomes. */
  survivalRate: number | null;
  lowConfidence: boolean;
}

function survivalStat(raids: RaidRow[]): SurvivalStat {
  const survived = raids.filter((r) => r.outcome === "survived").length;
  const died = raids.filter((r) => r.outcome === "died").length;
  const unknown = raids.length - survived - died;
  const decided = survived + died;
  return {
    n: raids.length,
    survived,
    died,
    unknown,
    survivalRate: decided === 0 ? null : round4(survived / decided),
    lowConfidence: lowConfidence(raids.length),
  };
}

export interface SurvivalByMapRow extends SurvivalStat {
  map: string;
}

/** Survival by map. Raids with a NULL map are grouped under "(unknown)". */
export function survivalByMap(db: DatabaseSync): SurvivalByMapRow[] {
  const byMap = new Map<string, RaidRow[]>();
  for (const r of loadRaids(db)) {
    const key = r.map ?? "(unknown)";
    const bucket = byMap.get(key) ?? [];
    bucket.push(r);
    byMap.set(key, bucket);
  }
  return [...byMap.entries()]
    .map(([map, raids]) => ({ map, ...survivalStat(raids) }))
    .sort((a, b) => b.n - a.n || a.map.localeCompare(b.map));
}

export interface SurvivalByHourRow extends SurvivalStat {
  /** Wall-clock hour of day, 0-23, as recorded in the log timestamps. */
  hour: number;
}

export interface SurvivalByHourResult {
  rows: SurvivalByHourRow[];
  /** Raids skipped because no timestamp could be parsed. */
  excluded: number;
}

export function survivalByHour(db: DatabaseSync): SurvivalByHourResult {
  const byHour = new Map<number, RaidRow[]>();
  let excluded = 0;
  for (const r of loadRaids(db)) {
    const hour = hourOf(raidTs(r));
    if (hour === null) {
      excluded++;
      continue;
    }
    const bucket = byHour.get(hour) ?? [];
    bucket.push(r);
    byHour.set(hour, bucket);
  }
  const rows = [...byHour.entries()]
    .map(([hour, raids]) => ({ hour, ...survivalStat(raids) }))
    .sort((a, b) => a.hour - b.hour);
  return { rows, excluded };
}

export interface DurationBucket {
  label: string;
  /** inclusive lower bound, seconds */
  minSec: number;
  /** exclusive upper bound, seconds (Infinity for the last bucket) */
  maxSec: number;
}

export const DURATION_BUCKETS: readonly DurationBucket[] = [
  { label: "0-10m", minSec: 0, maxSec: 600 },
  { label: "10-20m", minSec: 600, maxSec: 1200 },
  { label: "20-30m", minSec: 1200, maxSec: 1800 },
  { label: "30-40m", minSec: 1800, maxSec: 2400 },
  { label: "40m+", minSec: 2400, maxSec: Infinity },
];

export interface SurvivalByDurationRow extends SurvivalStat {
  bucket: string;
}

export interface SurvivalByDurationResult {
  rows: SurvivalByDurationRow[];
  /** Raids skipped because duration_sec is NULL. */
  excluded: number;
}

export function survivalByDuration(db: DatabaseSync): SurvivalByDurationResult {
  const byBucket = new Map<string, RaidRow[]>();
  let excluded = 0;
  for (const r of loadRaids(db)) {
    if (r.durationSec == null) {
      excluded++;
      continue;
    }
    const bucket = DURATION_BUCKETS.find((b) => r.durationSec! >= b.minSec && r.durationSec! < b.maxSec);
    if (!bucket) {
      excluded++; // negative duration — bad row, skip
      continue;
    }
    const list = byBucket.get(bucket.label) ?? [];
    list.push(r);
    byBucket.set(bucket.label, list);
  }
  const rows = DURATION_BUCKETS.filter((b) => byBucket.has(b.label)).map((b) => ({
    bucket: b.label,
    ...survivalStat(byBucket.get(b.label)!),
  }));
  return { rows, excluded };
}

// ---------------------------------------------------------------------------
// Queue-time patterns
// ---------------------------------------------------------------------------

export interface QueueStat {
  n: number;
  avgSec: number | null;
  medianSec: number | null;
  lowConfidence: boolean;
}

export interface QueueByMapRow extends QueueStat {
  map: string;
}

export interface QueueByHourRow extends QueueStat {
  hour: number;
}

export interface QueuePatterns {
  byMap: QueueByMapRow[];
  byHour: QueueByHourRow[];
  /** Raids with a NULL queue_sec (not counted in any group). */
  excluded: number;
}

export function queuePatterns(db: DatabaseSync): QueuePatterns {
  const raids = loadRaids(db);
  const withQueue = raids.filter((r) => r.queueSec != null);
  const excluded = raids.length - withQueue.length;

  const stat = (group: RaidRow[]): QueueStat => {
    const secs = group.map((r) => r.queueSec!);
    const avg = mean(secs);
    const med = median(secs);
    return {
      n: group.length,
      avgSec: avg === null ? null : round4(avg),
      medianSec: med === null ? null : round4(med),
      lowConfidence: lowConfidence(group.length),
    };
  };

  const byMapGroups = new Map<string, RaidRow[]>();
  const byHourGroups = new Map<number, RaidRow[]>();
  for (const r of withQueue) {
    const mapKey = r.map ?? "(unknown)";
    const mapList = byMapGroups.get(mapKey) ?? [];
    mapList.push(r);
    byMapGroups.set(mapKey, mapList);
    const hour = hourOf(raidTs(r));
    if (hour !== null) {
      const hourList = byHourGroups.get(hour) ?? [];
      hourList.push(r);
      byHourGroups.set(hour, hourList);
    }
  }

  return {
    byMap: [...byMapGroups.entries()]
      .map(([map, group]) => ({ map, ...stat(group) }))
      .sort((a, b) => b.n - a.n || a.map.localeCompare(b.map)),
    byHour: [...byHourGroups.entries()]
      .map(([hour, group]) => ({ hour, ...stat(group) }))
      .sort((a, b) => a.hour - b.hour),
    excluded,
  };
}

// ---------------------------------------------------------------------------
// Session rhythm
// ---------------------------------------------------------------------------

export const DEFAULT_SESSION_GAP_MIN = 90;

export interface SessionOptions {
  /** A gap strictly greater than this (minutes) between one raid's end and the next raid's start opens a new session. Default 90. */
  gapMinutes?: number;
}

export interface RaidSession {
  /** 0-based chronological session index. */
  index: number;
  startTs: string;
  endTs: string;
  /** Wall-clock hour the session started (null if unparseable). */
  startHour: number | null;
  raidCount: number;
  /** First raid start to last raid end, in minutes. */
  lengthMin: number;
  survived: number;
  died: number;
  unknown: number;
  survivalRate: number | null;
  /** Distinct maps in play order ("(unknown)" for NULL). */
  maps: string[];
  lowConfidence: boolean;
}

export interface SessionRhythm {
  sessions: RaidSession[];
  summary: {
    sessionCount: number;
    totalRaids: number;
    gapMinutes: number;
    raidsPerSession: { mean: number | null; median: number | null };
    sessionLengthMin: { mean: number | null; median: number | null };
    /** Highest survival-rate session (ties → earliest). Null if no session has a decided outcome. */
    best: { index: number; startTs: string; survivalRate: number } | null;
    /** Lowest survival-rate session (ties → earliest). */
    worst: { index: number; startTs: string; survivalRate: number } | null;
    /** n = sessionCount; whole-summary confidence flag. */
    n: number;
    lowConfidence: boolean;
  };
  /** Raids skipped because no timestamp could be parsed. */
  excluded: number;
}

/**
 * Groups raids into play sessions: chronological order by start timestamp; a
 * new session begins when the gap from the previous raid's end to this raid's
 * start is STRICTLY greater than `gapMinutes` (a gap of exactly the threshold
 * stays in the same session).
 */
export function sessionRhythm(db: DatabaseSync, options: SessionOptions = {}): SessionRhythm {
  const gapMinutes = options.gapMinutes ?? DEFAULT_SESSION_GAP_MIN;
  const gapMs = gapMinutes * 60_000;

  const timed: { raid: RaidRow; startMs: number; endMs: number; startTs: string; endTs: string }[] = [];
  let excluded = 0;
  for (const raid of loadRaids(db)) {
    const startTs = raidTs(raid);
    const endTs = raidEndTs(raid);
    const startMs = epochMs(startTs);
    const endMs = epochMs(endTs);
    if (startTs === null || endTs === null || startMs === null || endMs === null) {
      excluded++;
      continue;
    }
    timed.push({ raid, startMs, endMs, startTs, endTs });
  }
  timed.sort((a, b) => a.startMs - b.startMs);

  const groups: (typeof timed)[] = [];
  for (const entry of timed) {
    const current = groups[groups.length - 1];
    const prev = current?.[current.length - 1];
    if (current && prev && entry.startMs - prev.endMs <= gapMs) current.push(entry);
    else groups.push([entry]);
  }

  const sessions: RaidSession[] = groups.map((group, index) => {
    const raids = group.map((g) => g.raid);
    const stat = survivalStat(raids);
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const maps: string[] = [];
    for (const r of raids) {
      const m = r.map ?? "(unknown)";
      if (!maps.includes(m)) maps.push(m);
    }
    return {
      index,
      startTs: first.startTs,
      endTs: last.endTs,
      startHour: hourOf(first.startTs),
      raidCount: raids.length,
      lengthMin: round4((last.endMs - first.startMs) / 60_000),
      survived: stat.survived,
      died: stat.died,
      unknown: stat.unknown,
      survivalRate: stat.survivalRate,
      maps,
      lowConfidence: stat.lowConfidence,
    };
  });

  const counts = sessions.map((s) => s.raidCount);
  const lengths = sessions.map((s) => s.lengthMin);
  const rated = sessions.filter((s) => s.survivalRate !== null);
  let best: SessionRhythm["summary"]["best"] = null;
  let worst: SessionRhythm["summary"]["worst"] = null;
  for (const s of rated) {
    if (best === null || s.survivalRate! > best.survivalRate)
      best = { index: s.index, startTs: s.startTs, survivalRate: s.survivalRate! };
    if (worst === null || s.survivalRate! < worst.survivalRate)
      worst = { index: s.index, startTs: s.startTs, survivalRate: s.survivalRate! };
  }

  const meanCounts = mean(counts);
  const meanLengths = mean(lengths);
  return {
    sessions,
    summary: {
      sessionCount: sessions.length,
      totalRaids: timed.length,
      gapMinutes,
      raidsPerSession: {
        mean: meanCounts === null ? null : round4(meanCounts),
        median: median(counts),
      },
      sessionLengthMin: {
        mean: meanLengths === null ? null : round4(meanLengths),
        median: median(lengths),
      },
      best,
      worst,
      n: sessions.length,
      lowConfidence: lowConfidence(sessions.length),
    },
    excluded,
  };
}
