import type { FastifyInstance } from "fastify";
import type { ServiceRuntime } from "../runtime.js";

/**
 * Live telemetry routes (the Coach observability slice — see {@link ../telemetry.js}).
 *
 *   GET /api/telemetry/current            → the latest {@link TelemetrySample}
 *                                           (triggers one when the ring is empty)
 *   GET /api/telemetry/history?minutes=5  → { samples: TelemetrySample[], intervalMs }
 *
 * Both routes `touch()` the scheduler, so REST interest keeps the demand-gated
 * poller alive (WS clients keep it alive via retain/release; see app.ts). The
 * poller also pushes each sample over `/ws` as `telemetry.sample`.
 */

const DEFAULT_HISTORY_MINUTES = 5;

export function registerTelemetryRoutes(app: FastifyInstance, rt: ServiceRuntime): void {
  app.get("/api/telemetry/current", async () => {
    return rt.telemetry.current();
  });

  app.get("/api/telemetry/history", async (req) => {
    const raw = (req.query as Record<string, unknown>)["minutes"];
    const parsed = Number(raw);
    const minutes = raw !== undefined && Number.isFinite(parsed) ? parsed : DEFAULT_HISTORY_MINUTES;
    rt.telemetry.touch();
    return { samples: rt.telemetry.history(minutes), intervalMs: rt.telemetry.intervalMs };
  });
}
