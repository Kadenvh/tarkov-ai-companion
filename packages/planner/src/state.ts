import { z } from "zod";
import { GameMode } from "@tac/shared";

/**
 * Player state — the persisted, per-profile source of truth (mirrors the
 * TarkovTracker-shaped schema that @tac/state-engine will own). The planner
 * consumes a snapshot of it; the state engine produces it from log events.
 */
export const PlayerState = z.object({
  gameMode: GameMode.default("regular"),
  level: z.number().int().min(1).max(79).default(1),
  faction: z.enum(["USEC", "BEAR"]).optional(),
  prestige: z.number().int().min(0).max(6).default(0),
  completedTasks: z.array(z.string()).default([]),
  failedTasks: z.array(z.string()).default([]),
  /** trader id -> reputation (for loyalty-gate checks) */
  traderRep: z.record(z.string(), z.number()).default({}),
});
export type PlayerState = z.infer<typeof PlayerState>;

/** Mutable working state used inside the solver — Sets for O(1) membership. */
export interface SimState {
  level: number;
  xp: number;
  faction: "USEC" | "BEAR" | undefined;
  completed: Set<string>;
  failed: Set<string>;
}

export function toSim(state: PlayerState, xpForLevel: (l: number) => number): SimState {
  return {
    level: state.level,
    xp: xpForLevel(state.level),
    faction: state.faction,
    completed: new Set(state.completedTasks),
    failed: new Set(state.failedTasks),
  };
}
