import type { TaskGraph } from "@tac/data-core";
import { exclusivitySets } from "@tac/data-core";

/**
 * Foresight Guard (M3.4) — irreversibility warnings. Two sources:
 *  1. Task exclusivity from failConditions: completing X permanently fails Y.
 *  2. Story decisions (from the curated story dataset) that lock endings.
 *
 * This is pure planning value nobody ships: "don't take this task yet — it
 * voids a task you still need."
 */

export interface ExclusivityWarning {
  kind: "task-exclusivity";
  completing: { id: string; name: string };
  fails: { id: string; name: string; kappaRequired: boolean; lightkeeperRequired: boolean }[];
  severity: "info" | "warning" | "critical";
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
