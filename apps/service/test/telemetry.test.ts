import { afterEach, describe, expect, it } from "vitest";
import type { NvidiaSmiRunner } from "@tac/environment";
import {
  TelemetrySampler,
  TelemetryScheduler,
  type OsReader,
  type TelemetrySample,
} from "../src/telemetry.js";
import { closeApps, testApp } from "./helpers.js";

/**
 * Live telemetry pipeline (Coach observability). Everything here is driven by an
 * injected `os` reader + a fake nvidia-smi runner and injected timers, so the
 * suite is deterministic and never shells out or touches the real host.
 */

type CpuEntry = OsReader extends { cpus(): infer R } ? (R extends (infer E)[] ? E : never) : never;

/** A one-core `os.cpus()` snapshot with the given tick counters. */
function core(user: number, sys: number, idle: number): CpuEntry {
  return { times: { user, nice: 0, sys, idle, irq: 0 } } as CpuEntry;
}

/** Fake `node:os`: returns successive cpu snapshots (constructor consumes the first). */
function fakeOs(snapshots: CpuEntry[][], memTotal: number, memFree: number): OsReader {
  let i = 0;
  return {
    cpus: () => snapshots[Math.min(i++, snapshots.length - 1)]!,
    totalmem: () => memTotal,
    freemem: () => memFree,
  };
}

const GIB = 1024 * 1024 * 1024;

/** nvidia-smi that reports a full GPU: detect CSV + telemetry CSV (query order per the connector). */
const gpuSmi: NvidiaSmiRunner = async (args) => {
  const q = args[0] ?? "";
  if (q.includes("utilization.gpu")) return "45, 30, 4096, 12288, 1900, 9500, 62, 210\n";
  if (q.includes("name")) return "NVIDIA GeForce RTX 3080, 552.44, 12288\n";
  return "";
};

/** nvidia-smi absent (AMD/Intel/CI): every call throws. */
const noGpuSmi: NvidiaSmiRunner = async () => {
  throw new Error("nvidia-smi not found");
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("TelemetrySampler", () => {
  it("builds a system-only sample (gpu omitted) when nvidia-smi is absent", async () => {
    const os = fakeOs(
      [[core(100, 50, 850)], [core(200, 100, 1700)]], // total 1000→2000, idle 850→1700
      16 * GIB,
      8 * GIB,
    );
    const sampler = new TelemetrySampler({ os, smiRunner: noGpuSmi });

    const sample = await sampler.sample();

    expect(sample.gpu).toBeUndefined();
    // idleDelta 850 / totalDelta 1000 → 15% busy.
    expect(sample.system.cpuPct).toBe(15);
    expect(sample.system.memTotalMiB).toBe(16384);
    expect(sample.system.memUsedMiB).toBe(8192);
    expect(typeof sample.ts).toBe("string");
  });

  it("builds a full sample with the GPU slice when nvidia-smi answers", async () => {
    const os = fakeOs([[core(0, 0, 1000)], [core(500, 0, 1500)]], 32 * GIB, 16 * GIB);
    const sampler = new TelemetrySampler({ os, smiRunner: gpuSmi });

    const sample = await sampler.sample();

    // idleDelta 500 / totalDelta 1000 → 50% busy (two-snapshot delta).
    expect(sample.system.cpuPct).toBe(50);
    expect(sample.gpu).toEqual({
      utilPct: 45,
      memUsedMiB: 4096,
      memTotalMiB: 12288,
      coreClockMhz: 1900,
      tempC: 62,
      powerW: 210,
    });
  });

  it("degrades to system-only when the GPU read throws mid-flight", async () => {
    const os = fakeOs([[core(0, 0, 1000)], [core(100, 0, 1900)]], 8 * GIB, 4 * GIB);
    let calls = 0;
    const flakySmi: NvidiaSmiRunner = async (args) => {
      calls += 1;
      if ((args[0] ?? "").includes("name")) return "NVIDIA, 552.44, 8192\n";
      throw new Error("telemetry query failed");
    };
    const sampler = new TelemetrySampler({ os, smiRunner: flakySmi });

    const sample = await sampler.sample();

    expect(calls).toBeGreaterThan(0);
    expect(sample.gpu).toBeUndefined();
    expect(sample.system.cpuPct).toBe(10);
  });
});

// -- scheduler --------------------------------------------------------------

interface Harness {
  interval: (() => void) | null;
  timeout: (() => void) | null;
  opts: {
    setIntervalFn: (fn: () => void) => ReturnType<typeof setInterval>;
    clearIntervalFn: () => void;
    setTimeoutFn: (fn: () => void) => ReturnType<typeof setTimeout>;
    clearTimeoutFn: () => void;
  };
}

function harness(): Harness {
  const h: Harness = {
    interval: null,
    timeout: null,
    opts: {
      setIntervalFn: (fn) => {
        h.interval = fn;
        return { unref() {} } as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {
        h.interval = null;
      },
      setTimeoutFn: (fn) => {
        h.timeout = fn;
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => {
        h.timeout = null;
      },
    },
  };
  return h;
}

let counter = 0;
function fakeSample(): Promise<TelemetrySample> {
  counter += 1;
  return Promise.resolve({
    ts: new Date().toISOString(),
    system: { cpuPct: counter, memUsedMiB: 100, memTotalMiB: 200 },
  });
}

describe("TelemetryScheduler", () => {
  it("samples on tick, buffers, and broadcasts; is stoppable", async () => {
    counter = 0;
    const h = harness();
    const broadcasts: TelemetrySample[] = [];
    const sched = new TelemetryScheduler({
      sample: fakeSample,
      onSample: (s) => broadcasts.push(s),
      ...h.opts,
    });

    sched.retain();
    expect(sched.running).toBe(true);
    expect(typeof h.interval).toBe("function");

    // Drive one interval tick.
    h.interval!();
    await flush();
    expect(sched.size).toBe(1);
    expect(broadcasts).toHaveLength(1);
    expect(sched.latest()?.system.cpuPct).toBe(broadcasts[0]?.system.cpuPct);

    sched.stop();
    expect(sched.running).toBe(false);
    // A tick after stop is a no-op (closed).
    await sched.runOnce();
    expect(sched.size).toBe(1);
  });

  it("caps the ring buffer", async () => {
    counter = 0;
    const h = harness();
    const sched = new TelemetryScheduler({ sample: fakeSample, bufferCap: 3, ...h.opts });
    for (let n = 0; n < 5; n++) await sched.runOnce();
    expect(sched.size).toBe(3);
    expect(sched.latest()?.system.cpuPct).toBe(5); // most recent survives
  });

  it("coalesces overlapping samples (a tick during an in-flight sample is dropped)", async () => {
    const h = harness();
    let resolve!: (s: TelemetrySample) => void;
    const sched = new TelemetryScheduler({
      sample: () => new Promise<TelemetrySample>((r) => (resolve = r)),
      ...h.opts,
    });
    const first = sched.runOnce();
    await sched.runOnce(); // dropped — first is still in flight
    resolve({ ts: new Date().toISOString(), system: { cpuPct: 1, memUsedMiB: 0, memTotalMiB: 0 } });
    await first;
    expect(sched.size).toBe(1);
  });

  it("demand-gates: retain starts the timer, release arms idle-stop, idle stops it", () => {
    const h = harness();
    const sched = new TelemetryScheduler({ sample: fakeSample, ...h.opts });

    expect(sched.running).toBe(false);
    sched.retain();
    expect(sched.running).toBe(true);
    expect(sched.subscriberCount).toBe(1);

    // A subscriber keeps it alive — no idle timer armed while retained.
    sched.release();
    expect(sched.subscriberCount).toBe(0);
    expect(sched.running).toBe(true); // still running until idle fires
    expect(typeof h.timeout).toBe("function");

    // Idle fires → polling stops.
    h.timeout!();
    expect(sched.running).toBe(false);

    // A route touch re-arms the poller and the idle-stop.
    sched.touch();
    expect(sched.running).toBe(true);
    h.timeout!();
    expect(sched.running).toBe(false);
  });

  it("current() triggers + broadcasts a sample when the buffer is empty", async () => {
    counter = 0;
    const h = harness();
    const broadcasts: TelemetrySample[] = [];
    const sched = new TelemetryScheduler({ sample: fakeSample, onSample: (s) => broadcasts.push(s), ...h.opts });

    const sample = await sched.current();
    expect(sample.system.cpuPct).toBe(1);
    expect(sched.size).toBe(1);
    expect(broadcasts).toHaveLength(1);
    // current() touches demand → poller now running.
    expect(sched.running).toBe(true);
  });

  it("history(minutes) filters by the sample timestamp", async () => {
    const h = harness();
    const now = Date.now();
    const samples: TelemetrySample[] = [
      { ts: new Date(now - 10 * 60_000).toISOString(), system: { cpuPct: 1, memUsedMiB: 0, memTotalMiB: 0 } },
      { ts: new Date(now).toISOString(), system: { cpuPct: 2, memUsedMiB: 0, memTotalMiB: 0 } },
    ];
    let i = 0;
    const sched = new TelemetryScheduler({ sample: () => Promise.resolve(samples[i++]!), ...h.opts });
    await sched.runOnce();
    await sched.runOnce();

    expect(sched.history(5)).toHaveLength(1); // only the "now" sample
    expect(sched.history(60)).toHaveLength(2);
  });
});

// -- routes -----------------------------------------------------------------

describe("telemetry routes", () => {
  afterEach(closeApps);

  it("GET /api/telemetry/current returns the contract shape with a GPU slice", async () => {
    const app = await testApp({ nvidiaRunner: gpuSmi });
    const res = await app.inject({ method: "GET", url: "/api/telemetry/current" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as TelemetrySample;
    expect(typeof body.ts).toBe("string");
    expect(typeof body.system.cpuPct).toBe("number");
    expect(body.system.memTotalMiB).toBeGreaterThan(0);
    expect(body.gpu?.utilPct).toBe(45);
    expect(body.gpu?.tempC).toBe(62);
  });

  it("GET /api/telemetry/current omits gpu when no NVIDIA GPU is present", async () => {
    const app = await testApp({ nvidiaRunner: noGpuSmi });
    const res = await app.inject({ method: "GET", url: "/api/telemetry/current" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as TelemetrySample;
    expect(body.gpu).toBeUndefined();
    expect(typeof body.system.cpuPct).toBe("number");
  });

  it("GET /api/telemetry/history returns { samples, intervalMs }", async () => {
    const app = await testApp({ nvidiaRunner: gpuSmi, telemetryIntervalMs: 2000 });
    await app.inject({ method: "GET", url: "/api/telemetry/current" }); // seed one sample
    const res = await app.inject({ method: "GET", url: "/api/telemetry/history?minutes=5" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { samples: TelemetrySample[]; intervalMs: number };
    expect(body.intervalMs).toBe(2000);
    expect(Array.isArray(body.samples)).toBe(true);
    expect(body.samples.length).toBeGreaterThanOrEqual(1);
  });
});
