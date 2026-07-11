import { afterEach, describe, expect, it } from "vitest";
import { ReplanPipeline } from "../src/replan.js";
import { MockClient } from "../src/model.js";
import { ServiceClient } from "../src/service.js";
import { startStubService, waitFor, type StubService } from "./stub-service.js";

let stub: StubService | null = null;
let pipeline: ReplanPipeline | null = null;

afterEach(async () => {
  pipeline?.stop();
  pipeline = null;
  await stub?.close();
  stub = null;
});

function makePipeline(service: ServiceClient): ReplanPipeline {
  return new ReplanPipeline({
    service,
    client: new MockClient(),
    debounceMs: 30,
    backoffMs: [25, 50],
  });
}

const raidEnded = (sid: string) => ({
  type: "raid.ended",
  payload: { sid, map: "customs", mode: "regular", ts: new Date().toISOString(), durationSec: 1800, outcome: "survived" },
  ts: new Date().toISOString(),
});

describe("event-driven replan pipeline (M4.4)", () => {
  it("raid.ended -> fresh plan -> briefing -> POST /api/notify, end to end", async () => {
    stub = await startStubService();
    const service = new ServiceClient(stub.url);
    pipeline = makePipeline(service);

    const replanned: string[] = [];
    pipeline.onReplanned = (key) => replanned.push(key);
    pipeline.start();
    await waitFor(() => stub!.wsClients.size === 1, 3000, "ws connect");

    const plansBefore = stub.planFetches;
    stub.broadcast(raidEnded("raid-001"));
    await waitFor(() => replanned.length === 1, 3000, "first replan");

    expect(stub.planFetches).toBeGreaterThan(plansBefore); // fresh plan fetched
    expect(stub.notifications).toHaveLength(1);
    expect(stub.notifications[0]!.title).toMatch(/next raid/i);
    // the notification body is the next-raid briefing, grounded in the stub plan
    expect(stub.notifications[0]!.body).toContain("customs");
  });

  it("is idempotent: the same raid end never triggers two replans", async () => {
    stub = await startStubService();
    pipeline = makePipeline(new ServiceClient(stub.url));
    const replanned: string[] = [];
    pipeline.onReplanned = (key) => replanned.push(key);
    pipeline.start();
    await waitFor(() => stub!.wsClients.size === 1, 3000, "ws connect");

    stub.broadcast(raidEnded("raid-dup"));
    stub.broadcast(raidEnded("raid-dup")); // duplicate event (log re-read, ws re-delivery)
    await waitFor(() => replanned.length === 1, 3000, "replan");
    await new Promise((r) => setTimeout(r, 150)); // would fire a second replan if broken
    expect(replanned).toHaveLength(1);
    expect(stub.notifications).toHaveLength(1);
  });

  it("distinct raids each get their own replan + notification", async () => {
    stub = await startStubService();
    pipeline = makePipeline(new ServiceClient(stub.url));
    const replanned: string[] = [];
    pipeline.onReplanned = (key) => replanned.push(key);
    pipeline.start();
    await waitFor(() => stub!.wsClients.size === 1, 3000, "ws connect");

    stub.broadcast(raidEnded("raid-A"));
    await waitFor(() => replanned.length === 1, 3000, "raid A replan");
    stub.broadcast(raidEnded("raid-B"));
    await waitFor(() => replanned.length === 2, 3000, "raid B replan");
    expect(stub.notifications).toHaveLength(2);
    expect(replanned).toEqual(["raid-A", "raid-B"]);
  });

  it("drops the idempotence guard when a replan fails, so a later event can retry", async () => {
    stub = await startStubService({ failFirstNotify: true });
    pipeline = makePipeline(new ServiceClient(stub.url));
    const replanned: string[] = [];
    pipeline.onReplanned = (key) => replanned.push(key);
    pipeline.start();
    await waitFor(() => stub!.wsClients.size === 1, 3000, "ws connect");

    stub.broadcast(raidEnded("raid-flaky"));
    // first attempt fails on /api/notify (stub returns 500 once) -> no notification
    await new Promise((r) => setTimeout(r, 200));
    expect(stub.notifications).toHaveLength(0);

    // the guard was dropped -> the same raid id can be replayed successfully
    stub.broadcast(raidEnded("raid-flaky"));
    await waitFor(() => replanned.length === 1, 3000, "retry replan");
    expect(stub.notifications).toHaveLength(1);
  });

  it("ignores non-raid.ended events entirely", async () => {
    stub = await startStubService();
    pipeline = makePipeline(new ServiceClient(stub.url));
    pipeline.start();
    await waitFor(() => stub!.wsClients.size === 1, 3000, "ws connect");

    stub.broadcast({ type: "quest.changed", payload: { taskId: "t", status: "completed", ts: "now" } });
    stub.broadcast({ type: "state.changed", payload: { reason: "test", ts: "now" } });
    await new Promise((r) => setTimeout(r, 120));
    expect(stub.notifications).toHaveLength(0);
  });
});
