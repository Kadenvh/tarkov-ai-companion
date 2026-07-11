import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  buildAcquisitionPlan,
  endingReachability,
  resolveGoalTasks,
  taskExclusivityWarnings,
  PlayerState,
  type QuartermasterOptions,
} from "@tac/planner";
import { DEFAULT_HORIZON, MAX_HORIZON, GoalSchema, WeightsSchema, goalsOf, weightsOf } from "../plan.js";
import { decisionsForReachability, storyProgressOf } from "./core.js";
import type { ServiceRuntime } from "../runtime.js";

/** CONTRACTS §5.2 — planning routes. */

const GoalsBody = z.object({
  goals: z.array(GoalSchema).min(1),
  weights: WeightsSchema.optional(),
});

const intQuery = (raw: unknown, fallback: number, max: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : fallback;
};

export function registerPlanningRoutes(app: FastifyInstance, rt: ServiceRuntime): void {
  app.get("/api/goals", async () => ({
    goals: goalsOf(rt.store),
    weights: weightsOf(rt.store),
    isDefault: rt.store.getGoals() === null,
  }));

  app.post("/api/goals", async (req, reply) => {
    const body = GoalsBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0]?.message ?? "invalid body" });
    rt.store.setGoals(body.data.goals);
    if (body.data.weights) rt.store.setWeights(body.data.weights);
    // setGoals/setWeights emit state.changed -> debounced replan + plan.updated broadcast
    return { ok: true, goals: goalsOf(rt.store), weights: weightsOf(rt.store) };
  });

  app.get("/api/plan", async (req) => {
    const horizon = intQuery((req.query as Record<string, unknown>)["horizon"], DEFAULT_HORIZON, MAX_HORIZON);
    return rt.planner.get(horizon);
  });

  app.get("/api/quartermaster", async (req) => {
    const raids = intQuery((req.query as Record<string, unknown>)["raids"], 5, MAX_HORIZON);
    const world = rt.world();
    const bundle = rt.planner.get(DEFAULT_HORIZON);
    const state = PlayerState.parse(rt.store.toPlayerState());
    const hideout = rt.store.getHideout();
    const opts: QuartermasterOptions = {
      raids,
      mapName: world.mapName,
      ...(hideout.length > 0
        ? { hideoutLevels: Object.fromEntries(hideout.map((h) => [h.stationId, h.level])) }
        : {}),
    };
    return buildAcquisitionPlan(world.graph, rt.market(), bundle.plan, state, opts);
  });

  app.get("/api/foresight", async () => {
    const world = rt.world();
    const goals = goalsOf(rt.store);
    const goalSet = resolveGoalTasks(world.graph, goals);
    const state = rt.store.toPlayerState();
    const done = new Set([...state.completedTasks, ...state.failedTasks]);
    const pending = [...goalSet].filter((id) => !done.has(id));
    const warnings = taskExclusivityWarnings(world.graph, pending, goalSet);

    const dataset = rt.story();
    const progress = storyProgressOf(rt.store);
    const story = dataset
      ? {
          endings: endingReachability(
            dataset.endings.map((e) => e.id),
            decisionsForReachability(dataset),
            progress.decisions,
          ),
          pendingDecisions: dataset.decisions
            .filter((d) => !progress.decisions[d.id])
            .map((d) => ({ id: d.id, chapter: d.chapter, question: d.question, options: d.options })),
        }
      : null;

    return { goals, pendingGoalTasks: pending.length, warnings, story };
  });
}
