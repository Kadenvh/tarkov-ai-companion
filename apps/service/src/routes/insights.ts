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
  parseGoal,
  netWorthGoal,
  attribution,
  raidHighlights,
  recentHighlights,
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

  // M7.4 — net-worth trajectory + goal-ETA. `?goal=rubles:5e7 | level:40 | kappa | tasks:150`.
  app.get("/api/insights/networth", async (req) => {
    const raw = (req.query as Record<string, unknown>)["goal"];
    const goal = parseGoal(typeof raw === "string" ? raw : null);
    return netWorthGoal(rt.store.db, { goal });
  });

  // M6.3 — config <-> outcome attribution (settings-hash change vs survival/FPS).
  app.get("/api/insights/attribution", async () => attribution(rt.store.db));

  // M7.5 — highlight-index. `?raidId=` for one raid; otherwise recent raids.
  app.get("/api/insights/highlights", async (req) => {
    const raw = (req.query as Record<string, unknown>)["raidId"];
    if (raw !== undefined) {
      const raidId = Number(raw);
      if (!Number.isFinite(raidId)) return { error: "raidId must be a number" };
      return { raid: raidHighlights(rt.store.db, raidId) };
    }
    const limitRaw = (req.query as Record<string, unknown>)["limit"];
    const limit = Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 10;
    return { raids: recentHighlights(rt.store.db, limit) };
  });
}
