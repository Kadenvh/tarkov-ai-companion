import { describe, expect, it } from "vitest";
import type { NvidiaSmiRunner } from "@tac/environment";
import {
  createNvidiaConnector,
  parseTelemetryCsv,
  type NvidiaGpu3dProfile,
  type NvidiaPerfTelemetry,
} from "../src/connectors/nvidia.js";

const FIXED = "2026-01-01T00:00:00.000Z";
const DRS = "C:\\fixture\\Drs";

/** nvidia-smi's `name,driver_version,memory.total` line (what detectGpu parses). */
const GPU_CSV = "GeForce RTX 3080, 610.62, 10240";
/** Telemetry line in NVIDIA_TELEMETRY_QUERY column order. */
const TELEMETRY_CSV = "12, 8, 4096, 10240, 1950, 9500, 62, 210.5";

/**
 * Fake nvidia-smi runner: dispatches on the `--query-gpu=` columns. `absent`
 * simulates a machine with no NVIDIA GPU / nvidia-smi (every call throws).
 */
function fakeRunner(opts: {
  absent?: boolean;
  gpuCsv?: string;
  telemetryCsv?: string;
}): NvidiaSmiRunner {
  return async (args: string[]): Promise<string> => {
    if (opts.absent) throw new Error("nvidia-smi: command not found");
    const query = args.find((a) => a.startsWith("--query-gpu=")) ?? "";
    if (query.includes("utilization.gpu")) return opts.telemetryCsv ?? TELEMETRY_CSV;
    return opts.gpuCsv ?? GPU_CSV;
  };
}

describe("nvidia connector (injected nvidia-smi runner)", () => {
  const present = createNvidiaConnector({
    smiRunner: fakeRunner({}),
    drsPath: DRS,
    clock: () => FIXED,
  });

  it("advertises gpu-3d-profile + perf-telemetry at riskTier T0, read-only", () => {
    expect(present.id).toBe("nvidia");
    expect(present.capabilities).toEqual(["gpu-3d-profile", "perf-telemetry"]);
    expect(present.riskTier).toBe("T0");
    expect(present.write).toBeUndefined();
  });

  it("reads the intended per-app DRS profile (gpu-3d-profile)", async () => {
    const reading = await present.read("gpu-3d-profile");
    expect(reading.connectorId).toBe("nvidia");
    expect(reading.capability).toBe("gpu-3d-profile");
    expect(reading.capturedAt).toBe(FIXED);
    expect(reading.gameVersion).toBe("610.62");
    expect(reading.settingsHash).toMatch(/^[0-9a-f]{16}$/);

    const data = reading.data as NvidiaGpu3dProfile;
    expect(data.targetApp).toBe("EscapeFromTarkov.exe");
    expect(data.drsStorePath).toBe(DRS);
    expect(data.gpu).toEqual({ name: "GeForce RTX 3080", driverVersion: "610.62", vramMiB: 10240 });
    // Every surfaced setting belongs in the driver (DRS) per-app profile.
    expect(data.profile.length).toBeGreaterThan(0);
    expect(data.profile.every((r) => r.surface === "driver")).toBe(true);
    expect(data.profile.some((r) => /Reflex|Low Latency/i.test(r.setting))).toBe(true);
  });

  it("reads live GPU telemetry (perf-telemetry)", async () => {
    const reading = await present.read("perf-telemetry");
    expect(reading.capability).toBe("perf-telemetry");
    expect(reading.capturedAt).toBe(FIXED);
    expect(reading.settingsHash).toMatch(/^[0-9a-f]{16}$/);

    const data = reading.data as NvidiaPerfTelemetry;
    expect(data.gpu?.name).toBe("GeForce RTX 3080");
    expect(data.telemetry).toEqual({
      gpuUtilPct: 12,
      memUtilPct: 8,
      vramUsedMiB: 4096,
      vramTotalMiB: 10240,
      coreClockMhz: 1950,
      memClockMhz: 9500,
      tempC: 62,
      powerW: 210.5,
    });
  });

  it("detect/health report a present GPU", async () => {
    const detect = await present.detect();
    expect(detect).toEqual({ installed: true, configPath: DRS, version: "610.62" });
    expect(await present.health()).toBe("connected");
  });

  it("detect/health report a missing GPU, and reads degrade gracefully", async () => {
    const absent = createNvidiaConnector({
      smiRunner: fakeRunner({ absent: true }),
      drsPath: DRS,
      clock: () => FIXED,
    });
    expect(await absent.detect()).toEqual({ installed: false });
    expect(await absent.health()).toBe("missing");

    // gpu-3d-profile: no gpu, but the advisory profile still resolves.
    const profile = (await absent.read("gpu-3d-profile")).data as NvidiaGpu3dProfile;
    expect(profile.gpu).toBeNull();
    expect(profile.profile.length).toBeGreaterThan(0);

    // perf-telemetry: no gpu, no telemetry (query throws → null).
    const telem = (await absent.read("perf-telemetry")).data as NvidiaPerfTelemetry;
    expect(telem.gpu).toBeNull();
    expect(telem.telemetry).toBeNull();
  });

  it("read rejects a capability the connector does not advertise", async () => {
    await expect(present.read("audio-mix")).rejects.toThrow(/cannot read capability/);
  });
});

describe("parseTelemetryCsv", () => {
  it("parses a full telemetry line", () => {
    expect(parseTelemetryCsv(TELEMETRY_CSV)?.tempC).toBe(62);
  });

  it("returns null for empty / short input", () => {
    expect(parseTelemetryCsv("")).toBeNull();
    expect(parseTelemetryCsv("1, 2, 3")).toBeNull();
  });

  it("coerces unparseable fields to 0", () => {
    const t = parseTelemetryCsv("[N/A], 8, 4096, 10240, 1950, 9500, 62, 210.5");
    expect(t?.gpuUtilPct).toBe(0);
  });
});
