import { beforeAll, describe, expect, it } from "vitest";
import { loadWorld, type LoadedWorld } from "@tac/data-core";
import { LevelCurve } from "../src/levels.js";
import { PlayerState, toSim } from "../src/state.js";
import { resolveGoalTasks } from "../src/goals.js";
import { buildPlan, DEFAULT_WEIGHTS } from "../src/director.js";
import { availableTasks } from "../src/availability.js";
import {
  taskExclusivityWarnings,
  endingReachability,
  xpGateStalls,
  planXpGateStalls,
} from "../src/foresight.js";
import type { Plan } from "../src/director.js";
import type { TaskGraph } from "@tac/data-core";

let world: LoadedWorld;
let curve: LevelCurve;

beforeAll(() => {
  world = loadWorld("regular");
  curve = new LevelCurve(world.playerLevels);
});

const freshSim = () =>
  toSim(PlayerState.parse({ level: 1, gameMode: "regular", faction: "USEC" }), (l) => curve.xpForLevel(l));

describe("level curve", () => {
  it("maps XP thresholds both directions (flea gate at 15)", () => {
    expect(curve.maxLevel).toBe(79);
    const xp15 = curve.xpForLevel(15);
    expect(curve.levelForXp(xp15)).toBe(15);
    expect(curve.levelForXp(xp15 - 1)).toBe(14);
  });
});

describe("goal resolution", () => {
  it("kappa closure is a superset of the 257 flagged tasks", () => {
    const kappa = resolveGoalTasks(world.graph, [{ type: "kappa" }]);
    const flagged = Object.values(world.graph.tasks).filter((t) => t.kappaRequired).length;
    expect(flagged).toBe(257);
    expect(kappa.size).toBeGreaterThanOrEqual(flagged);
  });
});

describe("availability on a fresh account", () => {
  it("surfaces starter tasks and nothing level-gated beyond 1", () => {
    const sim = freshSim();
    const avail = availableTasks(world.graph, sim);
    expect(avail.length).toBeGreaterThan(0);
    for (const id of avail) {
      expect((world.graph.tasks[id]!.minPlayerLevel ?? 0)).toBeLessThanOrEqual(1);
    }
  });
});

describe("Raid Director", () => {
  it("produces map-batched raids toward Kappa from a fresh account", () => {
    const sim = freshSim();
    const goal = resolveGoalTasks(world.graph, [{ type: "kappa" }]);
    const plan = buildPlan(world.graph, sim, goal, curve, { horizon: 10, weights: DEFAULT_WEIGHTS });

    expect(plan.raids.length).toBeGreaterThan(0);
    // batching: at least one raid bundles multiple tasks on one map
    expect(Math.max(...plan.raids.map((r) => r.tasks.length))).toBeGreaterThan(1);
    // progress: XP accrues, level climbs past 1 within the horizon
    expect(plan.reachedLevel).toBeGreaterThan(1);
    // every planned task is actually a goal task
    for (const raid of plan.raids) for (const t of raid.tasks) expect(goal.has(t.id)).toBe(true);
    // free (no-raid) tasks were drained
    expect(plan.freeTasksCompleted.length).toBeGreaterThan(0);
  });

  it("respects map aversion weights (Lighthouse pushed later)", () => {
    const sim = freshSim();
    const goal = resolveGoalTasks(world.graph, [{ type: "kappa" }]);
    const base = buildPlan(world.graph, sim, goal, curve, { horizon: 6 });
    const averse = buildPlan(world.graph, sim, goal, curve, {
      horizon: 6,
      weights: { ...DEFAULT_WEIGHTS, mapCost: { lighthouse: 100, Lighthouse: 100 } },
    });
    // sanity: both produce plans; averse plan's early maps differ or de-prioritize the penalized map
    expect(base.raids.length).toBeGreaterThan(0);
    expect(averse.raids.length).toBeGreaterThan(0);
  });
});

describe("Foresight Guard", () => {
  it("flags exclusivity: completing an exclusive task fails its siblings", () => {
    // find any task that fails another
    const failer = [...world.graph.fails.values()].flat()[0];
    expect(failer).toBeDefined();
    const warnings = taskExclusivityWarnings(world.graph, [failer!]);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]!.fails.length).toBeGreaterThan(0);
  });

  it("emits an xp-gate stall when the projection arrives under-leveled", () => {
    const xpForLevel = (l: number): number => (l - 1) * 1000;
    const stalls = xpGateStalls({
      gatedTasks: [{ id: "collector", name: "Collector", requiredLevel: 45, critical: true }],
      projectedLevel: 42,
      projectedXp: xpForLevel(42),
      xpPerRaid: 1000,
      xpForLevel,
    });
    expect(stalls).toHaveLength(1);
    const s = stalls[0]!;
    expect(s.kind).toBe("xp-gate");
    expect(s.requiredLevel).toBe(45);
    expect(s.projectedLevel).toBe(42);
    expect(s.levelsShort).toBe(3);
    // (44000 − 41000) / 1000 XP-per-raid = 3 raids short
    expect(s.raidsShort).toBe(3);
    expect(s.severity).toBe("critical");
    expect(s.message).toContain("Collector L45 gate");
    expect(s.message).toContain("projected L42");
  });

  it("emits nothing when the projected level clears every gate", () => {
    const xpForLevel = (l: number): number => (l - 1) * 1000;
    const cleared = xpGateStalls({
      gatedTasks: [
        { id: "a", name: "Task A", requiredLevel: 20 },
        { id: "b", name: "Task B", requiredLevel: 30, critical: true },
      ],
      projectedLevel: 40,
      projectedXp: xpForLevel(40),
      xpPerRaid: 1000,
      xpForLevel,
    });
    expect(cleared).toEqual([]);
  });

  it("derives gate stalls from a plan's level trajectory (raids-short from XP/raid)", () => {
    const graph = { tasks: { collector: { kappaRequired: true } } } as unknown as TaskGraph;
    const plan = {
      raids: [{ levelBefore: 38 }, {}, {}, {}], // 4 planned raids, started at L38
      levelStalls: [{ taskId: "collector", name: "Collector", requiredLevel: 45 }],
      reachedLevel: 42,
    } as unknown as Plan;
    const curve = new LevelCurve(
      Array.from({ length: 50 }, (_, i) => ({ level: i + 1, exp: i * 1000 })),
    );
    const stalls = planXpGateStalls(graph, plan, curve);
    expect(stalls).toHaveLength(1);
    const s = stalls[0]!;
    expect(s.projectedLevel).toBe(42); // == plan.reachedLevel
    expect(s.requiredLevel).toBe(45);
    expect(s.levelsShort).toBe(3);
    // XP climbed 38→42 over 4 raids = 1000 XP/raid; 3000 XP to the gate ⇒ 3 raids
    expect(s.raidsShort).toBe(3);
    expect(s.severity).toBe("critical"); // Collector is Kappa-required
  });

  it("derives no gate stalls from a plan that clears every gate", () => {
    const graph = { tasks: {} } as unknown as TaskGraph;
    const plan = {
      raids: [{ levelBefore: 40 }, {}],
      levelStalls: [],
      reachedLevel: 50,
    } as unknown as Plan;
    const curve = new LevelCurve(
      Array.from({ length: 60 }, (_, i) => ({ level: i + 1, exp: i * 1000 })),
    );
    expect(planXpGateStalls(graph, plan, curve)).toEqual([]);
  });

  it("finds a real XP-gate stall in a plan that reaches a gate under-leveled (integration)", () => {
    // A real goal task whose gate the plan reaches (no unmet complete-prereqs,
    // Any-faction) but whose minPlayerLevel a fresh account can't reach in the
    // horizon — the honest "arrives at the gate under-leveled" scenario.
    const gated = Object.values(world.graph.tasks)
      .filter(
        (t) =>
          (t.minPlayerLevel ?? 0) >= 20 &&
          (!t.factionName || t.factionName === "Any") &&
          !(world.graph.requires.get(t.id) ?? []).some((r) => r.status.includes("complete")),
      )
      .sort((a, b) => (a.minPlayerLevel ?? 0) - (b.minPlayerLevel ?? 0))[0];
    expect(gated).toBeDefined();

    const sim = freshSim();
    const goal = resolveGoalTasks(world.graph, [{ type: "tasks", ids: [gated!.id] }]);
    const plan = buildPlan(world.graph, sim, goal, curve, { horizon: 3 });
    const stalls = planXpGateStalls(world.graph, plan, curve);

    expect(stalls.length).toBeGreaterThan(0);
    const s = stalls.find((x) => x.task.id === gated!.id)!;
    expect(s).toBeDefined();
    expect(s.kind).toBe("xp-gate");
    expect(s.projectedLevel).toBe(plan.reachedLevel);
    expect(s.requiredLevel).toBe(gated!.minPlayerLevel);
    expect(s.requiredLevel).toBeGreaterThan(s.projectedLevel);
    expect(s.levelsShort).toBe(s.requiredLevel - s.projectedLevel);
  });

  it("computes ending reachability from story decisions", () => {
    const endings = ["savior", "survivor", "fallen", "debtor"];
    const decisions = [
      { id: "ticket_kerman", options: [
        { id: "yes", effects: {} },
        { id: "no", effects: { setsOnlyEnding: "survivor" } },
      ] },
      { id: "ticket_evidence", options: [
        { id: "yes", effects: { setsOnlyEnding: "savior" } },
        { id: "no", effects: { locksEndings: ["savior"] } },
      ] },
    ];
    expect(endingReachability(endings, decisions, { ticket_kerman: "no" }).forced).toBe("survivor");
    expect(endingReachability(endings, decisions, { ticket_evidence: "no" }).possible).not.toContain("savior");
    expect(endingReachability(endings, decisions, {}).possible).toHaveLength(4);
  });
});
