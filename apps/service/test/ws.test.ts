import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { closeApps, testApp } from "./helpers.js";

/**
 * Real-socket tests: the app listens on an ephemeral port and a global
 * WebSocket (Node >= 22, CONTRACTS §2) connects to /ws.
 */

interface Frame {
  type: string;
  payload: Record<string, unknown>;
  ts: string;
}

interface WsClient {
  ws: WebSocket;
  frames: Frame[];
  waitFor: (type: string, timeoutMs?: number) => Promise<Frame>;
  close: () => void;
}

const openClients: WsClient[] = [];

async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("no ephemeral port");
  return address.port;
}

async function connect(port: number): Promise<WsClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: Frame[] = [];
  const waiters: { type: string; resolve: (f: Frame) => void }[] = [];
  ws.addEventListener("message", (ev) => {
    const frame = JSON.parse(String(ev.data)) as Frame;
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.type === frame.type) {
        waiters[i]!.resolve(frame);
        waiters.splice(i, 1);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws connect failed")), { once: true });
  });
  const client: WsClient = {
    ws,
    frames,
    waitFor(type, timeoutMs = 5000) {
      const existing = frames.find((f) => f.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise<Frame>((resolve, reject) => {
        waiters.push({ type, resolve });
        const timer = setTimeout(() => reject(new Error(`timed out waiting for "${type}" frame`)), timeoutMs);
        timer.unref();
      });
    },
    close() {
      ws.close();
    },
  };
  openClients.push(client);
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("/ws hub (CONTRACTS §5.3)", () => {
  afterEach(async () => {
    for (const c of openClients.splice(0)) c.close();
    await closeApps();
  });

  it("sends a hello frame carrying the active profileKey on connect", async () => {
    const app = await testApp();
    const client = await connect(await listen(app));
    const hello = await client.waitFor("hello");
    expect(hello.payload).toEqual({ profileKey: "main-regular" });
    expect(typeof hello.ts).toBe("string");
  });

  it("bridges state-engine emitter events and notices to every client (§3 names verbatim)", async () => {
    const app = await testApp();
    const port = await listen(app);
    const a = await connect(port);
    const b = await connect(port);
    await a.waitFor("hello");
    await b.waitFor("hello");

    // engine event via the store emitter
    app.tac.store.setLevel(9);
    const changed = await a.waitFor("state.changed");
    expect(changed.payload["reason"]).toBe("level");
    await b.waitFor("state.changed");

    // domain event forwarded verbatim
    app.tac.store.events.emit("raid.started", { sid: "s1", map: "bigmap", mode: "regular", ts: "t" });
    const started = await a.waitFor("raid.started");
    expect(started.payload).toEqual({ sid: "s1", map: "bigmap", mode: "regular", ts: "t" });

    // notice via POST /api/notify reaches both clients
    await app.inject({ method: "POST", url: "/api/notify", payload: { title: "T", body: "B" } });
    expect((await a.waitFor("notice")).payload).toEqual({ title: "T", body: "B" });
    expect((await b.waitFor("notice")).payload).toEqual({ title: "T", body: "B" });
    // ws-connected clients show up in the metrics counter (M5.6)
    expect(app.tac.metrics.snapshot().session.wsClients).toBe(2);
  });

  it("debounces state churn into a single plan.updated broadcast", async () => {
    const app = await testApp({ planDebounceMs: 120 });
    const client = await connect(await listen(app));
    await client.waitFor("hello");

    // two rapid goal changes -> one debounced rebuild -> one plan.updated
    await app.inject({ method: "POST", url: "/api/goals", payload: { goals: [{ type: "lightkeeper" }] } });
    await app.inject({
      method: "POST",
      url: "/api/goals",
      payload: { goals: [{ type: "kappa" }, { type: "level", level: 20 }] },
    });

    const updated = await client.waitFor("plan.updated", 8000);
    expect(updated.payload["hash"]).toMatch(/^[0-9a-f]{16}$/);
    expect(updated.payload["raids"]).toBeGreaterThan(0);

    await sleep(400); // longer than the debounce window: no second rebuild may fire
    expect(client.frames.filter((f) => f.type === "plan.updated")).toHaveLength(1);

    // the rebuilt plan reflects the LAST write, not the first
    const goals = (await app.inject({ method: "GET", url: "/api/goals" })).json();
    expect(goals.goals).toEqual([{ type: "kappa" }, { type: "level", level: 20 }]);
  }, 15_000);

  it("still broadcasts plan.updated when a GET /api/plan lands inside the debounce window", async () => {
    const app = await testApp({ planDebounceMs: 250 });
    const client = await connect(await listen(app));
    await client.waitFor("hello");

    // a client has already viewed the plan -> baseline hash is seeded
    const before = (await app.inject({ method: "GET", url: "/api/plan" })).json();

    // real plan change, then an immediate refetch INSIDE the debounce window
    // (exactly what the web app does after POST /api/goals, and what the
    // agent's get_plan tool does during quest.changed churn). The mid-window
    // read must not mark the fresh hash as "seen" and suppress the broadcast
    // to every OTHER connected client.
    await app.inject({ method: "POST", url: "/api/goals", payload: { goals: [{ type: "lightkeeper" }] } });
    const mid = (await app.inject({ method: "GET", url: "/api/plan" })).json();
    expect(mid.hash).not.toBe(before.hash); // the change was real

    const updated = await client.waitFor("plan.updated", 8000);
    expect(updated.payload["hash"]).toBe(mid.hash);

    // and the pipeline settles: no duplicate broadcast after the window closes
    await sleep(600);
    expect(client.frames.filter((f) => f.type === "plan.updated")).toHaveLength(1);
  }, 15_000);

  it("patch sentinel broadcasts a notice on patch.detected (M8.2)", async () => {
    const app = await testApp();
    const client = await connect(await listen(app));
    await client.waitFor("hello");
    app.tac.store.events.emit("patch.detected", { version: "1.0.7.99999", ts: "t" });
    const notice = await client.waitFor("notice");
    expect(notice.payload["title"]).toBe("Game patch detected");
    expect(String(notice.payload["body"])).toContain("1.0.7.99999");
    // and the health payload flips its flag
    const health = (await app.inject({ method: "GET", url: "/api/health" })).json();
    expect(health.patchDetected).toBe(true);
    expect(health.gameVersion).toBe("1.0.7.99999");
  });
});
