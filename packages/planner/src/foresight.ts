import type { TaskGraph } from "@tac/data-core";
import { exclusivitySets } from "@tac/data-core";
import type { LevelCurve } from "./levels.js";
import type { Plan } from "./director.js";

/**
 * Foresight Guard (M3.4) — irreversibility & stall warnings. Three sources:
 *  1. Task exclusivity from failConditions: completing X permanently fails Y.
 *  2. Story decisions (from the curated story dataset) that lock endings.
 *  3. XP-gate stalls (M3.4b): the planned raid sequence arrives at a
 *     level-gated goal under-leveled — the route stalls at the gate.
 *
 * This is pure planning value nobody ships: "don't take this task yet — it
 * voids a task you still need" / "your XP curve won't clear the Collector gate
 * in time." TarkovTracker structurally can't do (3): its level is manual, with
 * no projection.
 */

export type ForesightSeverity = "info" | "warning" | "critical";

export interface ExclusivityWarning {
  kind: "task-exclusivity";
  completing: { id: string; name: string };
  fails: { id: string; name: string; kappaRequired: boolean; lightkeeperRequired: boolean }[];
  severity: ForesightSeverity;
}

/**
 * XP-gate-stall finding (M3.4b). The planner projects the player's level across
 * the planned horizon; when a level-gated goal / critical-path task has all its
 * non-level prerequisites met but the projected level falls short of its
 * `minPlayerLevel`, the route stalls at that gate. Deterministic + injectable.
 */
export interface XpGateStall {
  kind: "xp-gate";
  task: { id: string; name: string };
  /** the task's `minPlayerLevel` gate. */
  requiredLevel: number;
  /** player level projected by the XP sim when the plan reaches the gate. */
  projectedLevel: number;
  /** requiredLevel − projectedLevel (always ≥ 1 for an emitted finding). */
  levelsShort: number;
  /** raids still needed at the plan's XP/raid pace, or null when unknown. */
  raidsShort: number | null;
  severity: ForesightSeverity;
  message: string;
}

/** Union of everything `GET /api/foresight` may surface (single warning channel). */
export type ForesightFinding = ExclusivityWarning | XpGateStall;

export interface XpGateStallInput {
  /**
   * Level-gated goal / critical-path tasks the plan has otherwise reached
   * (prerequisites met, only the level gate outstanding). `critical` escalates
   * severity (Kappa/Lightkeeper-required).
   */
  gatedTasks: { id: string; name: string; requiredLevel: number; critical?: boolean }[];
  /** Player level projected at the end of the planned horizon. */
  projectedLevel: number;
  /** Cumulative XP projected at the end of the planned horizon. */
  projectedXp: number;
  /** Average XP gained per planned raid; ≤ 0 / omitted → `raidsShort` is null. */
  xpPerRaid?: number;
  /** Cumulative-XP-for-level lookup (`LevelCurve.xpForLevel`). */
  xpForLevel: (level: number) => number;
}

/**
 * Pure gate-stall detector. Emits one finding per gated task the projection
 * fails to clear, worst gap first. Fully injectable so it unit-tests without
 * loading the world graph or running the solver.
 */
export function xpGateStalls(input: XpGateStallInput): XpGateStall[] {
  const findings: XpGateStall[] = [];
  for (const t of input.gatedTasks) {
    if (input.projectedLevel >= t.requiredLevel) continue; // gate clears — no stall
    const levelsShort = t.requiredLevel - input.projectedLevel;
    const xpNeeded = input.xpForLevel(t.requiredLevel) - input.projectedXp;
    const raidsShort =
      input.xpPerRaid !== undefined && input.xpPerRaid > 0 && xpNeeded > 0
        ? Math.ceil(xpNeeded / input.xpPerRaid)
        : null;
    const raidsPart =
      raidsShort !== null ? ` / ~${raidsShort} more raid${raidsShort === 1 ? "" : "s"}` : "";
    findings.push({
      kind: "xp-gate",
      task: { id: t.id, name: t.name },
      requiredLevel: t.requiredLevel,
      projectedLevel: input.projectedLevel,
      levelsShort,
      raidsShort,
      severity: t.critical ? "critical" : "warning",
      message:
        `Route stalls at the ${t.name} L${t.requiredLevel} gate — projected ` +
        `L${input.projectedLevel} after the planned raids, ~${levelsShort} ` +
        `level${levelsShort === 1 ? "" : "s"}${raidsPart} short.`,
    });
  }
  return findings.sort(
    (a, b) => b.levelsShort - a.levelsShort || a.requiredLevel - b.requiredLevel,
  );
}

/**
 * Derive gate-stall findings from a built `Plan`. The plan's `levelStalls` are
 * exactly the goal tasks that became blocked ONLY by level (prereqs cleared) —
 * i.e. the tasks the route reaches under-leveled. Projection inputs come from
 * the plan's level trajectory: XP/raid is inferred from the level climb over
 * the planned raids against the curve.
 *
 * NOTE: the `Plan` exposes `reachedLevel` (and per-raid `levelBefore/After`)
 * but not the raw final XP, so we floor `projectedXp` at the curve threshold of
 * the reached level. That makes `raidsShort` a slight over-estimate (never
 * under-promises how far the player still has to grind) — deterministic and
 * honest given the sim's public surface.
 */
export function planXpGateStalls(graph: TaskGraph, plan: Plan, curve: LevelCurve): XpGateStall[] {
  const projectedLevel = plan.reachedLevel;
  const projectedXp = curve.xpForLevel(projectedLevel);
  const startLevel = plan.raids.length > 0 ? plan.raids[0]!.levelBefore : projectedLevel;
  const xpPerRaid =
    plan.raids.length > 0
      ? (projectedXp - curve.xpForLevel(startLevel)) / plan.raids.length
      : 0;

  const gatedTasks = plan.levelStalls.map((s) => {
    const task = graph.tasks[s.taskId];
    return {
      id: s.taskId,
      name: s.name,
      requiredLevel: s.requiredLevel,
      critical: Boolean(task?.kappaRequired || task?.lightkeeperRequired),
    };
  });

  return xpGateStalls({
    gatedTasks,
    projectedLevel,
    projectedXp,
    xpPerRaid,
    xpForLevel: (l) => curve.xpForLevel(l),
  });
}

/**
 * Given the tasks the player intends to complete, warn where completing one
 * fails another — escalating to `critical` when the failed task is in the goal
 * set or is Kappa/Lightkeeper-required.
 */
export function taskExclusivityWarnings(
  graph: TaskGraph,
  intendedTaskIds: Iterable<string>,
  goalSet?: Set<string>,
): ExclusivityWarning[] {
  const intended = new Set(intendedTaskIds);
  const warnings: ExclusivityWarning[] = [];

  for (const id of intended) {
    const failedIds = graph.fails.get(id) ?? [];
    if (failedIds.length === 0) continue;
    const fails = failedIds
      .filter((f) => graph.tasks[f])
      .map((f) => {
        const t = graph.tasks[f]!;
        return {
          id: f,
          name: t.name,
          kappaRequired: Boolean(t.kappaRequired),
          lightkeeperRequired: Boolean(t.lightkeeperRequired),
        };
      });
    if (fails.length === 0) continue;

    const hitsGoal = fails.some((f) => goalSet?.has(f.id) || f.kappaRequired || f.lightkeeperRequired);
    warnings.push({
      kind: "task-exclusivity",
      completing: { id, name: graph.tasks[id]!.name },
      fails,
      severity: hitsGoal ? "critical" : "warning",
    });
  }
  return warnings;
}

/** All mutually-exclusive task groups in the graph (for surfacing branch decisions up front). */
export function allExclusiveBranches(graph: TaskGraph): { id: string; name: string }[][] {
  return exclusivitySets(graph).map((set) =>
    set.map((id) => ({ id, name: graph.tasks[id]?.name ?? id })),
  );
}

// --- Story ending foresight (operates on the curated story dataset) ---

export interface EndingReachability {
  possible: string[];
  locked: { ending: string; byDecision: string; option: string }[];
  forced: string | null;
}

interface StoryDecisionLike {
  id: string;
  options: { id: string; effects: { locksEndings?: string[]; setsOnlyEnding?: string } }[];
}

/**
 * Given the player's made decisions (decisionId -> optionId) and the story
 * dataset's decisions + ending ids, compute which endings remain reachable.
 */
export function endingReachability(
  allEndings: string[],
  decisions: StoryDecisionLike[],
  made: Record<string, string>,
): EndingReachability {
  let possible = new Set(allEndings);
  const locked: { ending: string; byDecision: string; option: string }[] = [];
  let forced: string | null = null;

  for (const decision of decisions) {
    const chosen = made[decision.id];
    if (!chosen) continue;
    const option = decision.options.find((o) => o.id === chosen);
    if (!option) continue;
    if (option.effects.setsOnlyEnding) {
      forced = option.effects.setsOnlyEnding;
      for (const e of [...possible]) {
        if (e !== forced) {
          possible.delete(e);
          locked.push({ ending: e, byDecision: decision.id, option: chosen });
        }
      }
    }
    for (const e of option.effects.locksEndings ?? []) {
      if (possible.delete(e)) locked.push({ ending: e, byDecision: decision.id, option: chosen });
    }
  }

  return { possible: [...possible], locked, forced };
}
