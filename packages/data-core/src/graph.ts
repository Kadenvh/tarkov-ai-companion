import type { Task } from "./tasks.js";

/**
 * Task dependency graph (M1.6).
 *
 * Edge semantics from taskRequirements[].status:
 *  - ["complete"]            -> hard prerequisite (progression edge)
 *  - ["complete","failed"]   -> "resolved either way" (still a progression edge)
 *  - ["failed"]              -> branch-only unlock (NOT a progression edge:
 *                               reachable only by failing the target)
 *  - ["active"]              -> parallel-availability edge
 *
 * Exclusivity: failConditions objectives of type "taskStatus" mean completing
 * one task fails another — mutually exclusive branch sets.
 */

export interface TaskGraph {
  tasks: Record<string, Task>;
  /** prereq task id -> dependent task ids (progression edges only) */
  unlocks: Map<string, string[]>;
  /** task id -> prereq requirements (all statuses, verbatim) */
  requires: Map<string, { task: string; status: string[] }[]>;
  /** task id -> set of task ids it FAILS when completed/started per failConditions */
  fails: Map<string, string[]>;
  /** task ids requiring a `failed` prereq somewhere (branch-only tasks) */
  branchOnly: Set<string>;
}

export function buildTaskGraph(tasks: Record<string, Task>): TaskGraph {
  const unlocks = new Map<string, string[]>();
  const requires = new Map<string, { task: string; status: string[] }[]>();
  const fails = new Map<string, string[]>();
  const branchOnly = new Set<string>();

  for (const task of Object.values(tasks)) {
    requires.set(task.id, task.taskRequirements.map((r) => ({ task: r.task, status: r.status })));

    for (const req of task.taskRequirements) {
      if (!tasks[req.task]) continue; // dangling refs tolerated, surfaced by validateGraph
      if (req.status.includes("complete") || req.status.includes("active")) {
        const list = unlocks.get(req.task) ?? [];
        list.push(task.id);
        unlocks.set(req.task, list);
      }
      if (req.status.length === 1 && req.status[0] === "failed") branchOnly.add(task.id);
    }

    for (const fc of task.failConditions ?? []) {
      if (fc.type === "taskStatus" && fc.task) {
        const list = fails.get(fc.task) ?? [];
        list.push(task.id);
        fails.set(fc.task, list);
      }
    }
  }

  return { tasks, unlocks, requires, fails, branchOnly };
}

/** Mutually-exclusive sets: groups of tasks connected by fail relations (undirected closure). */
export function exclusivitySets(graph: TaskGraph): string[][] {
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)!).add(b);
    (adjacency.get(b) ?? adjacency.set(b, new Set()).get(b)!).add(a);
  };
  for (const [failed, becauseOf] of graph.fails) {
    for (const winner of becauseOf) link(failed, winner);
  }
  const seen = new Set<string>();
  const sets: string[][] = [];
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    const component: string[] = [];
    const queue = [start];
    while (queue.length) {
      const node = queue.pop()!;
      if (seen.has(node)) continue;
      seen.add(node);
      component.push(node);
      for (const next of adjacency.get(node) ?? []) queue.push(next);
    }
    if (component.length > 1) sets.push(component.sort());
  }
  return sets;
}

export interface GraphIssues {
  danglingRequirementRefs: { from: string; to: string }[];
  cycle: string[] | null;
}

/** Structural validation: dangling refs + acyclicity of progression edges (Kahn). */
export function validateGraph(graph: TaskGraph): GraphIssues {
  const dangling: { from: string; to: string }[] = [];
  for (const [id, reqs] of graph.requires) {
    for (const r of reqs) if (!graph.tasks[r.task]) dangling.push({ from: id, to: r.task });
  }

  const indegree = new Map<string, number>();
  for (const id of Object.keys(graph.tasks)) indegree.set(id, 0);
  for (const [, dependents] of graph.unlocks) {
    for (const dep of dependents) indegree.set(dep, (indegree.get(dep) ?? 0) + 1);
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const dep of graph.unlocks.get(id) ?? []) {
      const d = indegree.get(dep)! - 1;
      indegree.set(dep, d);
      if (d === 0) queue.push(dep);
    }
  }
  const cycle =
    visited === Object.keys(graph.tasks).length
      ? null
      : [...indegree.entries()].filter(([, d]) => d > 0).map(([id]) => id);

  return { danglingRequirementRefs: dangling, cycle };
}
