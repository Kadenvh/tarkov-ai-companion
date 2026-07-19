import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { backfillHistory } from "@tac/state-engine";
import type { ServiceRuntime } from "../runtime.js";

/**
 * Documented extensions (SPEC-6): historical backfill (M2.3 surface),
 * notifications (agent M4.4 -> WS "notice"), the M5.6 time-in-app
 * counter-metric, and the M8.2 patch-drift readiness surface.
 */

const BackfillBody = z
  .object({
    /** logs root override; defaults to the detected install's Logs dir */
    logsDir: z.string().min(1).optional(),
  })
  .optional();

const NotifyBody = z.object({
  title: z.string().min(1),
  body: z.string().default(""),
});

export function registerPlatformRoutes(app: FastifyInstance, rt: ServiceRuntime): void {
  app.post("/api/state/backfill", async (req, reply) => {
    const body = BackfillBody.safeParse(req.body ?? undefined);
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0]?.message ?? "invalid body" });
    const logsDir = body.data?.logsDir ?? rt.logsDir();
    if (!logsDir) {
      return reply
        .status(400)
        .send({ error: "no EFT logs directory found — set TAC_EFT_PATH or pass { logsDir }" });
    }
    const result = backfillHistory(rt.store, { logsDir });
    return { ok: true, logsDir, ...result };
  });

  app.post("/api/notify", async (req, reply) => {
    const body = NotifyBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0]?.message ?? "invalid body" });
    rt.hub.broadcast("notice", { title: body.data.title, body: body.data.body });
    return { ok: true, clients: rt.hub.clientCount };
  });

  app.get("/api/metrics", async () => rt.metrics.snapshot());

  // M8.2 patch-drift sentinel: readiness state for the next patch. Surfaces the
  // active snapshot vs the installed game version, the structural invariants of
  // the loaded world, and — when a snapshot for a newer detected version is on
  // disk — the reviewable diff. Never pulls a snapshot (that's operator-driven).
  app.get("/api/patch/status", async () => rt.patchStatus());
}
