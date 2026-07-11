import type { TaskGraph } from "@tac/data-core";

export type Goal =
  | { type: "kappa" }
  | { type: "lightkeeper" }
  | { type: "level"; level: number }
  | { type: "tasks"; ids: string[] };

/** Target tasks named directly by a goal (before prerequisite closure). */
function targetTasks(graph: TaskGraph, goal: Goal): string[] {
  switch (goal.type) {
    case "kappa":
      return Object.values(graph.tasks).filter((t) => t.kappaRequired).map((t) => t.id);
    case "lightkeeper":
      return Object.values(graph.tasks).filter((t) => t.lightkeeperRequired).map((t) => t.id);
    case "tasks":
      return goal.ids.filter((id) => graph.tasks[id]);
    case "level":
      return []; // level goals are satisfied by XP accrual, not a task set
  }
}

/** Walk `complete`/`failed` prerequisite edges to collect the full closure of a target set. */
export function prerequisiteClosure(graph: TaskGraph, targets: Iterable<string>): Set<string> {
  const closure = new Set<string>();
  const stack = [...targets];
  while (stack.length) {
    const id = stack.pop()!;
    if (closure.has(id)) continue;
    closure.add(id);
    for (const req of graph.requires.get(id) ?? []) {
      if (graph.tasks[req.task] && !closure.has(req.task)) stack.push(req.task);
    }
  }
  return closure;
}

/** The union goal task set (targets + all prerequisites) across multiple goals. */
export function resolveGoalTasks(graph: TaskGraph, goals: Goal[]): Set<string> {
  const targets = goals.flatMap((g) => targetTasks(graph, g));
  return prerequisiteClosure(graph, targets);
}

export function maxLevelGoal(goals: Goal[]): number {
  return Math.max(0, ...goals.filter((g): g is { type: "level"; level: number } => g.type === "level").map((g) => g.level));
}
