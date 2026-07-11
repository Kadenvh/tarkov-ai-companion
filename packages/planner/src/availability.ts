import type { Task } from "@tac/data-core";
import type { TaskGraph } from "@tac/data-core";
import type { SimState } from "./state.js";

/**
 * Availability semantics (M3.2). A task is doable NOW given sim state when:
 *  - not already completed or failed
 *  - player level >= minPlayerLevel
 *  - faction matches (factionName "Any" or the player's side)
 *  - not locked out (no task that FAILS it has been completed)
 *  - every taskRequirement is satisfied per its status set
 *
 * `failed`-only requirements make a task branch-only: reachable solely by
 * failing the prerequisite. `active` requirements (rare, parallel unlocks) are
 * approximated as "prereq completed OR its own hard prereqs are met".
 */

export function isLockedOut(graph: TaskGraph, sim: SimState, taskId: string): boolean {
  for (const failer of graph.fails.get(taskId) ?? []) {
    if (sim.completed.has(failer)) return true;
  }
  return false;
}

function hardPrereqsMet(graph: TaskGraph, sim: SimState, taskId: string): boolean {
  const reqs = graph.requires.get(taskId) ?? [];
  return reqs
    .filter((r) => r.status.includes("complete"))
    .every((r) => sim.completed.has(r.task));
}

function requirementSatisfied(
  graph: TaskGraph,
  sim: SimState,
  req: { task: string; status: string[] },
): boolean {
  const wantsComplete = req.status.includes("complete");
  const wantsFailed = req.status.includes("failed");
  const wantsActive = req.status.includes("active");

  if (wantsComplete && sim.completed.has(req.task)) return true;
  if (wantsFailed && sim.failed.has(req.task)) return true;
  if (wantsActive && (sim.completed.has(req.task) || hardPrereqsMet(graph, sim, req.task))) return true;
  return false;
}

export function factionAllows(task: Task, sim: SimState): boolean {
  const f = task.factionName;
  if (!f || f === "Any") return true;
  return f === sim.faction;
}

export function isAvailable(graph: TaskGraph, sim: SimState, taskId: string): boolean {
  const task = graph.tasks[taskId];
  if (!task) return false;
  if (sim.completed.has(taskId) || sim.failed.has(taskId)) return false;
  if ((task.minPlayerLevel ?? 0) > sim.level) return false;
  if (!factionAllows(task, sim)) return false;
  if (isLockedOut(graph, sim, taskId)) return false;
  return task.taskRequirements.every((r) => requirementSatisfied(graph, sim, r));
}

/** All tasks doable now, optionally restricted to a candidate set (e.g. goal closure). */
export function availableTasks(graph: TaskGraph, sim: SimState, within?: Set<string>): string[] {
  const source = within ?? new Set(Object.keys(graph.tasks));
  return [...source].filter((id) => isAvailable(graph, sim, id));
}

/** Would this task become available if `sim.level` were high enough? (level is the only blocker) */
export function blockedOnlyByLevel(graph: TaskGraph, sim: SimState, taskId: string): boolean {
  const task = graph.tasks[taskId];
  if (!task) return false;
  if (isAvailable(graph, sim, taskId)) return false;
  if ((task.minPlayerLevel ?? 0) <= sim.level) return false;
  const raised: SimState = { ...sim, level: task.minPlayerLevel ?? sim.level };
  return isAvailable(graph, raised, taskId);
}
