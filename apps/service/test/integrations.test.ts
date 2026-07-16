import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  SourceRegistry,
  QuotaLedger,
  createTarkovDevJsonSource,
  createTarkovTrackerSource,
  type FetchLike,
  type HttpResponse,
} from "@tac/sources";
import { buildSourceRegistry } from "../src/registries.js";
import { closeApps, testApp } from "./helpers.js";

/**
 * CONTRACTS §5.6 (Connectors) + §5.7 (Sources) route coverage. Sources are
 * driven by an injected fetch so nothing here touches the network; connectors
 * exercise the always-available manual-capture adapter (no disk/vendor needed).
 */

/** A fake fetch Response satisfying the sources `HttpResponse` shape. */
function fakeResponse(body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    json: async () => body,
  };
}

/** Route fixtures by URL: tarkov.dev /status + /regular/tasks, TarkovTracker /progress. */
const fixtureFetch: FetchLike = async (url) => {
  if (url.endsWith("/status")) return fakeResponse({ currentVersion: "1.2.3" });
  if (url.includes("/regular/tasks")) return fakeResponse([{ id: "t1", name: "Debut" }]);
  if (url.includes("/regular/prices")) return fakeResponse({ "5449016a": 12000 });
  if (url.includes("/progress")) {
    return fakeResponse(
      { data: { playerLevel: 42, tasksProgress: [{ id: "t1", complete: true }] } },
      200,
      { "X-RateLimit-Remaining": "998" },
    );
  }
  return fakeResponse({});
};

describe("connectors routes (CONTRACTS §5.6)", () => {
  afterEach(closeApps);

  it("GET /api/connectors lists id/vendor/capabilities/riskTier/health", async () => {
    const app = await testApp();
    const body = (await app.inject({ method: "GET", url: "/api/connectors" })).json();
    expect(body.map((c: { id: string }) => c.id)).toEqual([
      "eft-config",
      "wootility",
      "manual-capture",
      "nvidia",
      "steelseries-sonar",
    ]);
    const manual = body.find((c: { id: string }) => c.id === "manual-capture");
    expect(manual.riskTier).toBe("T0");
    expect(manual.capabilities).toContain("manual-capture");
    expect(manual.health).toBe("connected");
  });

  it("GET /api/connectors/detect reports installed flags", async () => {
    const app = await testApp();
    const body = (await app.inject({ method: "GET", url: "/api/connectors/detect" })).json();
    const manual = body.find((c: { id: string }) => c.id === "manual-capture");
    expect(manual.installed).toBe(true);
  });

  it("GET /api/connectors/capabilities returns the enum + who satisfies each", async () => {
    const app = await testApp();
    const body = (await app.inject({ method: "GET", url: "/api/connectors/capabilities" })).json();
    expect(body.capabilities).toContain("game-config");
    expect(body.satisfiedBy["game-config"]).toEqual(["eft-config"]);
    expect(body.satisfiedBy["manual-capture"]).toEqual(["manual-capture"]);
  });

  it("GET /api/connectors/read returns a provenance-tagged reading (happy path)", async () => {
    const app = await testApp();
    const res = await app.inject({ method: "GET", url: "/api/connectors/read?capability=manual-capture" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connectorId).toBe("manual-capture");
    expect(body.capability).toBe("manual-capture");
    expect(body.data.kind).toBe("prompt");
    expect(typeof body.capturedAt).toBe("string");
  });

  it("GET /api/connectors/read 404s when no connector satisfies the capability", async () => {
    const app = await testApp();
    // display-config is a valid capability in the enum, but no registered connector provides it.
    const res = await app.inject({ method: "GET", url: "/api/connectors/read?capability=display-config" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("display-config");
  });

  it("GET /api/connectors/read 409s on a prefer mismatch", async () => {
    const app = await testApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/connectors/read?capability=game-config&prefer=wootility",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("wootility");
  });

  it("GET /api/connectors/read 400s on an unknown capability", async () => {
    const app = await testApp();
    const res = await app.inject({ method: "GET", url: "/api/connectors/read?capability=nonsense" });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/connectors/manual wraps a payload as a ConnectorReading", async () => {
    const app = await testApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/connectors/manual",
      payload: { capability: "tracker-sync", payload: { level: 42 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connectorId).toBe("manual-capture");
    expect(body.data.kind).toBe("payload");
    expect(body.data.payload).toEqual({ level: 42 });
    expect(body.data.targetCapability).toBe("tracker-sync");
  });

  it("POST /api/connectors/manual 400s without a payload", async () => {
    const app = await testApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/connectors/manual",
      payload: { capability: "tracker-sync" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("sources routes (CONTRACTS §5.7)", () => {
  afterEach(closeApps);

  it("GET /api/sources lists id/kind/baseUrl/capabilities", async () => {
    const sources = buildSourceRegistry({ fetchImpl: fixtureFetch });
    const app = await testApp({ sources });
    const body = (await app.inject({ method: "GET", url: "/api/sources" })).json();
    expect(body.map((s: { id: string }) => s.id)).toEqual([
      "tarkov-dev-json",
      "tarkovtracker",
      "eft-wiki",
      "tarkov-dev-manager",
    ]);
    const tt = body.find((s: { id: string }) => s.id === "tarkovtracker");
    expect(tt.capabilities).toContain("progress-read");
    expect(tt.baseUrl).toContain("tarkovtracker.org");
    // M10.4: eft-wiki (mediawiki/story) + tarkov-dev-manager (submit) now present.
    const wiki = body.find((s: { id: string }) => s.id === "eft-wiki");
    expect(wiki.kind).toBe("mediawiki");
    expect(wiki.capabilities).toContain("story");
    const manager = body.find((s: { id: string }) => s.id === "tarkov-dev-manager");
    expect(manager.capabilities).toContain("submit");
  });

  it("GET /api/sources/status marks an un-configured TarkovTracker as down (no token)", async () => {
    const sources = buildSourceRegistry({ fetchImpl: fixtureFetch }); // no token → TT constructed empty
    const app = await testApp({ sources });
    const body = (await app.inject({ method: "GET", url: "/api/sources/status" })).json();
    const dev = body.find((s: { id: string }) => s.id === "tarkov-dev-json");
    const tt = body.find((s: { id: string }) => s.id === "tarkovtracker");
    expect(dev.up).toBe(true);
    expect(dev.apiVersion).toBe("1.2.3");
    expect(tt.up).toBe(false); // unconfigured: health() == "missing"
  });

  it("GET /api/sources/read returns a cache-first reading (happy path)", async () => {
    const sources = buildSourceRegistry({ fetchImpl: fixtureFetch });
    const app = await testApp({ sources });
    const res = await app.inject({
      method: "GET",
      url: "/api/sources/read?source=tarkov-dev-json&capability=game-data",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sourceId).toBe("tarkov-dev-json");
    expect(body.capability).toBe("game-data");
    expect(body.fromCache).toBe(false);
    expect(body.data).toEqual([{ id: "t1", name: "Debut" }]);
  });

  it("GET /api/sources/read 404s on an unknown source", async () => {
    const sources = buildSourceRegistry({ fetchImpl: fixtureFetch });
    const app = await testApp({ sources });
    const res = await app.inject({
      method: "GET",
      url: "/api/sources/read?source=nope&capability=game-data",
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/sources/read 400s when the source can't satisfy the capability", async () => {
    const sources = buildSourceRegistry({ fetchImpl: fixtureFetch });
    const app = await testApp({ sources });
    const res = await app.inject({
      method: "GET",
      url: "/api/sources/read?source=tarkov-dev-json&capability=progress-read",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("cannot satisfy");
  });

  it("GET /api/sources/read 400s on an unknown source capability", async () => {
    const sources = buildSourceRegistry({ fetchImpl: fixtureFetch });
    const app = await testApp({ sources });
    const res = await app.inject({
      method: "GET",
      url: "/api/sources/read?source=tarkov-dev-json&capability=bogus",
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/sources/read 429s when the shared quota is exhausted (refuse, don't 429 the API)", async () => {
    const quota = new QuotaLedger();
    quota.seed({ readsRemaining: 0 });
    const sources = new SourceRegistry();
    sources.register(createTarkovDevJsonSource({ fetchImpl: fixtureFetch }));
    sources.register(createTarkovTrackerSource({ token: "tkn", fetchImpl: fixtureFetch, quota }));
    const app = await testApp({ sources });
    const res = await app.inject({
      method: "GET",
      url: "/api/sources/read?source=tarkovtracker&capability=progress-read",
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toContain("quota");
  });

  it("GET /api/sources/read reads TarkovTracker progress when a token is configured", async () => {
    const sources = buildSourceRegistry({ token: "tkn", fetchImpl: fixtureFetch });
    const app = await testApp({ sources });
    const res = await app.inject({
      method: "GET",
      url: "/api/sources/read?source=tarkovtracker&capability=progress-read",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sourceId).toBe("tarkovtracker");
    expect(body.data.playerLevel).toBe(42);
  });
});

/** Minimal WS harness (mirrors test/ws.test.ts) to assert §3 integration frames. */
async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("no ephemeral port");
  return address.port;
}

describe("integration WS frames (CONTRACTS §3)", () => {
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.close();
    await closeApps();
  });

  async function connect(port: number): Promise<{ waitFor: (type: string) => Promise<Record<string, unknown>> }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws);
    const frames: { type: string; payload: Record<string, unknown> }[] = [];
    const waiters: { type: string; resolve: (p: Record<string, unknown>) => void }[] = [];
    ws.addEventListener("message", (ev) => {
      const frame = JSON.parse(String(ev.data)) as { type: string; payload: Record<string, unknown> };
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.type === frame.type) {
          waiters[i]!.resolve(frame.payload);
          waiters.splice(i, 1);
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("ws connect failed")), { once: true });
    });
    return {
      waitFor(type) {
        const found = frames.find((f) => f.type === type);
        if (found) return Promise.resolve(found.payload);
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          waiters.push({ type, resolve });
          const timer = setTimeout(() => reject(new Error(`timed out waiting for "${type}"`)), 5000);
          timer.unref();
        });
      },
    };
  }

  it("broadcasts connector.detected on the detect sweep", async () => {
    const app = await testApp();
    const port = await listen(app);
    const client = await connect(port);
    await client.waitFor("hello");
    await app.inject({ method: "GET", url: "/api/connectors/detect" });
    const detected = await client.waitFor("connector.detected");
    expect(typeof detected["connectorId"]).toBe("string");
    expect(typeof detected["installed"]).toBe("boolean");
  });

  it("broadcasts source.status when the status view is polled", async () => {
    const sources = buildSourceRegistry({ fetchImpl: fixtureFetch });
    const app = await testApp({ sources });
    const port = await listen(app);
    const client = await connect(port);
    await client.waitFor("hello");
    await app.inject({ method: "GET", url: "/api/sources/status" });
    const status = await client.waitFor("source.status");
    expect(typeof status["id"]).toBe("string");
    expect(typeof status["up"]).toBe("boolean");
  });
});
