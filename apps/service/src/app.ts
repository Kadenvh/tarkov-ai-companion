import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { defaultDataDir, resolveNetwork } from "./config.js";
import { ServiceRuntime, type RuntimeOptions } from "./runtime.js";
import type { HubSocket } from "./ws.js";
import { registerCoreRoutes } from "./routes/core.js";
import { registerPlanningRoutes } from "./routes/planning.js";
import { registerEnvironmentRoutes } from "./routes/environment.js";
import { registerInsightsRoutes } from "./routes/insights.js";
import { registerTelemetryRoutes } from "./routes/telemetry.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerPlatformRoutes } from "./routes/platform.js";
import { registerIntegrationRoutes } from "./routes/integrations.js";

/**
 * Fastify app factory (M5.1) — builds the fully-registered app WITHOUT
 * listening, so tests drive it via `app.inject()`. All environment
 * touchpoints are injectable through {@link BuildAppOptions}; `main.ts` is
 * the only place that binds the real machine.
 */

declare module "fastify" {
  interface FastifyInstance {
    tac: ServiceRuntime;
  }
}

export interface BuildAppOptions extends Partial<Omit<RuntimeOptions, "dataDir">> {
  dataDir?: string;
  /** SPA build dir served at `/` (default: apps/web/dist when it exists) */
  staticDir?: string;
  logger?: boolean;
}

/**
 * SPA build dir served at `/`. Honors `TAC_WEB_DIR` (set by the packaged desktop
 * app to `<resources>/sidecars/web/dist`); falls back to `apps/web/dist` relative
 * to this file for dev/source runs.
 */
export function defaultWebDist(): string {
  if (process.env.TAC_WEB_DIR) return process.env.TAC_WEB_DIR;
  return resolve(fileURLToPath(import.meta.url), "../../../web/dist");
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  mkdirSync(dataDir, { recursive: true });
  const rt = new ServiceRuntime({ ...opts, dataDir });

  const app = fastify({ logger: opts.logger ?? false, forceCloseConnections: true });
  app.decorate("tac", rt);

  // DNS-rebinding guard: the daemon is unauthenticated, so reject any request
  // whose Host header isn't allowed — a hostile page resolving its own domain to
  // 127.0.0.1 must not reach side-effectful routes. Loopback-only by default;
  // when LAN exposure is opted in (config.lan / TAC_BIND_LAN) the allowlist is
  // widened to this machine's LAN IPs + hostname + configured hosts.
  const net = resolveNetwork(rt.config);
  app.addHook("onRequest", async (req, reply) => {
    const host = (req.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
    if (!net.allowedHosts.has(host)) {
      return reply.code(403).send({
        error: `Host "${host}" not allowed — ${net.lanEnabled ? "not in the LAN allowlist" : "this API is local-only"}.`,
      });
    }
    // M5.6 request counter
    rt.metrics.countRequest(req.url);
  });

  // §5.3 events
  await app.register(fastifyWebsocket);
  app.get("/ws", { websocket: true }, (socket) => {
    const hubSocket = socket as unknown as HubSocket;
    rt.hub.add(hubSocket);
    // A live WS client is telemetry demand: keep the poller sampling while it is
    // connected, and release it on close so idle-stop can wind nvidia-smi down.
    rt.telemetry.retain();
    hubSocket.on("close", () => rt.telemetry.release());
  });

  registerCoreRoutes(app, rt);
  registerPlanningRoutes(app, rt);
  registerEnvironmentRoutes(app, rt);
  registerInsightsRoutes(app, rt);
  registerTelemetryRoutes(app, rt);
  registerAgentRoutes(app, rt);
  registerPlatformRoutes(app, rt);
  registerIntegrationRoutes(app, rt);

  // Serve the web build at / with SPA fallback (§6): non-/api GETs -> index.html.
  const staticDir = opts.staticDir ?? defaultWebDist();
  const hasStatic = existsSync(join(staticDir, "index.html"));
  if (hasStatic) {
    await app.register(fastifyStatic, { root: staticDir });
  }
  app.setNotFoundHandler((req, reply) => {
    if (hasStatic && req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/ws")) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.status(404).send({ error: `route not found: ${req.method} ${req.url}` });
  });

  app.addHook("onClose", async () => {
    await rt.close();
  });

  return app;
}
