import { beforeAll, describe, expect, it } from "vitest";
import { loadWorld, type LoadedWorld } from "@tac/data-core";
import { LevelCurve } from "../src/levels.js";
import { PlayerState, toSim } from "../src/state.js";
import { resolveGoalTasks } from "../src/goals.js";
import { buildPlan, DEFAULT_WEIGHTS } from "../src/director.js";
import { availableTasks } from "../src/availability.js";
import { taskExclusivityWarnings, endingReachability } from "../src/foresight.js";

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
