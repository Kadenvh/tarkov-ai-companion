import { beforeAll, describe, expect, it } from "vitest";
import { latestSnapshot, loadRaw, loadStrings, tr } from "../src/snapshot.js";
import { parseTasks, type Task } from "../src/tasks.js";
import { buildTaskGraph, exclusivitySets, validateGraph, type TaskGraph } from "../src/graph.js";

/**
 * M1.6 invariants against the committed snapshot (SPEC P0 exit criterion).
 * Counts verified against live API + independent sources (kappaquests.com) on 2026-07-11.
 */

let tasks: Record<string, Task>;
let graph: TaskGraph;
let strings: Record<string, string>;
const byName = (name: string) =>
  Object.values(tasks).find((t) => tr(strings, t.name) === name);

beforeAll(() => {
  const ref = latestSnapshot();
  tasks = parseTasks(loadRaw(ref, "regular", "tasks"));
  strings = loadStrings(ref, "regular", "tasks");
  graph = buildTaskGraph(tasks);
});

describe("task graph invariants (1.0.6 snapshot)", () => {
  it("has 510 tasks", () => {
    expect(Object.keys(tasks)).toHaveLength(510);
  });

  it("has 257 kappa-required tasks", () => {
    expect(Object.values(tasks).filter((t) => t.kappaRequired)).toHaveLength(257);
  });

  it("has 102 lightkeeper-required tasks", () => {
    expect(Object.values(tasks).filter((t) => t.lightkeeperRequired)).toHaveLength(102);
  });

  it("progression edges are acyclic and requirement refs resolve", () => {
    const issues = validateGraph(graph);
    expect(issues.cycle).toBeNull();
    expect(issues.danglingRequirementRefs).toEqual([]);
  });

  it("every task name resolves through the string table", () => {
    const unresolved = Object.values(tasks).filter((t) => tr(strings, t.name) === t.name);
    expect(unresolved).toEqual([]);
  });

  it("models the Chemical Part 4 mutually-exclusive branch triad", () => {
    const chem4 = byName("Chemical - Part 4");
    const bigCustomer = byName("Big Customer");
    const outOfCuriosity = byName("Out of Curiosity");
    expect(chem4 && bigCustomer && outOfCuriosity).toBeTruthy();
    const sets = exclusivitySets(graph);
    const triad = sets.find((s) => s.includes(chem4!.id));
    expect(triad).toBeDefined();
    expect(triad).toContain(bigCustomer!.id);
    expect(triad).toContain(outOfCuriosity!.id);
  });

  it("finds branch-only tasks (unlocked by FAILING a prereq)", () => {
    expect(graph.branchOnly.size).toBeGreaterThan(0);
    for (const id of graph.branchOnly) {
      const reqs = graph.requires.get(id)!;
      expect(reqs.some((r) => r.status.length === 1 && r.status[0] === "failed")).toBe(true);
    }
  });

  it("PvE mode parses and differs only slightly in count", () => {
    const ref = latestSnapshot();
    const pve = parseTasks(loadRaw(ref, "pve", "tasks"));
    const count = Object.keys(pve).length;
    expect(count).toBeGreaterThan(490);
    expect(count).toBeLessThanOrEqual(510);
  });
});
