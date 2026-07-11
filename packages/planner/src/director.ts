import type { TaskGraph, Task } from "@tac/data-core";
import type { LevelCurve } from "./levels.js";
import type { SimState } from "./state.js";
import { availableTasks, blockedOnlyByLevel } from "./availability.js";

/**
 * Raid Director (M3.2) — greedy + criticality solver that produces per-raid
 * task batches, not a flat sorted list. Nobody in the ecosystem ships this.
 *
 * Task classes (from objective types, since `map: null` != "no raid"):
 *   - free    : no in-raid objective (trader hand-ins, gunsmith, skill/rep) -> drained between raids
 *   - anyMap  : in-raid objective but no pinned map (kill/find "any location") -> fold into any raid as fillers
 *   - pinned  : in-raid objective on a specific map -> the batch anchor
 *
 * Each iteration: drain free tasks (they cascade unlocks), then pick the map
 * whose (pinned batch + best anyMap fillers) maximizes value/cost, simulate
 * completing it (XP -> level -> new unlocks), repeat over a rolling horizon.
 */

const IN_RAID_OBJECTIVE_TYPES = new Set([
  "visit", "shoot", "extract", "findQuestItem", "findItem",
  "plantItem", "plantQuestItem", "mark", "useItem",
]);

export function requiresRaid(task: Task): boolean {
  return task.objectives.some((o) => IN_RAID_OBJECTIVE_TYPES.has(o.type));
}

export interface PlannerWeights {
  task: number;
  xp: number;
  criticality: number;
  /** map id OR normalizedName -> cost multiplier (>1 aversion, <1 preference) */
  mapCost: Record<string, number>;
}

export const DEFAULT_WEIGHTS: PlannerWeights = { task: 1, xp: 0.15, criticality: 0.4, mapCost: {} };

export interface PlannedRaid {
  index: number;
  map: string; // map id, or "any" for a filler-only raid
  tasks: { id: string; name: string; anyMap: boolean; reasons: string[] }[];
  levelBefore: number;
  levelAfter: number;
  score: number;
}

export interface Plan {
  raids: PlannedRaid[];
  freeTasksCompleted: { id: string; name: string }[];
  goalTaskCount: number;
  remainingGoalTasks: number;
  levelStalls: { taskId: string; name: string; requiredLevel: number }[];
  reachedLevel: number;
}

const RAID_OVERHEAD = 1;
const MAX_BATCH = 8;
const ANY = "any";

function xpOf(task: Task): number {
  return typeof task.experience === "number" ? task.experience : 0;
}

/** For each goal task, how many goal tasks lie downstream via progression edges (memoized). */
function computeCriticality(graph: TaskGraph, goalSet: Set<string>): Map<string, number> {
  const memo = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const downstream = (id: string): Set<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return new Set();
    visiting.add(id);
    const acc = new Set<string>();
    for (const next of graph.unlocks.get(id) ?? []) {
      if (goalSet.has(next)) acc.add(next);
      for (const d of downstream(next)) acc.add(d);
    }
    visiting.delete(id);
    memo.set(id, acc);
    return acc;
  };
  const out = new Map<string, number>();
  for (const id of goalSet) out.set(id, downstream(id).size);
  return out;
}

export function buildPlan(
  graph: TaskGraph,
  startSim: SimState,
  goalSet: Set<string>,
  curve: LevelCurve,
  opts: { horizon?: number; weights?: PlannerWeights } = {},
): Plan {
  const horizon = opts.horizon ?? 10;
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const criticality = computeCriticality(graph, goalSet);

  const sim: SimState = {
    ...startSim,
    completed: new Set(startSim.completed),
    failed: new Set(startSim.failed),
  };

  const raids: PlannedRaid[] = [];
  const freeTasksCompleted: { id: string; name: string }[] = [];

  const taskValue = (id: string): number => {
    const t = graph.tasks[id]!;
    return weights.task + weights.xp * (xpOf(t) / 1000) + weights.criticality * (criticality.get(id) ?? 0);
  };

  const mapCost = (mapId: string): number => RAID_OVERHEAD * (weights.mapCost[mapId] ?? 1);

  const completeTask = (id: string): void => {
    sim.completed.add(id);
    sim.xp += xpOf(graph.tasks[id]!);
    for (const failed of graph.fails.get(id) ?? []) if (!sim.completed.has(failed)) sim.failed.add(failed);
    sim.level = curve.levelForXp(sim.xp);
  };

  const reasonsFor = (id: string): string[] => {
    const t = graph.tasks[id]!;
    const crit = criticality.get(id) ?? 0;
    const r: string[] = [];
    if (t.kappaRequired) r.push("Kappa-required");
    if (t.lightkeeperRequired) r.push("Lightkeeper-required");
    if (crit > 0) r.push(`unlocks ${crit} goal task${crit === 1 ? "" : "s"}`);
    if (xpOf(t) >= 10000) r.push(`${Math.round(xpOf(t) / 1000)}k XP`);
    return r;
  };

  const drainFreeTasks = (): void => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of availableTasks(graph, sim, goalSet)) {
        if (!requiresRaid(graph.tasks[id]!)) {
          completeTask(id);
          freeTasksCompleted.push({ id, name: graph.tasks[id]!.name });
          changed = true;
        }
      }
    }
  };

  for (let i = 0; i < horizon; i++) {
    drainFreeTasks();

    const availRaid = availableTasks(graph, sim, goalSet).filter((id) => requiresRaid(graph.tasks[id]!));
    if (availRaid.length === 0) break;

    const anyMap = availRaid.filter((id) => !graph.tasks[id]!.map).sort((a, b) => taskValue(b) - taskValue(a));
    const pinnedByMap = new Map<string, string[]>();
    for (const id of availRaid) {
      const m = graph.tasks[id]!.map;
      if (m) (pinnedByMap.get(m) ?? pinnedByMap.set(m, []).get(m)!).push(id);
    }

    // Candidate raids: one per map that has pinned tasks (fillers from anyMap), plus a
    // filler-only "any" raid when anyMap tasks exist. Batch capped at MAX_BATCH by value.
    let best: { map: string; batch: string[]; score: number } | null = null;
    const consider = (map: string, pinned: string[]): void => {
      const ranked = [...pinned].sort((a, b) => taskValue(b) - taskValue(a));
      const batch = [...ranked, ...anyMap].slice(0, MAX_BATCH);
      const value = batch.reduce((s, id) => s + taskValue(id), 0);
      const score = value / mapCost(map);
      if (!best || score > best.score) best = { map, batch, score };
    };
    for (const [m, pinned] of pinnedByMap) consider(m, pinned);
    if (pinnedByMap.size === 0 && anyMap.length > 0) consider(ANY, []);
    if (!best) break;

    // TS control-flow can't see `best` is assigned inside the closure; assert non-null.
    const chosen: { map: string; batch: string[]; score: number } = best;
    const levelBefore = sim.level;
    const tasksOut = chosen.batch.map((id) => ({
      id,
      name: graph.tasks[id]!.name,
      anyMap: !graph.tasks[id]!.map,
      reasons: reasonsFor(id),
    }));
    for (const id of chosen.batch) completeTask(id);

    raids.push({
      index: i + 1,
      map: chosen.map,
      tasks: tasksOut,
      levelBefore,
      levelAfter: sim.level,
      score: Number(chosen.score.toFixed(3)),
    });
  }

  drainFreeTasks();

  const levelStalls = [...goalSet]
    .filter((id) => blockedOnlyByLevel(graph, sim, id))
    .map((id) => ({ taskId: id, name: graph.tasks[id]!.name, requiredLevel: graph.tasks[id]!.minPlayerLevel ?? 0 }))
    .sort((a, b) => a.requiredLevel - b.requiredLevel);

  return {
    raids,
    freeTasksCompleted,
    goalTaskCount: goalSet.size,
    remainingGoalTasks: [...goalSet].filter((id) => !sim.completed.has(id)).length,
    levelStalls,
    reachedLevel: sim.level,
  };
}
