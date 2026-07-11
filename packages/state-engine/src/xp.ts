import type { LoadedWorld } from "@tac/data-core";
import type { ProfileStore } from "./store.js";
import type { RaidOutcome } from "./events.js";

/**
 * XP / level estimator (SPEC M2.5).
 *
 * The logs never contain XP or PMC level (research/03 §2), so the estimate is
 * layered:
 *   1. anchor      — the latest calibration point (exact XP, or a level whose
 *                    threshold XP we take), else `xpOffset` meta from level 0.
 *   2. task XP     — sum of the data-known XP rewards of tasks completed after
 *                    the anchor (exact, from the task graph).
 *   3. raid bumps  — HEURISTIC per-raid estimates by outcome (configurable,
 *                    deliberately conservative). This is the uncertain layer;
 *                    the confidence interval widens with every un-calibrated
 *                    raid and snaps shut when the user calibrates.
 *
 * Calibration points (M2.6 manual/OCR capture writes them) re-anchor the
 * estimate: only contributions AFTER the newest calibration are added.
 */

export interface XpSource {
  /** XP reward for a completed task (null when unknown to the dataset) */
  taskXp(taskId: string): number | null;
  /** cumulative XP thresholds, tarkov.dev `playerLevels` shape */
  levels: { level: number; exp: number }[];
}

/** Adapt a data-core LoadedWorld into an XpSource. */
export function worldXpSource(world: LoadedWorld): XpSource {
  return {
    taskXp: (taskId) => world.graph.tasks[taskId]?.experience ?? null,
    levels: world.playerLevels,
  };
}

/**
 * Per-raid XP heuristics. These are documented guesses, not data: a survived
 * mid-game raid lands very roughly 10–20k XP, a quick death much less. Tune
 * per player via options; calibration makes them irrelevant.
 */
export interface RaidXpHeuristics {
  survived: number;
  died: number;
  unknown: number;
  /** fraction of the raid-bump total treated as uncertainty (± band) */
  uncertainty: number;
}

export const DEFAULT_RAID_XP: RaidXpHeuristics = {
  survived: 12000,
  died: 3500,
  unknown: 6500,
  uncertainty: 0.75,
};

export interface XpEstimate {
  level: number;
  xp: number;
  confidence: { low: number; high: number };
}

export type CalibrationKind = "level" | "xp";

/** Record a calibration point (exact level or exact XP at a moment in time). */
export function addCalibration(store: ProfileStore, kind: CalibrationKind, value: number, ts?: string): void {
  store.db
    .prepare("INSERT INTO calibrations (kind, value, ts) VALUES (?, ?, ?)")
    .run(kind, value, ts ?? new Date().toISOString());
  store.events.emit("state.changed", { reason: "calibration", ts: new Date().toISOString() });
}

function xpForLevel(levels: XpSource["levels"], level: number): number {
  const sorted = [...levels].sort((a, b) => a.level - b.level);
  const clamped = Math.max(1, Math.min(level, sorted.at(-1)?.level ?? 1));
  return sorted[clamped - 1]?.exp ?? 0;
}

function levelForXp(levels: XpSource["levels"], xp: number): number {
  let level = 1;
  for (const row of [...levels].sort((a, b) => a.level - b.level)) {
    if (xp >= row.exp) level = row.level;
    else break;
  }
  return level;
}

interface CalibrationRow {
  kind: string;
  value: number;
  ts: string;
}

export function estimateXp(
  store: ProfileStore,
  source: XpSource,
  heuristics: Partial<RaidXpHeuristics> = {},
): XpEstimate {
  const heur = { ...DEFAULT_RAID_XP, ...heuristics };

  const calibration = store.db
    .prepare("SELECT kind, value, ts FROM calibrations ORDER BY ts DESC, id DESC LIMIT 1")
    .get() as CalibrationRow | undefined;

  let anchorXp: number;
  let anchorTs: string | null;
  if (calibration) {
    anchorXp = calibration.kind === "level" ? xpForLevel(source.levels, calibration.value) : calibration.value;
    anchorTs = calibration.ts;
  } else {
    anchorXp = store.xpOffset;
    anchorTs = null;
  }

  // exact layer: task completion XP after the anchor
  let taskXp = 0;
  for (const t of store.getTasks()) {
    if (!t.complete) continue;
    if (anchorTs !== null && (t.ts === null || t.ts <= anchorTs)) continue; // inside the anchor
    taskXp += source.taskXp(t.taskId) ?? 0;
  }

  // heuristic layer: raid-outcome bumps after the anchor
  const raids = store.db
    .prepare(
      "SELECT outcome, COALESCE(ended_at, started_at) AS at FROM raids WHERE COALESCE(ended_at, started_at) IS NOT NULL",
    )
    .all() as { outcome: RaidOutcome; at: string }[];
  let raidXp = 0;
  for (const r of raids) {
    if (anchorTs !== null && r.at <= anchorTs) continue;
    raidXp += heur[r.outcome] ?? heur.unknown;
  }

  const xp = Math.max(0, Math.round(anchorXp + taskXp + raidXp));
  const spread = Math.round(heur.uncertainty * raidXp);
  const low = Math.max(0, xp - spread);
  const high = xp + spread;

  return { level: levelForXp(source.levels, xp), xp, confidence: { low, high } };
}

/** Level view of an estimate's confidence band (handy for UIs). */
export function estimateLevelBand(estimate: XpEstimate, source: XpSource): { low: number; high: number } {
  return {
    low: levelForXp(source.levels, estimate.confidence.low),
    high: levelForXp(source.levels, estimate.confidence.high),
  };
}
