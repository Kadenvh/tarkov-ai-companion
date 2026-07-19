import { describe, expect, it } from "vitest";
import { analyzeThermals } from "../src/lib/thermals";
import type { TelemetrySample } from "../src/api/types";

function s(tempC: number, coreClockMhz: number): TelemetrySample {
  return {
    ts: 0,
    system: { cpuPct: 40, memUsedMiB: 8000, memTotalMiB: 32000 },
    gpu: { utilPct: 98, memUsedMiB: 4000, memTotalMiB: 10000, coreClockMhz, tempC: tempC, powerW: 220 },
  };
}

describe("analyzeThermals", () => {
  it("calls throttling when hot AND core clock drops across the window", () => {
    // early: cool+high clock, late: hot+dropped clock
    const win = [...Array(20)].map((_, i) => (i < 10 ? s(72, 1950) : s(86, 1780)));
    const r = analyzeThermals(win);
    expect(r.verdict).toBe("throttling");
    expect(r.maxTempC).toBe(86);
    expect(r.clockEarlyMhz).toBeGreaterThan(r.clockLateMhz!);
    expect(r.guidance.join(" ")).toMatch(/airflow|fan curve|undervolt/i);
  });

  it("warns 'hot' at high temp without a clear clock drop", () => {
    const r = analyzeThermals([...Array(20)].map(() => s(82, 1900)));
    expect(r.verdict).toBe("hot");
    expect(r.guidance.length).toBeGreaterThan(0);
  });

  it("is ok at healthy temps and emits no guidance noise", () => {
    const r = analyzeThermals([...Array(20)].map(() => s(68, 1950)));
    expect(r.verdict).toBe("ok");
    expect(r.guidance).toEqual([]);
  });

  it("does not throttle-call on a clock drop when temps are fine", () => {
    // clock varies but temp stays cool → not thermal (could be low load)
    const win = [...Array(20)].map((_, i) => (i < 10 ? s(65, 1950) : s(66, 1700)));
    expect(analyzeThermals(win).verdict).toBe("ok");
  });

  it("returns no-gpu without GPU telemetry", () => {
    const noGpu: TelemetrySample = { ts: 0, system: { cpuPct: 40, memUsedMiB: 8000, memTotalMiB: 32000 } };
    const r = analyzeThermals([noGpu, noGpu]);
    expect(r.verdict).toBe("no-gpu");
    expect(r.maxTempC).toBeNull();
  });
});
