/**
 * Demo: print a Kappa plan for a given starting level. Usage: tsx demo.ts [level]
 * Not a product surface — a quick way to eyeball the solver.
 */
import { loadWorld } from "@tac/data-core";
import { LevelCurve } from "../levels.js";
import { PlayerState, toSim } from "../state.js";
import { resolveGoalTasks } from "../goals.js";
import { buildPlan } from "../director.js";

const level = Number(process.argv[2] ?? 1);
const world = loadWorld("regular");
const curve = new LevelCurve(world.playerLevels);
const sim = toSim(PlayerState.parse({ level, faction: "USEC" }), (l) => curve.xpForLevel(l));
const goal = resolveGoalTasks(world.graph, [{ type: "kappa" }]);
const plan = buildPlan(world.graph, sim, goal, curve, { horizon: 8 });

console.log(`\nKAPPA PLAN — start level ${level} · goal closure ${plan.goalTaskCount} tasks\n`);
console.log(`Free (no-raid) hand-ins drained first: ${plan.freeTasksCompleted.length}`);
for (const raid of plan.raids) {
  const mapLabel = raid.map === "any" ? "Any map" : world.mapName(raid.map);
  console.log(`\n▶ Raid ${raid.index} — ${mapLabel}  (lvl ${raid.levelBefore}→${raid.levelAfter}, score ${raid.score})`);
  for (const t of raid.tasks) {
    const tag = t.anyMap ? " (any-map)" : "";
    console.log(`    • ${t.name}${tag}${t.reasons.length ? "  [" + t.reasons.join(", ") + "]" : ""}`);
  }
}
console.log(`\nReached level ${plan.reachedLevel} · ${plan.remainingGoalTasks} goal tasks remain`);
if (plan.levelStalls.length) {
  console.log(`\nNext level gates:`);
  for (const s of plan.levelStalls.slice(0, 5)) console.log(`    lvl ${s.requiredLevel}: ${s.name}`);
}
