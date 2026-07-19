import { afterEach, describe, expect, it } from "vitest";
import { closeApps, jsonResponse, testApp, DEAD_AGENT_URL } from "./helpers.js";

describe("agent proxy (CONTRACTS §5.5)", () => {
  afterEach(closeApps);

  it("POST /api/agent/chat 503s with a helpful message when the agent is down", async () => {
    const app = await testApp({ agentUrl: DEAD_AGENT_URL });
    const res = await app.inject({ method: "POST", url: "/api/agent/chat", payload: { message: "hi" } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain(DEAD_AGENT_URL);
    expect(res.json().error).toContain("pnpm --filter @tac/agent start");
  });

  it("GET /api/agent/health 503s when the agent is down", async () => {
    const app = await testApp({ agentUrl: DEAD_AGENT_URL });
    const res = await app.inject({ method: "GET", url: "/api/agent/health" });
    expect(res.statusCode).toBe(503);
  });

  it("forwards chat/briefing bodies to the agent and mirrors its response", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      if (String(input).endsWith("/chat")) return jsonResponse({ reply: "go Customs", toolCalls: [] });
      return jsonResponse({ briefing: "short briefing" });
    };
    const app = await testApp({ agentUrl: "http://agent.test", fetchImpl: fakeFetch });

    const chat = await app.inject({
      method: "POST",
      url: "/api/agent/chat",
      payload: { message: "what next?", sessionId: "s1" },
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.json()).toEqual({ reply: "go Customs", toolCalls: [] });

    const briefing = await app.inject({ method: "POST", url: "/api/agent/briefing", payload: { raidIndex: 0 } });
    expect(briefing.statusCode).toBe(200);
    expect(briefing.json()).toEqual({ briefing: "short briefing" });

    expect(seen[0]).toEqual({ url: "http://agent.test/chat", body: { message: "what next?", sessionId: "s1" } });
    expect(seen[1]).toEqual({ url: "http://agent.test/briefing", body: { raidIndex: 0 } });
  });

  it("GET /api/agent/propose-weights forwards to the agent and mirrors its proposal", async () => {
    const seen: string[] = [];
    const proposal = {
      proposed: { task: 1.3, xp: 0.15, criticality: 0.1, mapCost: { lighthouse: 1.8 } },
      current: { task: 1, xp: 0.15, criticality: 0.1, mapCost: {} },
      changes: [{ key: "mapCost.lighthouse", from: 1, to: 1.8, rationale: "you died a lot on Lighthouse" }],
      noChange: false,
    };
    const fakeFetch: typeof fetch = async (input) => {
      seen.push(String(input));
      return jsonResponse(proposal);
    };
    const app = await testApp({ agentUrl: "http://agent.test", fetchImpl: fakeFetch });
    const res = await app.inject({ method: "GET", url: "/api/agent/propose-weights" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(proposal);
    expect(seen[0]).toBe("http://agent.test/propose-weights");
  });

  it("GET /api/agent/propose-weights 503s when the agent is down", async () => {
    const app = await testApp({ agentUrl: DEAD_AGENT_URL });
    const res = await app.inject({ method: "GET", url: "/api/agent/propose-weights" });
    expect(res.statusCode).toBe(503);
  });

  it("mirrors agent error statuses instead of masking them", async () => {
    const fakeFetch: typeof fetch = async () => jsonResponse({ error: "bad prompt" }, 422);
    const app = await testApp({ agentUrl: "http://agent.test", fetchImpl: fakeFetch });
    const res = await app.inject({ method: "POST", url: "/api/agent/chat", payload: { message: "x" } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "bad prompt" });
  });
});
