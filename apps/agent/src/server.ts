import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { ModelClient, ChatMessage } from "./model.js";
import type { ServiceClient } from "./service.js";
import { buildToolBelt } from "./tools.js";
import { buildSystemPrompt } from "./grounding.js";
import { generateBriefing } from "./briefing.js";
import { intakeGoals } from "./goals-intake.js";
import { proposeWeights, FingerprintSchema, MapOutcomeSchema } from "./weights.js";
import { BackendUnavailableError, DEFAULT_WEIGHTS, PlannerWeightsSchema } from "./types.js";

/**
 * Agent HTTP surface on port 3142 (CONTRACTS §2/§8):
 *   POST /chat {message, sessionId?} -> {reply, toolCalls}
 *   POST /briefing {raidIndex}       -> {briefing}
 *   GET  /health                     -> {ok, backend, serviceReachable}
 *   GET  /propose-weights            -> {proposed, changes, noChange, current}
 *   POST /goals-intake {text}        -> {goals, weights, notes, toolCalls}   (documented addition, SPEC-3)
 * Graceful degradation: model-backend failures -> 503 {error: how to fix};
 * /health stays 200 regardless.
 * @tier T0
 */

const ChatBody = z.object({
  message: z.string().min(1),
  sessionId: z.string().optional(),
});
const BriefingBody = z.object({ raidIndex: z.number().int().min(1).max(20).default(1) });
const IntakeBody = z.object({ text: z.string().min(1) });

const MAX_SESSIONS = 32;
const MAX_HISTORY = 40;

/** Tiny insertion-ordered LRU for per-session chat history. */
export class SessionStore {
  private readonly sessions = new Map<string, ChatMessage[]>();

  history(id: string): ChatMessage[] {
    const existing = this.sessions.get(id);
    if (existing) {
      // refresh recency
      this.sessions.delete(id);
      this.sessions.set(id, existing);
      return existing;
    }
    const fresh: ChatMessage[] = [];
    this.sessions.set(id, fresh);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    return fresh;
  }

  append(id: string, ...messages: ChatMessage[]): void {
    const history = this.history(id);
    history.push(...messages);
    while (history.length > MAX_HISTORY) history.shift();
  }

  get size(): number {
    return this.sessions.size;
  }
}

export interface ServerDeps {
  client: ModelClient;
  service: ServiceClient;
}

function toErrorPayload(err: unknown): { status: number; body: { error: string } } {
  if (err instanceof BackendUnavailableError) {
    return { status: 503, body: { error: `${err.message} Fix: ${err.fix}` } };
  }
  return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const sessions = new SessionStore();
  const system = buildSystemPrompt();

  // DNS-rebinding guard (mirrors apps/service): loopback-bound + unauthenticated,
  // so a hostile page must not be able to spend model tokens via /chat.
  app.addHook("onRequest", async (req, reply) => {
    const host = (req.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]" && host !== "") {
      return reply.code(403).send({ error: `Host "${host}" not allowed — this API is local-only.` });
    }
  });

  app.post("/chat", async (req, reply) => {
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { message, sessionId = "default" } = parsed.data;
    const history = sessions.history(sessionId);
    try {
      const result = await deps.client.complete({
        system,
        messages: [...history, { role: "user", content: message }],
        tools: buildToolBelt(deps.service),
      });
      sessions.append(sessionId, { role: "user", content: message }, { role: "assistant", content: result.text });
      return reply.send({ reply: result.text, toolCalls: result.toolCalls });
    } catch (err) {
      const { status, body } = toErrorPayload(err);
      return reply.code(status).send(body);
    }
  });

  app.post("/briefing", async (req, reply) => {
    const parsed = BriefingBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const { briefing, toolCalls } = await generateBriefing(deps.client, deps.service, parsed.data.raidIndex);
      return reply.send({ briefing, toolCalls });
    } catch (err) {
      const { status, body } = toErrorPayload(err);
      return reply.code(status).send(body);
    }
  });

  app.post("/goals-intake", async (req, reply) => {
    const parsed = IntakeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const result = await intakeGoals(deps.client, deps.service, parsed.data.text);
      return reply.send(result);
    } catch (err) {
      const { status, body } = toErrorPayload(err);
      return reply.code(status).send(body);
    }
  });

  app.get("/health", async (_req, reply) => {
    const [availability, serviceReachable] = await Promise.all([
      deps.client.available().catch(() => ({ ok: false })),
      deps.service.reachable(),
    ]);
    return reply.send({
      ok: true,
      backend: deps.client.backend,
      backendAvailable: availability.ok,
      serviceReachable,
    });
  });

  app.get("/propose-weights", async (_req, reply) => {
    try {
      const fingerprintRaw = await deps.service.get("/api/insights/fingerprint");
      const fingerprint = FingerprintSchema.parse(fingerprintRaw);

      const goalsRaw = (await deps.service.get("/api/goals").catch(() => null)) as {
        weights?: unknown;
      } | null;
      const weights = goalsRaw?.weights ? PlannerWeightsSchema.parse(goalsRaw.weights) : DEFAULT_WEIGHTS;

      const raidsRaw = (await deps.service.get("/api/insights/raids")) as
        | { byMap?: unknown[] }
        | unknown[]
        | null;
      const rows = Array.isArray(raidsRaw) ? raidsRaw : (raidsRaw?.byMap ?? []);
      const mapOutcomes = z.array(MapOutcomeSchema).parse(rows);

      const proposal = proposeWeights({ fingerprint, weights, mapOutcomes });
      return reply.send({ ...proposal, current: weights });
    } catch (err) {
      const { status, body } = toErrorPayload(err);
      return reply.code(status).send(body);
    }
  });

  return app;
}
