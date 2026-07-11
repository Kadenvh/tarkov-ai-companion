import type { FastifyInstance } from "fastify";
import {
  survivalByMap,
  survivalByHour,
  survivalByDuration,
  queuePatterns,
  sessionRhythm,
  fleaIncome,
  netWorthEstimate,
  playstyleFingerprint,
} from "@tac/insights";
import type { ServiceRuntime } from "../runtime.js";

/**
 * CONTRACTS §5.4 — insights routes (M7), plus the documented fingerprint
 * extension. All read-only over the active profile DB.
 */

export function registerInsightsRoutes(app: FastifyInstance, rt: ServiceRuntime): void {
  app.get("/api/insights/raids", async () => {
    const db = rt.store.db;
    return {
      survivalByMap: survivalByMap(db),
      survivalByHour: survivalByHour(db),
      survivalByDuration: survivalByDuration(db),
      queues: queuePatterns(db),
      rhythm: sessionRhythm(db),
    };
  });

  app.get("/api/insights/economy", async () => {
    const db = rt.store.db;
    return {
      daily: fleaIncome(db, "daily"),
      weekly: fleaIncome(db, "weekly"),
      netWorth: netWorthEstimate(db),
    };
  });

  // Documented extension (SPEC-6): M7.3 playstyle fingerprint (feeds agent M4.5).
  app.get("/api/insights/fingerprint", async () => playstyleFingerprint(rt.store.db));
}
