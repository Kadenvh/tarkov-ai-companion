/**
 * Tonight's Plan view-model builder (M5.2) — pure functions that merge the
 * planner Plan, its per-raid foresight warnings, and the quartermaster
 * AcquisitionPlan into raid-card display structs. No React, fully unit-tested.
 */

import type {
  AcquisitionItem,
  AcquisitionPlan,
  ForesightWarning,
  PlanResponse,
  PlannedRaid,
  PlannedRaidTask,
} from "../api/types";

export interface RaidCardVM {
  index: number;
  /** raw plan map key (id or "any") */
  mapKey: string;
  mapName: string;
  fillerOnly: boolean;
  tasks: PlannedRaidTask[];
  levelBefore: number;
  levelAfter: number;
  levelUps: number;
  score: number;
  warnings: ForesightWarning[];
  /** quartermaster items to have ready before this raid */
  prep: AcquisitionItem[];
}

export interface PlanVM {
  raids: RaidCardVM[];
  freeTasks: { id: string; name: string }[];
  levelStalls: { taskId: string; name: string; requiredLevel: number }[];
  goalTaskCount: number;
  remainingGoalTasks: number;
  reachedLevel: number;
  hash: string | null;
}

/** Which raid (1-based) an acquisition item must be ready for. */
export function neededByRaid(item: AcquisitionItem): number {
  if (item.route.kind === "find-in-raid" && typeof item.route.raidIndex === "number") {
    return item.route.raidIndex;
  }
  for (const reason of item.reasons) {
    const m = /^needed-by:raid-(\d+)$/.exec(reason);
    if (m) return Number(m[1]);
  }
  return 1;
}

/**
 * Attach foresight warnings to a raid. Prefers warnings the service embedded
 * on the raid itself; falls back to plan-level warnings matched by the
 * completing task being in this raid's batch (or keyed by raid index).
 */
export function warningsForRaid(
  raid: PlannedRaid,
  planWarnings: PlanResponse["warnings"],
): ForesightWarning[] {
  if (raid.warnings && raid.warnings.length > 0) return raid.warnings;
  if (!planWarnings) return [];
  if (Array.isArray(planWarnings)) {
    const batchIds = new Set(raid.tasks.map((t) => t.id));
    return planWarnings.filter((w) => w.completing && batchIds.has(w.completing.id));
  }
  return planWarnings[String(raid.index)] ?? [];
}

/** Human consequence line for a warning ("completing X fails Y (Kappa)"). */
export function warningText(warning: ForesightWarning): string {
  if (warning.consequence) return warning.consequence;
  if (warning.message) return warning.message;
  const completing = warning.completing?.name ?? "this task";
  const fails = (warning.fails ?? [])
    .map((f) => {
      const tags = [f.kappaRequired ? "Kappa" : null, f.lightkeeperRequired ? "Lightkeeper" : null]
        .filter(Boolean)
        .join(", ");
      return tags ? `${f.name} (${tags})` : f.name;
    })
    .join(", ");
  if (!fails) return `Completing ${completing} is irreversible.`;
  return `Completing ${completing} permanently fails: ${fails}`;
}

export function buildPlanVM(
  plan: PlanResponse | null | undefined,
  quartermaster: AcquisitionPlan | null | undefined,
  mapName: (key: string) => string = (k) => k,
): PlanVM | null {
  if (!plan || !Array.isArray(plan.raids)) return null;

  // bucket quartermaster items by the raid they must be ready for
  const prepByRaid = new Map<number, AcquisitionItem[]>();
  for (const item of quartermaster?.items ?? []) {
    const raid = neededByRaid(item);
    const bucket = prepByRaid.get(raid) ?? [];
    bucket.push(item);
    prepByRaid.set(raid, bucket);
  }

  const raids: RaidCardVM[] = plan.raids.map((raid) => ({
    index: raid.index,
    mapKey: raid.map,
    mapName: mapName(raid.map),
    fillerOnly: raid.map === "any",
    tasks: raid.tasks,
    levelBefore: raid.levelBefore,
    levelAfter: raid.levelAfter,
    levelUps: Math.max(0, raid.levelAfter - raid.levelBefore),
    score: raid.score,
    warnings: warningsForRaid(raid, plan.warnings),
    prep: prepByRaid.get(raid.index) ?? [],
  }));

  return {
    raids,
    freeTasks: plan.freeTasksCompleted ?? [],
    levelStalls: plan.levelStalls ?? [],
    goalTaskCount: plan.goalTaskCount ?? 0,
    remainingGoalTasks: plan.remainingGoalTasks ?? 0,
    reachedLevel: plan.reachedLevel ?? 0,
    hash: plan.hash ?? null,
  };
}
