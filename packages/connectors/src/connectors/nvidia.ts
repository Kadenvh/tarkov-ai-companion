/**
 * @tier T0 (queries the NVIDIA driver via nvidia-smi, a read-only telemetry CLI;
 * zero contact with EFT files or process). The connector re-expression of M6.2
 * (@tac/environment nvidia), behavior unchanged.
 *
 * NVIDIA connector, vendor adapter. Satisfies TWO capabilities:
 *
 *   • `gpu-3d-profile` — the *intended* per-application DRS profile for
 *     EscapeFromTarkov.exe. READ-ONLY in this slice: we surface the driver-
 *     surface recommendations (Reflex, power mode, VSync…) that belong in the
 *     per-app 3D profile, plus where that profile persists on disk. We do NOT
 *     parse `nvdrsdb*.bin` (that needs NVAPI/NvAPI_DRS_*), and we do NOT write —
 *     the reversible DRS apply is deferred to M9.5.
 *   • `perf-telemetry` — live GPU util / VRAM / clocks / temps / power via a
 *     second nvidia-smi query.
 *
 * WRAPS `@tac/environment`'s `detectGpu` / `nvidiaReport` (M6.2) rather than
 * reimplementing GPU detection or the recommendation catalogue. The one thing
 * environment does not provide is a live telemetry query, so `perf-telemetry`
 * runs its own small `--query-gpu` through the SAME injected `NvidiaSmiRunner`
 * (so tests never shell out).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  detectGpu,
  nvidiaReport,
  type GpuInfo,
  type NvidiaRecommendation,
  type NvidiaSmiRunner,
} from "@tac/environment";
import type { Capability } from "../capabilities.js";
import {
  hashData,
  makeReading,
  systemClock,
  type Clock,
  type Connector,
  type ConnectorReading,
  type DetectResult,
  type HealthStatus,
} from "../connector.js";

const ID = "nvidia";
const GPU_3D_PROFILE: Capability = "gpu-3d-profile";
const PERF_TELEMETRY: Capability = "perf-telemetry";

const execFileAsync = promisify(execFile);

/**
 * Default nvidia-smi transport for the live telemetry query — the one thing
 * @tac/environment does not already provide a runner for. Mirrors environment's
 * private runner (read-only CLI, windowsHide). Tests always inject `smiRunner`,
 * so this never runs under test.
 */
const defaultSmiRunner: NvidiaSmiRunner = async (args) => {
  const { stdout } = await execFileAsync("nvidia-smi", args, { windowsHide: true });
  return stdout;
};

/** The per-app DRS profile this connector targets (research/06 §4). */
const TARGET_APP = "EscapeFromTarkov.exe";

/**
 * Where "Manage 3D Settings" persists (research/06 §4): the Driver Settings
 * profile DB. Read-only reference here — surfaced in the reading so the UI can
 * point the user at it; the actual read/write goes through NVAPI in M9.5.
 * Overridable via the factory `drsPath` option.
 */
export function defaultDrsStorePath(): string {
  const programData = process.env["PROGRAMDATA"] ?? "C:\\ProgramData";
  return `${programData}\\NVIDIA Corporation\\Drs`;
}

/** Live GPU telemetry snapshot (perf-telemetry). `null` fields when a value is unparseable. */
export interface NvidiaTelemetry {
  /** GPU core utilization, %. */
  gpuUtilPct: number;
  /** Memory-controller utilization, %. */
  memUtilPct: number;
  /** VRAM in use, MiB. */
  vramUsedMiB: number;
  /** Total VRAM, MiB. */
  vramTotalMiB: number;
  /** Graphics (core) clock, MHz. */
  coreClockMhz: number;
  /** Memory clock, MHz. */
  memClockMhz: number;
  /** GPU temperature, °C. */
  tempC: number;
  /** Board power draw, W. */
  powerW: number;
}

/** perf-telemetry reading payload. */
export interface NvidiaPerfTelemetry {
  gpu: GpuInfo | null;
  telemetry: NvidiaTelemetry | null;
}

/** gpu-3d-profile reading payload — the *intended* per-app DRS profile (advisory, read-only). */
export interface NvidiaGpu3dProfile {
  /** Executable the per-app 3D profile is keyed to. */
  targetApp: string;
  /** On-disk location of the DRS profile DB (reference; not parsed in this slice). */
  drsStorePath: string;
  gpu: GpuInfo | null;
  /**
   * Recommended per-app profile settings (the `surface: "driver"` slice of the
   * M6.2 recommendation catalogue). These are what M9.5 will write into the DRS
   * profile; here they are advisory only.
   */
  profile: NvidiaRecommendation[];
}

/**
 * The telemetry query column order (exported for the test that authors CSV).
 * nvidia-smi `--format=csv,noheader,nounits` emits values in this order.
 */
export const NVIDIA_TELEMETRY_QUERY = [
  "utilization.gpu",
  "utilization.memory",
  "memory.used",
  "memory.total",
  "clocks.gr",
  "clocks.mem",
  "temperature.gpu",
  "power.draw",
] as const;

/** Parse one line of the telemetry `--query-gpu` CSV (exported for tests). */
export function parseTelemetryCsv(stdout: string): NvidiaTelemetry | null {
  const line = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!line) return null;
  const cols = line.split(",").map((s) => s.trim());
  if (cols.length < NVIDIA_TELEMETRY_QUERY.length) return null;
  const num = (i: number): number => {
    const v = Number.parseFloat(cols[i] ?? "");
    return Number.isFinite(v) ? v : 0;
  };
  return {
    gpuUtilPct: num(0),
    memUtilPct: num(1),
    vramUsedMiB: num(2),
    vramTotalMiB: num(3),
    coreClockMhz: num(4),
    memClockMhz: num(5),
    tempC: num(6),
    powerW: num(7),
  };
}

export interface NvidiaConnectorOptions {
  /** Injectable nvidia-smi runner (tests pass a fake; defaults to shelling out). */
  smiRunner?: NvidiaSmiRunner;
  /** Override the DRS profile-DB path surfaced in the gpu-3d-profile reading. */
  drsPath?: string;
  /** Injectable clock for deterministic `capturedAt`. */
  clock?: Clock;
}

/**
 * Build the NVIDIA connector. It advertises both `gpu-3d-profile` and
 * `perf-telemetry`; `read` dispatches on the requested capability.
 */
export function createNvidiaConnector(opts: NvidiaConnectorOptions = {}): Connector {
  const clock = opts.clock ?? systemClock;
  const runner = opts.smiRunner ?? defaultSmiRunner;
  const drsStorePath = (): string => opts.drsPath ?? defaultDrsStorePath();

  async function readGpu3dProfile(): Promise<ConnectorReading<NvidiaGpu3dProfile>> {
    const report = await nvidiaReport(runner);
    const data: NvidiaGpu3dProfile = {
      targetApp: TARGET_APP,
      drsStorePath: drsStorePath(),
      gpu: report.gpu,
      profile: report.recommendations.filter((r) => r.surface === "driver"),
    };
    return makeReading(
      {
        connectorId: ID,
        capability: GPU_3D_PROFILE,
        data,
        ...(report.gpu ? { gameVersion: report.gpu.driverVersion } : {}),
        settingsHash: hashData(data.profile),
      },
      clock,
    );
  }

  async function readPerfTelemetry(): Promise<ConnectorReading<NvidiaPerfTelemetry>> {
    const gpu = await detectGpu(runner);
    let telemetry: NvidiaTelemetry | null = null;
    try {
      const stdout = await runner([
        `--query-gpu=${NVIDIA_TELEMETRY_QUERY.join(",")}`,
        "--format=csv,noheader,nounits",
      ]);
      telemetry = parseTelemetryCsv(stdout);
    } catch {
      telemetry = null;
    }
    const data: NvidiaPerfTelemetry = { gpu, telemetry };
    return makeReading(
      {
        connectorId: ID,
        capability: PERF_TELEMETRY,
        data,
        ...(gpu ? { gameVersion: gpu.driverVersion } : {}),
        settingsHash: hashData(data),
      },
      clock,
    );
  }

  return {
    id: ID,
    vendor: "NVIDIA (nvidia-smi / NVAPI adapter)",
    capabilities: [GPU_3D_PROFILE, PERF_TELEMETRY],
    riskTier: "T0",

    async detect(): Promise<DetectResult> {
      const gpu = await detectGpu(runner);
      if (!gpu) return { installed: false };
      return { installed: true, configPath: drsStorePath(), version: gpu.driverVersion };
    },

    async read(cap: Capability): Promise<ConnectorReading> {
      if (cap === GPU_3D_PROFILE) return readGpu3dProfile();
      if (cap === PERF_TELEMETRY) return readPerfTelemetry();
      throw new Error(`Connector "${ID}" cannot read capability "${cap}".`);
    },

    async health(): Promise<HealthStatus> {
      const gpu = await detectGpu(runner);
      return gpu ? "connected" : "missing";
    },
  };
}

/** Default instance against the real nvidia-smi / DRS store. */
export const nvidiaConnector = createNvidiaConnector();
