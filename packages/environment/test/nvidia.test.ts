import { describe, expect, it } from "vitest";
import { parseGpuCsv, detectGpu, nvidiaRecommendations, nvidiaReport } from "../src/nvidia.js";

describe("parseGpuCsv", () => {
  it("parses nvidia-smi csv,noheader,nounits output", () => {
    const gpu = parseGpuCsv("NVIDIA GeForce RTX 3080, 610.62, 10240\n");
    expect(gpu).toEqual({ name: "NVIDIA GeForce RTX 3080", driverVersion: "610.62", vramMiB: 10240 });
  });

  it("returns null on empty/garbage output and tolerates missing memory", () => {
    expect(parseGpuCsv("")).toBeNull();
    expect(parseGpuCsv("\n\n")).toBeNull();
    expect(parseGpuCsv("only-a-name")).toBeNull();
    expect(parseGpuCsv("RTX 3080, 610.62, not-a-number")?.vramMiB).toBe(0);
  });
});

describe("detectGpu", () => {
  it("uses the injected runner", async () => {
    const gpu = await detectGpu(async () => "NVIDIA GeForce RTX 3080, 610.62, 10240\n");
    expect(gpu?.name).toContain("3080");
  });

  it("returns null when nvidia-smi is absent (runner throws)", async () => {
    const gpu = await detectGpu(async () => {
      throw new Error("ENOENT");
    });
    expect(gpu).toBeNull();
  });
});

describe("recommendations payload", () => {
  it("always includes the core latency/consistency guidance, each with a rationale", () => {
    const recs = nvidiaRecommendations(null);
    const settings = recs.map((r) => r.setting);
    expect(settings).toContain("NVIDIA Reflex");
    expect(settings).toContain("Power management mode");
    expect(settings.some((s) => s.includes("DLSS"))).toBe(true);
    for (const r of recs) {
      expect(["in-game", "driver"]).toContain(r.surface);
      expect(r.why.length).toBeGreaterThan(10);
    }
  });

  it("adds a driver-version line only when a GPU was detected", () => {
    const withGpu = nvidiaRecommendations({ name: "RTX 3080", driverVersion: "610.62", vramMiB: 10240 });
    const without = nvidiaRecommendations(null);
    expect(withGpu.length).toBe(without.length + 1);
    expect(withGpu.at(-1)?.recommended).toContain("610.62");
  });

  it("nvidiaReport tolerates a machine without nvidia-smi", async () => {
    const report = await nvidiaReport(async () => {
      throw new Error("ENOENT");
    });
    expect(report.gpu).toBeNull();
    expect(report.recommendations.length).toBeGreaterThan(0);
  });
});
