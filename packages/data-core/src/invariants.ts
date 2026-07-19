import type { GameMode } from "@tac/shared";
import type { LoadedWorld } from "./load.js";
import { validateGraph } from "./graph.js";

/**
 * M1.6 / M8.2 structural invariant checks over a loaded task graph.
 *
 * These are the "does the world still make sense" guards the patch-drift
 * sentinel runs when a new EFT version appears: they never assert a specific
 * headcount (those SHIFT every patch — that's what the diff surfaces), only
 * that the graph is internally sound. Counts are reported for the diff to turn
 * into deltas.
 *
 * @tier T0 — pure analysis of committed snapshot data; never touches the game.
 */

/**
 * Canonical M1.6 baseline counts for the 1.0.6 line (SPEC P0 exit criterion),
 * verified against the live API + kappaquests.com on 2026-07-11. Exported so
 * the invariant tests and drift reports can reference one source of truth.
 */
export const INVARIANT_BASELINE = {
  taskCount: 510,
  kappaCount: 257,
  lightkeeperCount: 102,
} as const;

export interface InvariantReport {
  version: string;
  mode: GameMode;
  taskCount: number;
  kappaCount: number;
  lightkeeperCount: number;
  /** tasks reachable only by FAILING a prerequisite (branch-only unlocks) */
  branchOnlyCount: number;
  /** number of mutually-exclusive branch sets (fail-condition components) */
  exclusivitySetCount: number;
  acyclic: boolean;
  /** task ids left in a cycle when progression edges are non-acyclic (else null) */
  cycle: string[] | null;
  danglingRequirementRefs: { from: string; to: string }[];
  /** human-readable list of HARD-invariant violations (structural soundness only) */
  broken: string[];
  ok: boolean;
}

/** Run the structural invariant checks over a loaded world. */
export function checkInvariants(world: LoadedWorld): InvariantReport {
  const graph = world.graph;
  const tasks = Object.values(graph.tasks);
  const issues = validateGraph(graph);

  // exclusivity set count: undirected components of the fail-relation graph
  const exclusivitySetCount = countExclusivitySets(graph.fails);

  const broken: string[] = [];
  if (issues.cycle) broken.push(`task graph has a cycle (${issues.cycle.length} task(s) involved)`);
  if (issues.danglingRequirementRefs.length > 0) {
    broken.push(`${issues.danglingRequirementRefs.length} dangling requirement reference(s)`);
  }
  if (tasks.length === 0) broken.push("no tasks loaded");

  return {
    version: world.ref.version,
    mode: world.mode,
    taskCount: tasks.length,
    kappaCount: tasks.filter((t) => t.kappaRequired).length,
    lightkeeperCount: tasks.filter((t) => t.lightkeeperRequired).length,
    branchOnlyCount: graph.branchOnly.size,
    exclusivitySetCount,
    acyclic: issues.cycle === null,
    cycle: issues.cycle,
    danglingRequirementRefs: issues.danglingRequirementRefs,
    broken,
    ok: broken.length === 0,
  };
}

/** Count connected components (size > 1) in the undirected closure of the fail relation. */
function countExclusivitySets(fails: Map<string, string[]>): number {
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)!).add(b);
    (adjacency.get(b) ?? adjacency.set(b, new Set()).get(b)!).add(a);
  };
  for (const [failed, becauseOf] of fails) for (const winner of becauseOf) link(failed, winner);

  const seen = new Set<string>();
  let count = 0;
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    let size = 0;
    const queue = [start];
    while (queue.length) {
      const node = queue.pop()!;
      if (seen.has(node)) continue;
      seen.add(node);
      size++;
      for (const next of adjacency.get(node) ?? []) queue.push(next);
    }
    if (size > 1) count++;
  }
  return count;
}
