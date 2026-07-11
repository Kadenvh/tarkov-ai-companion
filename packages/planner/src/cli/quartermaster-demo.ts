/**
 * Demo: print the Quartermaster shopping list for a Kappa plan at a given
 * starting level. Usage: tsx quartermaster-demo.ts [level]
 * Not a product surface — a quick way to eyeball the acquisition planner.
 */
import { loadWorld, loadMarket } from "@tac/data-core";
import { LevelCurve } from "../levels.js";
import { PlayerState, toSim } from "../state.js";
import { resolveGoalTasks } from "../goals.js";
import { buildPlan } from "../director.js";
import { buildAcquisitionPlan } from "../quartermaster.js";

const level = Number(process.argv[2] ?? 15);
const world = loadWorld("regular");
const market = loadMarket("regular", world.ref);
const curve = new LevelCurve(world.playerLevels);
const state = PlayerState.parse({ level, faction: "USEC" });
const sim = toSim(state, (l) => curve.xpForLevel(l));
const goal = resolveGoalTasks(world.graph, [{ type: "kappa" }]);
const plan = buildPlan(world.graph, sim, goal, curve, { horizon: 5 });

const acq = buildAcquisitionPlan(world.graph, market, plan, state, {
  raids: 5,
  mapName: (id) => world.mapName(id),
});

console.log(`\nQUARTERMASTER — level ${level} · next ${acq.raids} raids · ${acq.items.length} items`);
console.log(`Estimated spend: ${acq.totalRubles.toLocaleString("en-US")} ₽\n`);

for (const item of acq.items) {
  const fir = item.fir ? " [FIR]" : "";
  console.log(`▶ ${item.count}× ${item.name}${fir}`);
  console.log(`    ${item.route.kind.toUpperCase()} — ${item.route.detail}`);
  if (item.route.totalCost != null) console.log(`    total ~${item.route.totalCost.toLocaleString("en-US")} ₽`);
  console.log(`    for: ${item.forTasks.map((t) => t.name).join(", ")}`);
  if (item.alternatives.length > 0) {
    const alt = item.alternatives[0]!;
    console.log(`    alt: ${alt.kind} — ${alt.detail}`);
  }
  console.log(`    why: ${item.reasons.join(" · ")}`);
}

if (acq.craftSchedule.length > 0) {
  console.log(`\nCRAFT SCHEDULE`);
  for (const c of acq.craftSchedule) {
    console.log(`    ${c.startBy}: start ${c.itemId} at ${c.station} (${c.minutes} min)`);
  }
}
