import Fastify, { type FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";
import type { DownstreamMessage } from "./types.js";
import type { MonitorEngine } from "./engine.js";
import { coerceConfig, saveConfig, type MonitorConfig } from "./config.js";
import { monitorPage } from "./page.js";

/**
 * Monitor HTTP surface on port 3143 (TAC_MONITOR_PORT):
 *   GET  /              -> the monitor window (self-contained HTML)
 *   GET  /events        -> Server-Sent Events: {kind:"state"|"alert", ...}
 *   GET  /health        -> {ok, connected, profileKey}
 *   POST /config        -> merge a config patch; returns public config
 *   POST /scav/start    -> start the scav cooldown countdown
 *   POST /scav/clear    -> clear it
 *   POST /goons {map?}   -> submit a goons sighting (opt-in)
 *
 * Loopback-bound + unauthenticated, so the same DNS-rebinding Host guard the
 * service and agent use is applied here too.
 * @tier T0
 */

export interface MonitorServerDeps {
  engine: MonitorEngine;
  onConfigChange?: (config: MonitorConfig) => void;
}

export function buildMonitorServer(deps: MonitorServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const { engine } = deps;
  const clients = new Set<ServerResponse>();

  app.addHook("onRequest", async (req, reply) => {
    const host = (req.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]" && host !== "") {
      return reply.code(403).send({ error: `Host "${host}" not allowed — this UI is local-only.` });
    }
  });

  function broadcast(msg: DownstreamMessage): void {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const client of clients) {
      try {
        client.write(line);
      } catch {
        clients.delete(client);
      }
    }
  }

  engine.onState = (state) => broadcast({ kind: "state", state });
  engine.onAlert = (alert) => broadcast({ kind: "alert", alert });

  app.get("/", async (_req, reply) => {
    return reply.type("text/html").send(monitorPage());
  });

  app.get("/events", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`data: ${JSON.stringify({ kind: "state", state: engine.snapshot() })}\n\n`);
    clients.add(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* dropped below */
      }
    }, 25_000);
    req.raw.on("close", () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
  });

  app.get("/health", async (_req, reply) => {
    const state = engine.snapshot();
    return reply.send({ ok: true, connected: state.connected, profileKey: state.profileKey });
  });

  app.post("/config", async (req, reply) => {
    const next = coerceConfig(req.body, engine.getConfig());
    engine.setConfig(next);
    saveConfig(next);
    deps.onConfigChange?.(next);
    return reply.send(engine.snapshot().config);
  });

  app.post("/scav/start", async (_req, reply) => {
    engine.startScav();
    return reply.send({ ok: true });
  });

  app.post("/scav/clear", async (_req, reply) => {
    engine.clearScav();
    return reply.send({ ok: true });
  });

  app.post("/goons", async (req, reply) => {
    const body = (req.body ?? {}) as { map?: unknown };
    const map = typeof body.map === "string" ? body.map : undefined;
    const result = engine.reportGoons(map);
    return reply.code(result.ok ? 200 : 400).send(result);
  });

  return app;
}
