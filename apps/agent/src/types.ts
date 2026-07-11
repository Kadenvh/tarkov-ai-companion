import { z } from "zod";

/**
 * @tac/agent — shared shapes. The agent talks to the service over HTTP only
 * (CONTRACTS §1), so the planner's Goal / PlannerWeights shapes are mirrored
 * here as zod schemas rather than imported. They must stay byte-compatible
 * with packages/planner/src/{goals,director}.ts — CONTRACTS §5.2 is the wire
 * contract that arbitrates.
 * @tier T0 — the agent never touches the game or its files.
 */

export const GoalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("kappa") }),
  z.object({ type: z.literal("lightkeeper") }),
  z.object({ type: z.literal("level"), level: z.number().int().min(1).max(79) }),
  z.object({ type: z.literal("tasks"), ids: z.array(z.string()) }),
]);
export type Goal = z.infer<typeof GoalSchema>;

export const PlannerWeightsSchema = z.object({
  task: z.number(),
  xp: z.number(),
  criticality: z.number(),
  /** map id OR normalizedName -> cost multiplier (>1 aversion, <1 preference) */
  mapCost: z.record(z.string(), z.number()),
});
export type PlannerWeights = z.infer<typeof PlannerWeightsSchema>;

export const DEFAULT_WEIGHTS: PlannerWeights = { task: 1, xp: 0.15, criticality: 0.4, mapCost: {} };

/** One tool invocation as reported to API consumers (CONTRACTS §8 /chat). */
export interface ToolCallRecord {
  tool: string;
  argsSummary: string;
}

export type AgentBackend = "agent-sdk" | "api" | "mock";

/** Thrown when the model backend cannot serve a request; server maps it to 503. */
export class BackendUnavailableError extends Error {
  readonly code = "BACKEND_UNAVAILABLE";
  constructor(
    message: string,
    readonly fix: string,
  ) {
    super(message);
    this.name = "BackendUnavailableError";
  }
}
