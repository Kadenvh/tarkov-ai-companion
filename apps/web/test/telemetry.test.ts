import { describe, expect, it } from "vitest";
import { readTelemetryHistory, readTelemetrySample } from "../src/lib/normalize";

describe("readTelemetrySample", () => {
  it("reads a system-only sample (no GPU)", () => {
    const s = readTelemetrySample({
      ts: 1_700_000_000_000,
      system: { cpuPct: 42, memUsedMiB: 8192, memTotalMiB: 32768 },
    });
    expect(s).not.toBeNull();
    expect(s!.system.cpuPct).toBe(42);
    expect(s!.gpu).toBeUndefined();
  });

  it("reads a full sample with a GPU block", () => {
    const s = readTelemetrySample({
      ts: 1_700_000_000_000,
      system: { cpuPct: 30, memUsedMiB: 4096, memTotalMiB: 16384 },
      gpu: { utilPct: 88, memUsedMiB: 6000, memTotalMiB: 8192, coreClockMhz: 1900, tempC: 71, powerW: 220 },
    });
    expect(s!.gpu).toEqual({
      utilPct: 88,
      memUsedMiB: 6000,
      memTotalMiB: 8192,
      coreClockMhz: 1900,
      tempC: 71,
      powerW: 220,
    });
  });

  it("returns null when cpu is absent (unusable sample)", () => {
    expect(readTelemetrySample({ ts: 1, system: {} })).toBeNull();
    expect(readTelemetrySample(null)).toBeNull();
    expect(readTelemetrySample("nope")).toBeNull();
  });

  it("coerces an ISO-string timestamp to epoch-ms", () => {
    const s = readTelemetrySample({
      ts: "2026-07-19T12:00:00.000Z",
      system: { cpuPct: 10, memUsedMiB: 1, memTotalMiB: 2 },
    });
    expect(s!.ts).toBe(Date.parse("2026-07-19T12:00:00.000Z"));
  });

  it("scales an epoch-seconds timestamp up to ms", () => {
    const s = readTelemetrySample({
      ts: 1_700_000_000,
      system: { cpuPct: 10, memUsedMiB: 1, memTotalMiB: 2 },
    });
    expect(s!.ts).toBe(1_700_000_000_000);
  });

  it("drops a partial/garbage gpu block but keeps the system sample", () => {
    const s = readTelemetrySample({
      ts: 1,
      system: { cpuPct: 20, memUsedMiB: 1, memTotalMiB: 2 },
      gpu: { tempC: 60 }, // no utilPct -> gpu ignored
    });
    expect(s!.gpu).toBeUndefined();
    expect(s!.system.cpuPct).toBe(20);
  });

  it("accepts flattened alias keys (cpu / memUsed / util / temp)", () => {
    const s = readTelemetrySample({
      timestamp: 1,
      cpu: 55,
      memUsed: 100,
      memTotal: 200,
      gpu: { util: 40, temp: 65, power: 120 },
    });
    expect(s!.system.cpuPct).toBe(55);
    expect(s!.system.memUsedMiB).toBe(100);
    expect(s!.gpu?.utilPct).toBe(40);
    expect(s!.gpu?.tempC).toBe(65);
  });
});

describe("readTelemetryHistory", () => {
  it("reads { samples, intervalMs } and sorts ascending by ts", () => {
    const h = readTelemetryHistory({
      intervalMs: 500,
      samples: [
        { ts: 3, system: { cpuPct: 1, memUsedMiB: 1, memTotalMiB: 2 } },
        { ts: 1, system: { cpuPct: 2, memUsedMiB: 1, memTotalMiB: 2 } },
        { ts: 2, system: { cpuPct: 3, memUsedMiB: 1, memTotalMiB: 2 } },
      ],
    });
    expect(h.intervalMs).toBe(500);
    expect(h.samples.map((s) => s.ts)).toEqual([1, 2, 3]);
  });

  it("accepts a bare array and defaults intervalMs", () => {
    const h = readTelemetryHistory([
      { ts: 1, system: { cpuPct: 2, memUsedMiB: 1, memTotalMiB: 2 } },
    ]);
    expect(h.samples).toHaveLength(1);
    expect(h.intervalMs).toBe(1000);
  });

  it("drops unusable rows and never throws on junk", () => {
    const h = readTelemetryHistory({ samples: [null, { nope: true }, "x"] });
    expect(h.samples).toEqual([]);
  });
});
