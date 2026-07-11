import { createHash } from "node:crypto";
import { z } from "zod";
import type { LoadedWorld } from "@tac/data-core";
import {
  buildPlan,
  resolveGoalTasks,
  taskExclusivityWarnings,
  toSim,
  LevelCurve,
  PlayerState,
  DEFAULT_WEIGHTS,
  type ExclusivityWarning,
  type Goal,
  type Plan,
  type PlannerWeights,
} from "@tac/planner";
import type { ProfileStore } from "@tac/state-engine";

/**
 * Plan pipeline (M3.2 service wiring): store.toPlayerState() →
 * resolveGoalTasks(goals from meta) → buildPlan(horizon, weights) → attach
 * per-raid foresight warnings + a content hash. Cached per horizon; the cache
 * is invalidated on `state.changed` and rebuilt after a ~1.5 s debounce,
 * broadcasting `plan.updated` when the plan content actually changed.
 */

export const DEFAULT_HORIZON = 10;
export const MAX_HORIZON = 25;
export const DEFAULT_GOALS: Goal[] = [{ type: "kappa" }];
export const PLAN_DEBOUNCE_MS = 1500;

// zod boundaries for the meta-persisted planner inputs (CONTRACTS §5.2 POST /api/goals)
export const GoalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("kappa") }),
  z.object({ type: z.literal("lightkeeper") }),
  z.object({ type: z.literal("level"), level: z.number().int().min(1).max(79) }),
  z.object({ type: z.literal("tasks"), ids: z.array(z.string()).min(1) }),
]);

export const WeightsSchema = z.object({
  task: z.number(),
  xp: z.number(),
  criticality: z.number(),
  mapCost: z.record(z.string(), z.number()).default({}),
});

export interface RaidForesight {
  raidIndex: number;
  warnings: ExclusivityWarning[];
}

export interface PlanBundle {
  hash: string;
  builtAt: string;
  buildMs: number;
  horizon: number;
  goals: Goal[];
  weights: PlannerWeights;
  plan: Plan;
  /** foresight warnings per planned raid (index-aligned with plan.raids) */
  foresight: RaidForesight[];
  /** display names for every map id in plan.raids (+ "any") — consumers must never show raw ids */
  mapNames: Record<string, string>;
}

export function goalsOf(store: ProfileStore): Goal[] {
  const stored = store.getGoals<unknown>();
  const parsed = z.array(GoalSchema).safeParse(stored);
  return parsed.success && parsed.data.length > 0 ? parsed.data : DEFAULT_GOALS;
}

export function weightsOf(store: ProfileStore): PlannerWeights {
  const parsed = WeightsSchema.safeParse(store.getWeights<unknown>());
  return parsed.success ? parsed.data : DEFAULT_WEIGHTS;
}

export function buildPlanBundle(world: LoadedWorld, store: ProfileStore, horizon: number): PlanBundle {
  const started = performance.now();
  const goals = goalsOf(store);
  const weights = weightsOf(store);
  const state = PlayerState.parse(store.toPlayerState());
  const goalSet = resolveGoalTasks(world.graph, goals);
  const curve = new LevelCurve(world.playerLevels);
  const sim = toSim(state, (l) => curve.xpForLevel(l));
  const plan = buildPlan(world.graph, sim, goalSet, curve, { horizon, weights });

  const foresight: RaidForesight[] = plan.raids.map((raid) => ({
    raidIndex: raid.index,
    warnings: taskExclusivityWarnings(
      world.graph,
      raid.tasks.map((t) => t.id),
      goalSet,
    ),
  }));

  const hash = createHash("sha256")
    .update(JSON.stringify({ goals, weights, plan, foresight }))
    .digest("hex")
    .slice(0, 16);

  const mapNames: Record<string, string> = { any: "Any map" };
  for (const raid of plan.raids) {
    if (raid.map !== "any") mapNames[raid.map] = world.mapName(raid.map);
  }

  return {
    hash,
    builtAt: new Date().toISOString(),
    buildMs: Math.round(performance.now() - started),
    horizon,
    goals,
    weights,
    plan,
    foresight,
    mapNames,
  };
}

export interface PlanPipelineOptions {
  debounceMs?: number;
  /** called after a debounced rebuild whose hash differs from the previous plan */
  onUpdated?: (bundle: PlanBundle) => void;
}

export class PlanPipeline {
  private readonly cache = new Map<number, PlanBundle>();
  private readonly debounceMs: number;
  private readonly onUpdated: ((bundle: PlanBundle) => void) | undefined;
  private timer: NodeJS.Timeout | null = null;
  private lastHash: string | null = null;
  private unbind: (() => void) | null = null;

  constructor(
    private world: LoadedWorld,
    private store: ProfileStore,
    opts: PlanPipelineOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? PLAN_DEBOUNCE_MS;
    this.onUpdated = opts.onUpdated;
  }

  /** Cached plan for a horizon (built on demand — a fresh build stays < 2 s, M3.2). */
  get(horizon: number = DEFAULT_HORIZON): PlanBundle {
    const cached = this.cache.get(horizon);
    if (cached) return cached;
    const bundle = buildPlanBundle(this.world, this.store, horizon);
    this.cache.set(horizon, bundle);
    // Seed the broadcast baseline only when none exists yet (first build after
    // boot/retarget). A read landing INSIDE the debounce window must NOT mark
    // the fresh hash as "seen", or the pending rebuild would compare equal and
    // suppress the plan.updated broadcast to every other WS client.
    if (horizon === DEFAULT_HORIZON && this.lastHash === null) this.lastHash = bundle.hash;
    return bundle;
  }

  /** Subscribe to the store's `state.changed` → debounce → rebuild → plan.updated. */
  bind(): void {
    this.unbindStore();
    const listener = (payload: { reason: string }): void => {
      // watcher cursor writes never emit; metrics writes bypass the emitter —
      // every event that reaches here is a real player-state change.
      void payload;
      this.invalidate();
    };
    this.store.events.on("state.changed", listener);
    this.unbind = () => this.store.events.off("state.changed", listener);
  }

  unbindStore(): void {
    this.unbind?.();
    this.unbind = null;
  }

  /** Drop caches and schedule a debounced rebuild of the default horizon. */
  invalidate(): void {
    this.cache.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      // The broadcast path is the single owner of lastHash advancement: compare
      // against the last hash seen by a broadcast (or the boot baseline), then
      // record the rebuilt hash so the next cycle diffs against THIS plan.
      try {
        const previous = this.lastHash;
        const bundle = this.get(DEFAULT_HORIZON);
        this.lastHash = bundle.hash;
        if (bundle.hash !== previous) this.onUpdated?.(bundle);
      } catch (err) {
        // a rebuild failure must not crash the process; the next read or
        // state.changed retries with the same inputs surfaced to the caller
        console.error("[plan] debounced rebuild failed:", err);
      }
    }, this.debounceMs);
    this.timer.unref();
  }

  /** Swap the underlying store/world (profile switch); rebinds, clears caches, and resets the broadcast baseline (the next read re-seeds it). */
  retarget(world: LoadedWorld, store: ProfileStore): void {
    this.unbindStore();
    this.world = world;
    this.store = store;
    this.cache.clear();
    this.lastHash = null;
    this.bind();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unbindStore();
  }
}
