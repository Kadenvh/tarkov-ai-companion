/**
 * M7.3 — Playstyle fingerprint: a documented, deterministic feature vector
 * describing how this player actually plays. Feeds the M4.5 learned-weights
 * pipeline (apps/agent), which proposes PlannerWeights deltas from it.
 *
 * Guarantees:
 * - Deterministic: same DB contents → byte-identical JSON (features are
 *   rounded to 4 decimals and keys are emitted in sorted order).
 * - Inspectable: every feature key has a matching human-readable explanation
 *   under the same key in `explanations`.
 * - Honest: sample sizes are attached and `lowConfidence` is true when the
 *   raid count is below 5.
 *
 * @tier T0 — pure computation over the app-owned profile DB.
 */

import type { DatabaseSync } from "node:sqlite";
import { hourOf, lowConfidence, median, round4 } from "./util.js";
import { loadRaids, raidTs, sessionRhythm, DEFAULT_SESSION_GAP_MIN } from "./raids.js";

export interface FingerprintOptions {
  /** Session grouping gap threshold (minutes); default 90 — see raids.ts. */
  sessionGapMinutes?: number;
}

export interface PlaystyleFingerprint {
  /** Feature name -> numeric value; keys sorted; values rounded to 4 decimals. */
  features: Record<string, number>;
  /** Exactly the same keys as `features`; human-readable definition of each. */
  explanations: Record<string, string>;
  sampleSizes: {
    raids: number;
    /** Raids with a survived/died outcome (survival_rate denominator). */
    decidedRaids: number;
    questEvents: number;
    sessions: number;
  };
  lowConfidence: boolean;
}

/** Map name -> stable feature-key slug: lowercase, non-alphanumerics collapsed to "_". */
export function mapSlug(map: string): string {
  return map.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

const NIGHT_HOURS = new Set([22, 23, 0, 1, 2, 3, 4, 5]);

export function playstyleFingerprint(
  db: DatabaseSync,
  options: FingerprintOptions = {},
): PlaystyleFingerprint {
  const raids = loadRaids(db);
  const rhythm = sessionRhythm(db, { gapMinutes: options.sessionGapMinutes ?? DEFAULT_SESSION_GAP_MIN });
  const questEvents = Number(
    (db.prepare(`SELECT COUNT(*) AS c FROM quest_events`).get() as Record<string, unknown>)["c"],
  );

  const survived = raids.filter((r) => r.outcome === "survived").length;
  const died = raids.filter((r) => r.outcome === "died").length;
  const decided = survived + died;

  const durations = raids.map((r) => r.durationSec).filter((d): d is number => d != null);
  const sessionLengths = rhythm.sessions.map((s) => s.lengthMin);

  // Schedule pattern: modal start hour + share of raids started at night.
  const hourCounts = new Map<number, number>();
  let timedRaids = 0;
  let nightRaids = 0;
  for (const r of raids) {
    const hour = hourOf(raidTs(r));
    if (hour === null) continue;
    timedRaids++;
    hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1);
    if (NIGHT_HOURS.has(hour)) nightRaids++;
  }
  let peakHour = 0;
  let peakCount = -1;
  for (const hour of [...hourCounts.keys()].sort((a, b) => a - b)) {
    const count = hourCounts.get(hour)!;
    if (count > peakCount) {
      peakHour = hour;
      peakCount = count;
    }
  }

  const features: Record<string, number> = {};
  const explanations: Record<string, string> = {};
  const add = (key: string, value: number, explanation: string): void => {
    features[key] = round4(value);
    explanations[key] = explanation;
  };

  // Map preference distribution — one feature per map seen.
  const byMap = new Map<string, number>();
  for (const r of raids) {
    const slug = mapSlug(r.map ?? "(unknown)");
    byMap.set(slug, (byMap.get(slug) ?? 0) + 1);
  }
  for (const slug of [...byMap.keys()].sort()) {
    add(
      `map_share_${slug}`,
      raids.length === 0 ? 0 : byMap.get(slug)! / raids.length,
      `Share of all journaled raids played on ${slug} (0-1). High values are revealed map preference; feeds PlannerWeights.mapCost.`,
    );
  }

  add(
    "survival_rate",
    decided === 0 ? 0 : survived / decided,
    "survived / (survived + died) across all journaled raids; unknown outcomes excluded from the denominator. 0 when no outcome is decided yet.",
  );
  add(
    "median_raid_duration_sec",
    median(durations) ?? 0,
    "Median in-raid duration in seconds (duration_sec column; queue/load time excluded). Proxy for pace: low = rusher/task-rat, high = slow looter. 0 when no durations are recorded.",
  );
  add(
    "raids_per_session",
    rhythm.summary.raidsPerSession.mean ?? 0,
    `Mean raids per play session (sessions split on gaps > ${rhythm.summary.gapMinutes} min). Informs how many raids a plan horizon should cover.`,
  );
  add(
    "session_length_median_min",
    median(sessionLengths) ?? 0,
    "Median session length in minutes (first raid start to last raid end). Informs session-length planner weights.",
  );
  add(
    "task_focus_ratio",
    raids.length === 0 ? 0 : questEvents / raids.length,
    "quest_events rows per journaled raid. High = task-focused play, low = loot/PvP-focused; informs task-vs-XP weighting.",
  );
  add(
    "peak_hour",
    peakHour,
    "Modal wall-clock start hour (0-23) across journaled raids; ties resolve to the earliest hour. 0 when no raid has a parseable timestamp.",
  );
  add(
    "night_owl_share",
    timedRaids === 0 ? 0 : nightRaids / timedRaids,
    "Share of raids started between 22:00 and 05:59 wall-clock. Schedule pattern signal for briefing/plan timing.",
  );

  // Emit with sorted keys so JSON.stringify output is deterministic.
  const sortedFeatures: Record<string, number> = {};
  const sortedExplanations: Record<string, string> = {};
  for (const key of Object.keys(features).sort()) {
    sortedFeatures[key] = features[key]!;
    sortedExplanations[key] = explanations[key]!;
  }

  return {
    features: sortedFeatures,
    explanations: sortedExplanations,
    sampleSizes: {
      raids: raids.length,
      decidedRaids: decided,
      questEvents,
      sessions: rhythm.summary.sessionCount,
    },
    lowConfidence: lowConfidence(raids.length),
  };
}
