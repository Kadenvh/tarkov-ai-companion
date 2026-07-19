import { describe, it, expect, beforeEach } from "vitest";
import { MonitorEngine, type Submitter } from "../src/engine.js";
import { defaultConfig, type MonitorConfig } from "../src/config.js";
import type { AlertCue } from "../src/types.js";

const START = Date.parse("2026-07-14T10:00:00.000Z");

function frame(type: string, payload: Record<string, unknown>, ts: string): string {
  // Real service frames carry the event ts both inside the payload (CONTRACTS
  // §3) and at the frame top level (§5.3 broadcast time).
  return JSON.stringify({ type, payload: { ...payload, ts }, ts });
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

class StubSubmitter implements Submitter {
  queueCalls: Array<{ mapDevId: string; queueSec: number; type: string; gameMode: string }> = [];
  goonsCalls: Array<{ mapDevId: string; accountId: string | null; gameMode: string }> = [];
  queueTime(input: { mapDevId: string; queueSec: number; type: string; gameMode: string }): void {
    this.queueCalls.push(input);
  }
  goons(input: { mapDevId: string; accountId: string | null; gameMode: string }): void {
    this.goonsCalls.push(input);
  }
}

function makeEngine(overrides: Partial<MonitorConfig> = {}) {
  const config = { ...defaultConfig(), ...overrides };
  let clock = START;
  const submitter = new StubSubmitter();
  const alerts: AlertCue[] = [];
  const engine = new MonitorEngine({ config, submitter, now: () => clock });
  engine.onAlert = (a) => alerts.push(a);
  return {
    engine,
    submitter,
    alerts,
    setNow: (ms: number) => {
      clock = ms;
    },
  };
}

describe("MonitorEngine raid lifecycle", () => {
  let ctx: ReturnType<typeof makeEngine>;
  beforeEach(() => {
    ctx = makeEngine();
  });

  it("walks queued -> confirmed -> in-raid -> idle and tallies the raid", () => {
    const { engine, alerts } = ctx;
    engine.handleMessage(frame("raid.created", { sid: "s1" }, iso(START)));
    expect(engine.snapshot().raid.phase).toBe("queued");

    engine.handleMessage(frame("raid.confirmed", { sid: "s1", map: "bigmap", mode: "regular" }, iso(START + 5_000)));
    let snap = engine.snapshot();
    expect(snap.raid.phase).toBe("confirmed");
    expect(snap.raid.mapName).toBe("Customs");

    ctx.setNow(START + 42_000);
    engine.handleMessage(frame("raid.started", { sid: "s1", map: "bigmap", mode: "regular" }, iso(START + 42_000)));
    snap = engine.snapshot();
    expect(snap.raid.phase).toBe("in-raid");
    expect(snap.raid.queueSec).toBe(42);

    engine.handleMessage(frame("raid.ended", { sid: "s1", map: "bigmap", mode: "regular" }, iso(START + 500_000)));
    snap = engine.snapshot();
    expect(snap.raid.phase).toBe("idle");
    expect(snap.stats.raids).toBe(1);
    expect(snap.stats.byMap["Customs"]).toBe(1);

    const ids = alerts.map((a) => a.id);
    expect(ids).toContain("match-found");
    expect(ids).toContain("raid-start");
    expect(ids).toContain("raid-end");
    // match-created is off by default
    expect(ids).not.toContain("match-created");
  });

  it("fires runthrough-safe exactly once when the threshold is crossed", () => {
    const { engine, alerts, setNow } = ctx;
    const startMs = START + 10_000;
    setNow(startMs);
    engine.handleMessage(frame("raid.started", { sid: "s2", map: "woods", mode: "regular" }, iso(startMs)));

    setNow(startMs + 419_000); // 419s in
    engine.tick();
    expect(alerts.some((a) => a.id === "runthrough-safe")).toBe(false);

    setNow(startMs + 420_000); // threshold
    engine.tick();
    setNow(startMs + 430_000);
    engine.tick();
    expect(alerts.filter((a) => a.id === "runthrough-safe")).toHaveLength(1);
    expect(engine.snapshot().raid.runthrough.met).toBe(true);
  });

  it("counts flea sales and roubles regardless of alert toggle", () => {
    const { engine } = ctx;
    engine.handleMessage(frame("flea.sale", { itemName: "GPU", amount: 500_000 }, iso(START)));
    engine.handleMessage(frame("flea.sale", { itemName: "LEDX", amount: 1_000_000 }, iso(START)));
    const snap = engine.snapshot();
    expect(snap.stats.fleaSales).toBe(2);
    expect(snap.stats.fleaRoubles).toBe(1_500_000);
  });
});

describe("MonitorEngine scav cooldown", () => {
  it("starts, counts down, and fires scav-ready once", () => {
    const ctx = makeEngine({ scavCooldownSec: 100 });
    const { engine, alerts, setNow } = ctx;
    engine.startScav();
    expect(engine.snapshot().scav.active).toBe(true);

    setNow(START + 99_000);
    engine.tick();
    expect(alerts.some((a) => a.id === "scav-ready")).toBe(false);

    setNow(START + 100_000);
    engine.tick();
    setNow(START + 120_000);
    engine.tick();
    expect(alerts.filter((a) => a.id === "scav-ready")).toHaveLength(1);
    expect(engine.snapshot().scav.ready).toBe(true);
  });
});

describe("MonitorEngine tarkov.dev submissions (opt-in)", () => {
  it("does not submit queue time when the opt-in is off", () => {
    const ctx = makeEngine();
    ctx.engine.handleMessage(frame("raid.created", { sid: "s" }, iso(START)));
    ctx.engine.handleMessage(frame("raid.started", { sid: "s", map: "bigmap", mode: "regular" }, iso(START + 30_000)));
    expect(ctx.submitter.queueCalls).toHaveLength(0);
  });

  it("submits queue time on raid start when enabled", () => {
    const ctx = makeEngine({ submitQueueTimes: true });
    ctx.engine.handleMessage(frame("raid.created", { sid: "s" }, iso(START)));
    ctx.engine.handleMessage(frame("raid.started", { sid: "s", map: "bigmap", mode: "regular" }, iso(START + 30_000)));
    expect(ctx.submitter.queueCalls).toEqual([{ mapDevId: "customs", queueSec: 30, type: "pmc", gameMode: "regular" }]);
  });

  it("rejects goons reports when off and submits when enabled with a map", () => {
    const off = makeEngine();
    expect(off.engine.reportGoons("woods").ok).toBe(false);

    const on = makeEngine({ submitGoons: true, accountId: "12345" });
    const res = on.engine.reportGoons("woods");
    expect(res.ok).toBe(true);
    expect(on.submitter.goonsCalls).toEqual([{ mapDevId: "woods", accountId: "12345", gameMode: "regular" }]);
  });
});

describe("MonitorEngine quest alerts", () => {
  it("alerts on completed and failed quests", () => {
    const { engine, alerts } = makeEngine();
    engine.handleMessage(frame("quest.changed", { taskId: "t1", status: "completed" }, iso(START)));
    engine.handleMessage(frame("quest.changed", { taskId: "t2", status: "failed" }, iso(START)));
    const ids = alerts.map((a) => a.id);
    expect(ids).toContain("quest-done");
    expect(ids).toContain("quest-failed");
  });
});
