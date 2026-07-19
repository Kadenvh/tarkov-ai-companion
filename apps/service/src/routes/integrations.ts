import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CAPABILITIES,
  isCapability,
  createManualCaptureConnector,
  type Capability,
  type ConnectorReading,
} from "@tac/connectors";
import {
  isSourceCapability,
  QuotaExhaustedError,
  HttpError,
  type SourceCapability,
  type SourceStatus,
  type QuotaState,
} from "@tac/sources";
import type { ServiceRuntime } from "../runtime.js";

/**
 * CONTRACTS §5.6 (Connectors) + §5.7 (Sources) — the M9/M10 layers made live.
 *
 * Connectors are capability-first local adapters (T0/T1 only, never the game
 * process); sources are read-only remote feeds with cache/quota discipline.
 * Both are resolved through their registries on the ServiceRuntime. WS frames
 * (§3): `connector.detected` on the detect sweep, `connector.reading` on a
 * landed read, `source.status` whenever a source's status row changes.
 *
 * M10 persistence (CONTRACTS §4): connector reads land in `connector_reading`,
 * source-read quota folds into `source_quota` (restored on the next startup).
 * All persistence is BEST-EFFORT — a store failure is logged and swallowed so it
 * never fails the underlying read.
 */

/** Query/body validators. Capabilities are validated against the enums at the boundary. */
const CapabilitySchema = z.custom<Capability>(isCapability, { message: "unknown capability" });
const SourceCapabilitySchema = z.custom<SourceCapability>(isSourceCapability, {
  message: "unknown source capability",
});

const ConnectorReadQuery = z.object({
  capability: CapabilitySchema,
  prefer: z.string().min(1).optional(),
});

const ManualBody = z
  .object({
    capability: CapabilitySchema,
    payload: z.unknown(),
  })
  .refine((b) => b.payload !== undefined, { message: "payload is required" });

const SourceReadQuery = z.object({
  source: z.string().min(1),
  capability: SourceCapabilitySchema,
  /** Optional path override; otherwise a per-source/capability default is used. */
  path: z.string().min(1).optional(),
});

/** Best-effort default request path for a (source, capability) when none is given. */
function defaultSourcePath(
  sourceId: string,
  capability: SourceCapability,
  gameMode: string,
): string | undefined {
  if (sourceId === "tarkovtracker" && capability === "progress-read") return "/progress";
  if (sourceId === "tarkov-dev-json") {
    if (capability === "game-data") return `/${gameMode}/tasks`;
    if (capability === "prices") return `/${gameMode}/prices`;
  }
  return undefined;
}

const nowIso = (): string => new Date().toISOString();

export function registerIntegrationRoutes(app: FastifyInstance, rt: ServiceRuntime): void {
  // Best-effort persistence (CONTRACTS §4). A store failure must never fail the
  // read the caller asked for, so both helpers log-and-swallow.

  /** Persist a landed connector/manual reading to `connector_reading`. */
  const persistReading = (reading: ConnectorReading, source: "connector" | "manual"): void => {
    try {
      rt.store.insertConnectorReading({
        connectorId: reading.connectorId,
        capability: reading.capability,
        capturedAt: reading.capturedAt,
        ...(reading.gameVersion !== undefined ? { gameVersion: reading.gameVersion } : {}),
        ...(reading.settingsHash !== undefined ? { settingsHash: reading.settingsHash } : {}),
        data: reading.data,
        source,
      });
    } catch (err) {
      app.log.warn({ err }, "failed to persist connector_reading (best-effort)");
    }
  };

  /** Fold a source's current `QuotaState` into `source_quota` for restore-on-restart. */
  const persistSourceQuota = (sourceId: string, quota: QuotaState): void => {
    try {
      rt.store.upsertSourceQuota(sourceId, {
        ...(quota.readsRemaining !== undefined ? { readsRemaining: quota.readsRemaining } : {}),
        ...(quota.writesRemaining !== undefined ? { writesRemaining: quota.writesRemaining } : {}),
        ...(quota.resetsAt !== undefined ? { resetsAt: quota.resetsAt } : {}),
      });
    } catch (err) {
      app.log.warn({ err }, "failed to persist source_quota (best-effort)");
    }
  };

  // ---- §5.6 Connectors ------------------------------------------------------

  app.get("/api/connectors", async () => {
    const health = await rt.connectors.healthAll();
    return rt.connectors.list().map((c) => ({
      id: c.id,
      vendor: c.vendor,
      capabilities: c.capabilities,
      riskTier: c.riskTier,
      health: health[c.id] ?? "error",
    }));
  });

  app.get("/api/connectors/detect", async () => {
    const results: { id: string; installed: boolean; configPath?: string; version?: string }[] = [];
    for (const connector of rt.connectors.list()) {
      const detect = await connector.detect();
      results.push({
        id: connector.id,
        installed: detect.installed,
        ...(detect.configPath !== undefined ? { configPath: detect.configPath } : {}),
        ...(detect.version !== undefined ? { version: detect.version } : {}),
      });
      // §3 connector.detected — one frame per advertised capability.
      for (const capability of connector.capabilities) {
        rt.hub.broadcast("connector.detected", {
          connectorId: connector.id,
          capability,
          installed: detect.installed,
          ...(detect.configPath !== undefined ? { configPath: detect.configPath } : {}),
          ts: nowIso(),
        });
      }
    }
    return results;
  });

  app.get("/api/connectors/capabilities", async () => {
    const satisfiedBy: Record<string, string[]> = {};
    for (const capability of CAPABILITIES) {
      satisfiedBy[capability] = rt.connectors.byCapability(capability).map((c) => c.id);
    }
    return { capabilities: CAPABILITIES, satisfiedBy };
  });

  app.get("/api/connectors/read", async (req, reply) => {
    const query = ConnectorReadQuery.safeParse(req.query);
    if (!query.success) {
      return reply.status(400).send({ error: query.error.issues[0]?.message ?? "invalid query" });
    }
    const { capability, prefer } = query.data;

    const candidates = rt.connectors.byCapability(capability);
    if (candidates.length === 0) {
      return reply.status(404).send({ error: `No connector satisfies capability "${capability}".` });
    }
    if (prefer !== undefined && !candidates.some((c) => c.id === prefer)) {
      return reply
        .status(409)
        .send({ error: `Preferred connector "${prefer}" does not satisfy capability "${capability}".` });
    }

    let reading;
    try {
      reading = await rt.connectors.read(capability, prefer !== undefined ? { prefer } : {});
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
    persistReading(reading, "connector");
    rt.hub.broadcast("connector.reading", {
      connectorId: reading.connectorId,
      capability: reading.capability,
      ...(reading.settingsHash !== undefined ? { settingsHash: reading.settingsHash } : {}),
      ts: reading.capturedAt,
    });
    return reading;
  });

  app.post("/api/connectors/manual", async (req, reply) => {
    const body = ManualBody.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.issues[0]?.message ?? "invalid body" });
    }
    const connector = createManualCaptureConnector({
      payload: body.data.payload,
      targetCapability: body.data.capability,
    });
    const reading = await connector.read("manual-capture");
    persistReading(reading, "manual");
    rt.hub.broadcast("connector.reading", {
      connectorId: reading.connectorId,
      capability: reading.capability,
      ...(reading.settingsHash !== undefined ? { settingsHash: reading.settingsHash } : {}),
      ts: reading.capturedAt,
    });
    return reading;
  });

  // ---- §5.7 Sources ---------------------------------------------------------

  // Change-detected source.status broadcaster: only emit when a row differs
  // from the last one we announced (CONTRACTS §3 — "on any source status change").
  const lastStatus = new Map<string, string>();
  const broadcastStatusChanges = (statuses: SourceStatus[]): void => {
    for (const status of statuses) {
      const serialized = JSON.stringify(status);
      if (lastStatus.get(status.id) !== serialized) {
        lastStatus.set(status.id, serialized);
        rt.hub.broadcast("source.status", { ...status, ts: nowIso() });
      }
    }
  };

  app.get("/api/sources", async () =>
    rt.sources.list().map((s) => ({
      id: s.id,
      kind: s.kind,
      baseUrl: s.baseUrl,
      capabilities: s.capabilities,
    })),
  );

  app.get("/api/sources/status", async () => {
    const statuses = await rt.sources.status();
    broadcastStatusChanges(statuses);
    return statuses;
  });

  app.get("/api/sources/read", async (req, reply) => {
    const query = SourceReadQuery.safeParse(req.query);
    if (!query.success) {
      return reply.status(400).send({ error: query.error.issues[0]?.message ?? "invalid query" });
    }
    const source = rt.sources.get(query.data.source);
    if (!source) {
      return reply.status(404).send({ error: `Unknown source "${query.data.source}".` });
    }
    if (!source.capabilities.includes(query.data.capability)) {
      return reply
        .status(400)
        .send({ error: `Source "${source.id}" cannot satisfy capability "${query.data.capability}".` });
    }
    const path = query.data.path ?? defaultSourcePath(source.id, query.data.capability, rt.gameMode);
    if (path === undefined) {
      return reply.status(400).send({
        error: `No default path for source "${source.id}" capability "${query.data.capability}" — pass ?path=`,
      });
    }

    try {
      const reading = await source.fetch({ capability: query.data.capability, path });
      // Fold the source's freshly-learned budget into source_quota (best-effort).
      const quota = source.quota?.();
      if (quota !== undefined) persistSourceQuota(source.id, quota);
      broadcastStatusChanges(await rt.sources.status());
      return reading;
    } catch (err) {
      if (err instanceof QuotaExhaustedError) {
        return reply.status(429).send({ error: err.message });
      }
      if (err instanceof HttpError) {
        return reply.status(503).send({ error: err.message });
      }
      // Transport failure (DNS/reset) or parse error — the source is unreachable.
      return reply.status(503).send({ error: (err as Error).message });
    }
  });
}
