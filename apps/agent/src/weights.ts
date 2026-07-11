import { z } from "zod";
import { PlannerWeightsSchema, type PlannerWeights } from "./types.js";

/**
 * Learned weights (M4.5): a PURE, deterministic function from the playstyle
 * fingerprint (@tac/insights via GET /api/insights/fingerprint), the current
 * planner weights, and recent journal outcomes (GET /api/insights/raids
 * byMap rows) to a PROPOSED weights delta with a human-readable rationale per
 * change. Never auto-applied — surfaced via GET /propose-weights and only
 * written when the user confirms (CONTRACTS §8).
 * @tier T0
 */

export const MAP_COST_MIN = 0.5;
export const MAP_COST_MAX = 3;
/** minimum recent raids on a map before we propose touching its cost */
export const MIN_MAP_SAMPLE = 3;
/** minimum total raids before global (non-map) adjustments */
export const MIN_GLOBAL_SAMPLE = 5;

export const FingerprintSchema = z.object({
  features: z.record(z.string(), z.number()),
  sampleSizes: z.object({
    raids: z.number(),
    decidedRaids: z.number(),
    questEvents: z.number(),
    sessions: z.number(),
  }),
  lowConfidence: z.boolean(),
});
export type FingerprintLike = z.infer<typeof FingerprintSchema>;

/** One journal-derived per-map outcome row (shape of insights survivalByMap). */
export const MapOutcomeSchema = z.object({
  map: z.string(),
  n: z.number(),
  survived: z.number(),
  died: z.number(),
  unknown: z.number(),
  /** raids the player quit/abandoned mid-plan, when the caller tracks them */
  abandoned: z.number().optional(),
});
export type MapOutcomeRow = z.infer<typeof MapOutcomeSchema>;

export interface WeightChange {
  key: string;
  from: number;
  to: number;
  rationale: string;
}

export interface WeightsProposal {
  proposed: PlannerWeights;
  changes: WeightChange[];
  /** true when nothing had enough sample to justify a change */
  noChange: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** stable feature-key slug, mirroring @tac/insights mapSlug */
export function mapSlug(map: string): string {
  return map.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

export function proposeWeights(input: {
  fingerprint: FingerprintLike;
  weights: PlannerWeights;
  mapOutcomes: MapOutcomeRow[];
}): WeightsProposal {
  const fingerprint = FingerprintSchema.parse(input.fingerprint);
  const current = PlannerWeightsSchema.parse(input.weights);
  const rows = z.array(MapOutcomeSchema).parse(input.mapOutcomes);

  const proposed: PlannerWeights = { ...current, mapCost: { ...current.mapCost } };
  const changes: WeightChange[] = [];

  // --- per-map aversion / preference (sorted for determinism) ---
  for (const row of [...rows].sort((a, b) => a.map.localeCompare(b.map))) {
    if (row.map === "(unknown)" || row.n < MIN_MAP_SAMPLE) continue;
    const abandoned = row.abandoned ?? 0;
    const bad = row.died + abandoned;
    const badRate = bad / row.n;
    const key = mapSlug(row.map);
    const from = proposed.mapCost[key] ?? 1;

    if (badRate >= 0.5) {
      // repeated deaths/abandons -> raise the cost of planning this map
      const to = round2(clamp(from * (1 + 0.5 * badRate), MAP_COST_MIN, MAP_COST_MAX));
      if (to !== from) {
        proposed.mapCost[key] = to;
        changes.push({
          key: `mapCost.${key}`,
          from,
          to,
          rationale: `You died or abandoned ${bad} of your last ${row.n} raids on ${row.map} (${Math.round(badRate * 100)}%) — raising its planning cost so batches route elsewhere first.`,
        });
      }
    } else if (badRate <= 0.2 && row.survived >= 2) {
      const share = fingerprint.features[`map_share_${key}`] ?? 0;
      if (share >= 0.25) {
        // strong revealed preference with good outcomes -> mild preference
        const to = round2(clamp(from * 0.85, MAP_COST_MIN, MAP_COST_MAX));
        if (to !== from) {
          proposed.mapCost[key] = to;
          changes.push({
            key: `mapCost.${key}`,
            from,
            to,
            rationale: `${Math.round(share * 100)}% of your recent raids are on ${row.map} and you survive there (${row.survived}/${row.n}) — lowering its cost to lean into a map you clearly like.`,
          });
        }
      }
    }
  }

  // --- global task/xp balance from the fingerprint ---
  if (!fingerprint.lowConfidence && fingerprint.sampleSizes.raids >= MIN_GLOBAL_SAMPLE) {
    const focus = fingerprint.features["task_focus_ratio"] ?? 0;
    if (focus >= 2) {
      const from = proposed.task;
      const to = round2(clamp(from * 1.2, 0.5, 2));
      if (to !== from) {
        proposed.task = to;
        changes.push({
          key: "task",
          from,
          to,
          rationale: `Your journal shows task-focused play (${focus} quest events per raid) — weighting task completion up.`,
        });
      }
    } else if (focus > 0 && focus <= 0.5) {
      const from = proposed.xp;
      const to = round2(clamp(from * 1.2, 0.05, 0.5));
      if (to !== from) {
        proposed.xp = to;
        changes.push({
          key: "xp",
          from,
          to,
          rationale: `Few quest events per raid (${focus}) suggests loot/XP-focused play — weighting raw XP up slightly.`,
        });
      }
    }
  }

  return { proposed, changes, noChange: changes.length === 0 };
}
