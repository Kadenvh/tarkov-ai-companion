/**
 * M7.4 — Net-worth trajectory + goal-ETA projector (the Coach "am I on track?"
 * card). Extends the M7.2 economy estimate: on top of the net-worth curve we
 * project when the player reaches a goal — a rouble target, a player level, or
 * a task-count milestone (Kappa) — from their *recent pace*.
 *
 * Honesty rules (same spirit as the rest of @tac/insights):
 * - Pace is measured over a trailing window of observed data, never invented.
 *   With <2 dated data points the pace is null and NO eta is emitted (never a
 *   bogus "0 days" or a divide-by-zero).
 * - `lowConfidence` is true when the pace is backed by fewer than
 *   LOW_CONFIDENCE_N samples, so the UI can hedge.
 * - etaDays / etaRaids are horizon lengths at the current pace, computed from
 *   `remaining / pace`. They are deliberately clock-free (no "now"), so the
 *   same DB yields the same projection on any machine and in any timezone.
 *
 * @tier T0 — pure computation over the app-owned profile DB.
 */

import type { DatabaseSync } from "node:sqlite";
import { dayOf, daysBetween, lowConfidence, round4 } from "./util.js";
import { loadRaids, raidTs } from "./raids.js";
import { netWorthEstimate, type NetWorthEstimate, type NetWorthPoint } from "./economy.js";

// ---------------------------------------------------------------------------
// Goal parsing
// ---------------------------------------------------------------------------

export type GoalKind = "rubles" | "level" | "tasks";

export interface GoalSpec {
  kind: GoalKind;
  target: number;
}

/** Kappa requires this many tasks (SPEC.md M1.6 invariant); default tasks target. */
export const KAPPA_TASK_TARGET = 257;

/**
 * Parse a `?goal=` query string into a GoalSpec. Accepted forms (case-insensitive):
 *   "rubles:50000000" | "roubles:5e7" | "level:40" | "tasks:150" | "kappa"
 * Returns null for a missing / blank / unparseable value so the route can
 * degrade to a plain net-worth trajectory with no projection.
 */
export function parseGoal(raw: string | null | undefined): GoalSpec | null {
  if (raw == null) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return null;
  if (trimmed === "kappa") return { kind: "tasks", target: KAPPA_TASK_TARGET };

  const [kindRaw, valueRaw] = trimmed.split(":", 2);
  const value = valueRaw === undefined ? NaN : Number(valueRaw);
  const pos = Number.isFinite(value) && value > 0;
  switch (kindRaw) {
    case "rubles":
    case "roubles":
      return pos ? { kind: "rubles", target: value } : null;
    case "level":
      return pos ? { kind: "level", target: Math.floor(value) } : null;
    case "tasks":
      return pos ? { kind: "tasks", target: Math.floor(value) } : null;
    case "kappa":
      // "kappa" or "kappa:<n>" — an explicit count overrides the default 257.
      return { kind: "tasks", target: pos ? Math.floor(value) : KAPPA_TASK_TARGET };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Pace measurement
// ---------------------------------------------------------------------------

/** How many trailing days of data the pace is measured over by default. */
export const DEFAULT_PACE_WINDOW_DAYS = 14;

export interface GoalPace {
  /** Metric gained per elapsed day over the window; null when not measurable. */
  perDay: number | null;
  /** Metric gained per raid over the window; null when no raids in the window. */
  perRaid: number | null;
  /** Elapsed days spanned by the window's data (>=1 when any data). */
  windowDays: number;
  /** Raids counted in the window (for the per-raid pace). */
  raidsInWindow: number;
  /** Sample count backing the pace (sales / level readings / task completions). */
  n: number;
  source: string;
}

export interface GoalProjection {
  kind: GoalKind;
  target: number;
  /** Current value of the goal's metric (net worth / level / completed tasks). */
  current: number;
  /** max(0, target − current). */
  remaining: number;
  /** Already at or past the goal — no projection needed. */
  reached: boolean;
  pace: GoalPace;
  /** remaining / pace.perDay; null when pace is unusable or already reached. */
  etaDays: number | null;
  /** remaining / pace.perRaid; null when pace is unusable or already reached. */
  etaRaids: number | null;
  n: number;
  lowConfidence: boolean;
  note: string;
}

export interface NetWorthGoalReport {
  /** The net-worth trajectory (sparkline source), one point per calendar day. */
  series: NetWorthPoint[];
  /** Current net-worth estimate (last series point), or the starting balance. */
  currentEstimate: number;
  /** Full net-worth estimate with its documented caveats. */
  netWorth: NetWorthEstimate;
  /** The goal projection; null when no parseable goal was requested. */
  goal: GoalProjection | null;
  /** True on sparse data (few sales / no dated pace). */
  lowConfidence: boolean;
}

interface DatedGain {
  /** "YYYY-MM-DD" */
  day: string;
  /** cumulative value of the metric at end of this day */
  cumulative: number;
}

/**
 * Given dated cumulative readings and the raids, measure a per-day and per-raid
 * pace over the trailing `windowDays`. `n` is the number of readings that fell
 * in the window.
 */
function measurePace(
  points: DatedGain[],
  raidDays: string[],
  windowDays: number,
  source: string,
): GoalPace {
  const empty: GoalPace = { perDay: null, perRaid: null, windowDays: 0, raidsInWindow: 0, n: 0, source };
  if (points.length === 0) return empty;

  const lastDay = points[points.length - 1]!.day;
  const cutoffMs = Date.parse(`${lastDay}T00:00:00Z`) - windowDays * 86_400_000;
  const inWindow = points.filter((p) => Date.parse(`${p.day}T00:00:00Z`) >= cutoffMs);
  if (inWindow.length === 0) return empty;

  const first = inWindow[0]!;
  const last = inWindow[inWindow.length - 1]!;
  // Value gained across the window: from the reading *before* the window (the
  // baseline) to the last reading. When the window starts at the very first
  // reading there is no earlier baseline, so we use the first reading's value.
  const baselineIndex = points.indexOf(first) - 1;
  const baseline = baselineIndex >= 0 ? points[baselineIndex]!.cumulative : first.cumulative;
  const gained = last.cumulative - baseline;

  const spanDays = Math.max(1, daysBetween(first.day, last.day));
  const raidsInWindow = raidDays.filter((d) => Date.parse(`${d}T00:00:00Z`) >= cutoffMs).length;

  return {
    perDay: round4(gained / spanDays),
    perRaid: raidsInWindow > 0 ? round4(gained / raidsInWindow) : null,
    windowDays: spanDays,
    raidsInWindow,
    n: inWindow.length,
    source,
  };
}

function project(
  kind: GoalKind,
  target: number,
  current: number,
  pace: GoalPace,
  note: string,
): GoalProjection {
  const remaining = Math.max(0, round4(target - current));
  const reached = current >= target;
  const usable = !reached && remaining > 0;
  const perDayOk = pace.perDay !== null && pace.perDay > 0;
  const perRaidOk = pace.perRaid !== null && pace.perRaid > 0;
  return {
    kind,
    target,
    current: round4(current),
    remaining,
    reached,
    pace,
    etaDays: usable && perDayOk ? round4(remaining / pace.perDay!) : reached ? 0 : null,
    etaRaids: usable && perRaidOk ? Math.ceil(remaining / pace.perRaid!) : reached ? 0 : null,
    n: pace.n,
    lowConfidence: lowConfidence(pace.n),
    note,
  };
}

// ---------------------------------------------------------------------------
// Metric readers
// ---------------------------------------------------------------------------

/** Cumulative net worth per day, from the net-worth estimate. */
function netWorthGains(nw: NetWorthEstimate): DatedGain[] {
  return nw.points.map((p) => ({ day: p.day, cumulative: p.estimatedNetWorth }));
}

/** Current level (meta.level) + a level-over-time series from the calibrations log. */
function levelReadings(db: DatabaseSync): { current: number; points: DatedGain[] } {
  const metaLevel = db.prepare(`SELECT value FROM meta WHERE key = 'level'`).get() as
    | { value: string }
    | undefined;
  const current = metaLevel ? Number(metaLevel.value) : 1;

  const rows = db
    .prepare(`SELECT value, ts FROM calibrations WHERE kind = 'level' ORDER BY ts, id`)
    .all() as { value: number; ts: string }[];
  // Keep the highest level seen on each day (levels only go up within a wipe).
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const day = dayOf(r.ts);
    if (day === null) continue;
    byDay.set(day, Math.max(byDay.get(day) ?? -Infinity, Number(r.value)));
  }
  const points: DatedGain[] = [...byDay.keys()]
    .sort()
    .map((day) => ({ day, cumulative: byDay.get(day)! }));
  return { current: Number.isFinite(current) ? current : 1, points };
}

/** Cumulative distinct completed-task count per day, from the quest_events log. */
function taskCompletionReadings(db: DatabaseSync): { current: number; points: DatedGain[] } {
  const rows = db
    .prepare(`SELECT task_id, ts FROM quest_events WHERE status = 'completed' ORDER BY ts, id`)
    .all() as { task_id: string; ts: string }[];
  const firstCompletionDay = new Map<string, string>();
  for (const r of rows) {
    const day = dayOf(r.ts);
    if (day === null) continue;
    if (!firstCompletionDay.has(r.task_id)) firstCompletionDay.set(r.task_id, day);
  }
  const perDay = new Map<string, number>();
  for (const day of firstCompletionDay.values()) perDay.set(day, (perDay.get(day) ?? 0) + 1);
  const points: DatedGain[] = [];
  let cumulative = 0;
  for (const day of [...perDay.keys()].sort()) {
    cumulative += perDay.get(day)!;
    points.push({ day, cumulative });
  }
  // Prefer the persisted task_state stock for "current" (it also counts tasks
  // completed before the earliest journaled quest event / via backfill).
  const stateCount = db.prepare(`SELECT COUNT(*) AS c FROM task_state WHERE complete = 1`).get() as {
    c: number;
  };
  const current = Math.max(Number(stateCount.c), firstCompletionDay.size);
  return { current, points };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface NetWorthGoalOptions {
  goal?: GoalSpec | null;
  /** Net-worth heuristic config (startingRubles / dailySpendRubles). */
  netWorthConfig?: unknown;
  /** Trailing pace window in days (default 14). */
  paceWindowDays?: number;
}

/** The days on which raids happened (for the per-raid pace denominator). */
function raidDays(db: DatabaseSync): string[] {
  const out: string[] = [];
  for (const r of loadRaids(db)) {
    const day = dayOf(raidTs(r));
    if (day !== null) out.push(day);
  }
  return out;
}

export function netWorthGoal(db: DatabaseSync, options: NetWorthGoalOptions = {}): NetWorthGoalReport {
  const windowDays = options.paceWindowDays ?? DEFAULT_PACE_WINDOW_DAYS;
  const nw = netWorthEstimate(db, options.netWorthConfig ?? {});
  const series = nw.points;
  const currentEstimate = series.length > 0 ? series[series.length - 1]!.estimatedNetWorth : 0;
  const rDays = raidDays(db);

  let goal: GoalProjection | null = null;
  if (options.goal) {
    switch (options.goal.kind) {
      case "rubles": {
        const pace = measurePace(netWorthGains(nw), rDays, windowDays, "flea income / day");
        goal = project(
          "rubles",
          options.goal.target,
          currentEstimate,
          pace,
          "ETA to a rouble net-worth target from recent flea-income pace. Net worth is the M7.2 estimate (flea income only) — trader sales, loot, and spending are invisible, so this is directional.",
        );
        break;
      }
      case "level": {
        const { current, points } = levelReadings(db);
        const pace = measurePace(points, rDays, windowDays, "levels / day (calibrations log)");
        goal = project(
          "level",
          options.goal.target,
          current,
          pace,
          "ETA to a player level from the level-over-time pace in the calibrations log. Needs >=2 dated level readings to project.",
        );
        break;
      }
      case "tasks": {
        const { current, points } = taskCompletionReadings(db);
        const pace = measurePace(points, rDays, windowDays, "task completions / day");
        goal = project(
          "tasks",
          options.goal.target,
          current,
          pace,
          "ETA to a task-count milestone (e.g. Kappa's 257) from recent completion pace. Counts all completed tasks, not only goal-required ones, so it is an upper-bound-friendly estimate.",
        );
        break;
      }
    }
  }

  return {
    series,
    currentEstimate: round4(currentEstimate),
    netWorth: nw,
    goal,
    lowConfidence: nw.lowConfidence,
  };
}
