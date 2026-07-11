import type { FastifyInstance, FastifyReply } from "fastify";
import type { ServiceRuntime } from "../runtime.js";

/**
 * CONTRACTS §5.5 — agent proxy. The service never embeds the LLM; it forwards
 * to apps/agent (default http://localhost:3142) and answers 503 with a
 * helpful message when the agent is down. Chat/briefing get a long timeout
 * (LLM latency); health a short one.
 */

const CHAT_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 2_000;

async function forward(
  rt: ServiceRuntime,
  reply: FastifyReply,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; timeoutMs: number },
): Promise<unknown> {
  const url = `${rt.agentUrl}${path}`;
  let res: Response;
  try {
    res = await rt.fetchImpl(url, {
      method: init.method,
      signal: AbortSignal.timeout(init.timeoutMs),
      ...(init.body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }
        : {}),
    });
  } catch {
    return reply.status(503).send({
      error:
        `Agent service unreachable at ${url} — start it with ` +
        "`pnpm --filter @tac/agent start` (port 3142), or point TAC_AGENT_URL / config.agentUrl at it.",
    });
  }
  const text = await res.text();
  reply.status(res.status);
  try {
    return JSON.parse(text);
  } catch {
    return reply.send({ error: text || `agent returned ${res.status}` });
  }
}

export function registerAgentRoutes(app: FastifyInstance, rt: ServiceRuntime): void {
  app.post("/api/agent/chat", async (req, reply) =>
    forward(rt, reply, "/chat", { method: "POST", body: req.body ?? {}, timeoutMs: CHAT_TIMEOUT_MS }),
  );

  app.post("/api/agent/briefing", async (req, reply) =>
    forward(rt, reply, "/briefing", { method: "POST", body: req.body ?? {}, timeoutMs: CHAT_TIMEOUT_MS }),
  );

  app.get("/api/agent/health", async (_req, reply) =>
    forward(rt, reply, "/health", { method: "GET", timeoutMs: HEALTH_TIMEOUT_MS }),
  );
}
