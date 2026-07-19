import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer, SessionStore } from "../src/server.js";
import { MockClient, type CompleteOptions, type CompleteResult, type ModelClient } from "../src/model.js";
import { ServiceClient } from "../src/service.js";
import { BackendUnavailableError } from "../src/types.js";
import { startStubService, type StubService } from "./stub-service.js";

let stub: StubService;
let service: ServiceClient;
let app: FastifyInstance;

/** A backend that is configured but cannot serve (no auth). */
class DownClient implements ModelClient {
  readonly backend = "agent-sdk" as const;
  async available() {
    return { ok: false, detail: "log in with `claude`" };
  }
  async complete(_opts: CompleteOptions): Promise<CompleteResult> {
    throw new BackendUnavailableError(
      "Claude Code authentication failed.",
      "Log in with `claude`, or switch to TAC_AGENT_BACKEND=api with ANTHROPIC_API_KEY.",
    );
  }
}

beforeAll(async () => {
  stub = await startStubService();
  service = new ServiceClient(stub.url);
  app = buildServer({ client: new MockClient(), service });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await stub.close();
});

describe("agent HTTP surface (CONTRACTS §8)", () => {
  it("rejects non-local Host headers (DNS-rebinding guard) — nobody spends tokens cross-origin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "hi" },
      headers: { host: "evil.example.com:3142" },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toMatch(/local-only/);
  });

  it("POST /chat returns {reply, toolCalls} grounded in the service", async () => {
    const res = await app.inject({ method: "POST", url: "/chat", payload: { message: "what level am I?" } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reply: string; toolCalls: { tool: string; argsSummary: string }[] };
    expect(body.reply).toContain("level 15");
    expect(body.toolCalls[0]!.tool).toBe("get_state");
    expect(typeof body.toolCalls[0]!.argsSummary).toBe("string");
  });

  it("POST /chat fuses plan + foresight + sources into one answer with view-compatible citations", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "what should I prioritize this session?" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      reply: string;
      toolCalls: { tool: string; argsSummary: string; detail?: string }[];
    };
    // grounded answer references each surface
    expect(body.reply).toContain("get_plan");
    expect(body.reply).toContain("get_foresight");
    expect(body.reply).toContain("get_sources_status");
    // the XP-gate stall from foresight bubbles into the answer
    expect(body.reply).toContain("gate");
    // the down source (tarkovtracker) is flagged as a staleness caveat
    expect(body.reply).toContain("tarkovtracker");

    const names = body.toolCalls.map((c) => c.tool);
    expect(names).toEqual(["get_plan", "get_foresight", "get_sources_status"]);
    // Every tool-call is view-renderable: Copilot.tsx reads the label from
    // `tool` and the tooltip from `detail`. Assert both are present + shaped.
    for (const call of body.toolCalls) {
      expect(typeof call.tool).toBe("string");
      expect(typeof call.detail).toBe("string");
      expect(call.detail).toMatch(/^(GET|POST) \/api\//);
    }
  });

  it("POST /chat answers source/connector health from get_sources_status + get_connectors", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "what's my data source and connector status?" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reply: string; toolCalls: { tool: string }[] };
    expect(body.toolCalls.map((c) => c.tool)).toEqual(["get_sources_status", "get_connectors"]);
    expect(body.reply).toContain("get_sources_status");
    expect(body.reply).toContain("get_connectors");
  });

  it("POST /chat rejects an empty message with 400", async () => {
    const res = await app.inject({ method: "POST", url: "/chat", payload: { message: "" } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBeTruthy();
  });

  it("POST /briefing returns a <200-word briefing (default raidIndex 1)", async () => {
    const res = await app.inject({ method: "POST", url: "/briefing", payload: {} });
    expect(res.statusCode).toBe(200);
    const { briefing } = res.json() as { briefing: string };
    expect(briefing).toContain("customs");
    expect(briefing.trim().split(/\s+/).length).toBeLessThan(200);
  });

  it("POST /goals-intake extracts and persists goals (documented SPEC-3 addition)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/goals-intake",
      payload: { text: "Kappa + Savior before prestige, hate Lighthouse" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { goals: unknown[]; weights: { mapCost: Record<string, number> }; notes: string[] };
    expect(body.goals).toContainEqual({ type: "kappa" });
    expect(body.weights.mapCost["lighthouse"]).toBeGreaterThan(1);
  });

  it("GET /health reports backend + service reachability", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, backend: "mock", backendAvailable: true, serviceReachable: true });
  });

  it("GET /propose-weights builds a proposal from fingerprint + journal outcomes", async () => {
    const res = await app.inject({ method: "GET", url: "/propose-weights" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      proposed: { mapCost: Record<string, number> };
      changes: { key: string; rationale: string }[];
      current: unknown;
    };
    // stub: lighthouse 4 deaths of 6 -> aversion; customs favoured + survived -> preference
    expect(body.proposed.mapCost["lighthouse"]).toBeGreaterThan(1);
    expect(body.proposed.mapCost["customs"]).toBeLessThan(1);
    for (const change of body.changes) expect(change.rationale.length).toBeGreaterThan(10);
    expect(body.current).toBeDefined();
  });
});

describe("graceful degradation (backend down)", () => {
  it("/chat and /briefing return 503 with a fix message; /health stays 200", async () => {
    const downApp = buildServer({ client: new DownClient(), service });
    await downApp.ready();
    try {
      const chat = await downApp.inject({ method: "POST", url: "/chat", payload: { message: "hi" } });
      expect(chat.statusCode).toBe(503);
      expect((chat.json() as { error: string }).error).toMatch(/Fix: Log in with `claude`/);

      const briefing = await downApp.inject({ method: "POST", url: "/briefing", payload: { raidIndex: 1 } });
      expect(briefing.statusCode).toBe(503);

      const health = await downApp.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ ok: true, backend: "agent-sdk", backendAvailable: false });
    } finally {
      await downApp.close();
    }
  });

  it("/health reports serviceReachable=false when the service is down, still 200", async () => {
    const lonelyApp = buildServer({ client: new MockClient(), service: new ServiceClient("http://127.0.0.1:1") });
    await lonelyApp.ready();
    try {
      const res = await lonelyApp.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, serviceReachable: false });
    } finally {
      await lonelyApp.close();
    }
  });
});

describe("SessionStore (per-session history, LRU)", () => {
  it("keeps per-session history separate", () => {
    const store = new SessionStore();
    store.append("a", { role: "user", content: "one" });
    store.append("b", { role: "user", content: "two" });
    expect(store.history("a")).toHaveLength(1);
    expect(store.history("b")[0]!.content).toBe("two");
  });

  it("evicts the least recently used session beyond the cap", () => {
    const store = new SessionStore();
    for (let i = 0; i < 33; i++) store.append(`s${i}`, { role: "user", content: `m${i}` });
    expect(store.size).toBe(32);
    // s0 was evicted -> a fresh history comes back empty
    expect(store.history("s0")).toHaveLength(0);
  });

  it("caps per-session history length", () => {
    const store = new SessionStore();
    for (let i = 0; i < 50; i++) store.append("s", { role: "user", content: `m${i}` });
    const history = store.history("s");
    expect(history).toHaveLength(40);
    expect(history[0]!.content).toBe("m10");
  });

  it("chat history accumulates across turns in one session", async () => {
    const res1 = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "what level am I?", sessionId: "hist" },
    });
    const res2 = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "what is the plan tonight?", sessionId: "hist" },
    });
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect((res2.json() as { reply: string }).reply).toContain("customs");
  });
});
