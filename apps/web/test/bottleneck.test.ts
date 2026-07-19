import { describe, expect, it } from "vitest";
import { analyzeBottleneck } from "../src/lib/bottleneck";
import type { TelemetrySample } from "../src/api/types";

function sample(cpuPct: number, gpuUtil: number | null): TelemetrySample {
  const s: TelemetrySample = {
    ts: 0,
    system: { cpuPct, memUsedMiB: 8000, memTotalMiB: 32000 },
  };
  if (gpuUtil !== null) {
    s.gpu = { utilPct: gpuUtil, memUsedMiB: 4000, memTotalMiB: 10000, coreClockMhz: 1800, tempC: 60, powerW: 200 };
  }
  return s;
}

const many = (cpu: number, gpu: number | null, n = 20): TelemetrySample[] =>
  Array.from({ length: n }, () => sample(cpu, gpu));

describe("analyzeBottleneck", () => {
  it("flags GPU-bound when GPU util is pegged", () => {
    const r = analyzeBottleneck(many(50, 98));
    expect(r.verdict).toBe("gpu-bound");
    expect(r.gpuUtilMedian).toBe(98);
    expect(r.confidence).toBe("high");
    expect(r.guidance.join(" ")).toMatch(/resolution|DLSS|SSR/i);
  });

  it("flags CPU-bound when the GPU has headroom while active — the Tarkov default", () => {
    const r = analyzeBottleneck(many(45, 70));
    expect(r.verdict).toBe("cpu-bound");
    expect(r.headline).toMatch(/CPU-bound/);
    expect(r.guidance.join(" ")).toMatch(/physical cores|visibility|RAM/i);
  });

  it("does not let a low aggregate CPU% mask a CPU bottleneck", () => {
    // Only a couple of hot threads → low host CPU%, but GPU idle-ish → still CPU-bound.
    expect(analyzeBottleneck(many(30, 65)).verdict).toBe("cpu-bound");
  });

  it("reports well-matched in the 90–95% band", () => {
    expect(analyzeBottleneck(many(60, 92)).verdict).toBe("well-matched");
  });

  it("reports idle when GPU and CPU are both quiet (menus)", () => {
    expect(analyzeBottleneck(many(10, 8)).verdict).toBe("idle");
  });

  it("reports no-gpu (CPU-side guidance) when telemetry lacks a GPU slice", () => {
    const r = analyzeBottleneck(many(50, null));
    expect(r.verdict).toBe("no-gpu");
    expect(r.gpuUtilMedian).toBeNull();
    expect(r.guidance.join(" ")).toMatch(/nvidia|physical cores/i);
  });

  it("downgrades confidence with few GPU samples and honors the window", () => {
    expect(analyzeBottleneck(many(50, 98, 3)).confidence).toBe("low");
    expect(analyzeBottleneck(many(50, 98, 8)).confidence).toBe("medium");
    // window keeps only the most-recent N (older cpu-bound samples dropped)
    const mixed = [...many(50, 70, 40), ...many(50, 98, 10)];
    expect(analyzeBottleneck(mixed, { window: 10 }).verdict).toBe("gpu-bound");
  });
});
