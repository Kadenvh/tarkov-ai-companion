/**
 * @tier T0 (fully outside the game: queries the NVIDIA driver via nvidia-smi,
 * a read-only telemetry CLI; zero contact with EFT files or process).
 *
 * M6.2, wave 1 = READ-ONLY. GPU/driver detection + recommendation payload.
 * Driver-profile (DRS) *writes* via NVAPI/nvidiaProfileInspector are a later
 * wave — docs/research/06-environment-paths.md §4 records where the DRS store
 * lives and which settings matter; this module only advises.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GpuInfo {
  name: string;
  driverVersion: string;
  vramMiB: number;
}

export type NvidiaSmiRunner = (args: string[]) => Promise<string>;

const defaultRunner: NvidiaSmiRunner = async (args) => {
  const { stdout } = await execFileAsync("nvidia-smi", args, { windowsHide: true });
  return stdout;
};

/** Parse `nvidia-smi --query-gpu=... --format=csv,noheader` output (exported for tests). */
export function parseGpuCsv(stdout: string): GpuInfo | null {
  const line = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!line) return null;
  const [name, driverVersion, memory] = line.split(",").map((s) => s.trim());
  if (!name || !driverVersion) return null;
  const vramMiB = Number.parseInt(memory ?? "", 10);
  return { name, driverVersion, vramMiB: Number.isFinite(vramMiB) ? vramMiB : 0 };
}

/**
 * Detect the primary NVIDIA GPU via nvidia-smi. Returns null when the tool is
 * absent or fails (AMD/Intel machines, CI) — callers must tolerate null.
 */
export async function detectGpu(run: NvidiaSmiRunner = defaultRunner): Promise<GpuInfo | null> {
  try {
    const stdout = await run(["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"]);
    return parseGpuCsv(stdout);
  } catch {
    return null;
  }
}

export interface NvidiaRecommendation {
  /** Where the user flips it: "in-game" (Graphics.ini surface) or "driver" (NVIDIA app / control panel per-game profile). */
  surface: "in-game" | "driver";
  setting: string;
  recommended: string;
  why: string;
}

/**
 * Guidance payload for `/api/environment/nvidia`. Static text grounded in
 * research/06 §4 (EFT-relevant DRS settings) + the community consensus that
 * EFT is CPU-bound, so upscalers help little at 1440p on a 3080-class card
 * while Reflex + max-performance clocks reliably help latency/consistency.
 */
export function nvidiaRecommendations(gpu: GpuInfo | null): NvidiaRecommendation[] {
  const recs: NvidiaRecommendation[] = [
    {
      surface: "in-game",
      setting: "NVIDIA Reflex",
      recommended: "On",
      why: "Cuts render-queue latency in the GPU-bound moments (scopes, Streets). Free win on any RTX/GTX 900+.",
    },
    {
      surface: "driver",
      setting: "Low Latency Mode (per-game profile)",
      recommended: "On (Reflex supersedes it in-game; keep as fallback)",
      why: "When Reflex is active in-game it overrides this; the driver setting covers menus/lobby.",
    },
    {
      surface: "driver",
      setting: "Power management mode",
      recommended: "Prefer maximum performance",
      why: "Stops clock down-shifting during CPU-bound stretches — steadier frame times in EFT's bursty load.",
    },
    {
      surface: "driver",
      setting: "Vertical Sync",
      recommended: "Off (use in-game frame cap)",
      why: "Driver VSync adds latency; EFT's own GameFramerate cap paces frames without the queue.",
    },
    {
      surface: "driver",
      setting: "Texture filtering - Quality",
      recommended: "High performance",
      why: "Imperceptible in EFT's art style; small shader-cost saving.",
    },
    {
      surface: "driver",
      setting: "Threaded optimization",
      recommended: "Auto",
      why: "Unity already spreads work; forcing it has caused stutter in EFT historically.",
    },
    {
      surface: "driver",
      setting: "Shader cache size",
      recommended: "10 GB+",
      why: "EFT compiles many shaders per map; a large cache kills first-visit stutter after driver updates.",
    },
    {
      surface: "in-game",
      setting: "DLSS",
      recommended: "Off at 1440p (Quality only if GPU-bound at 4K)",
      why: "EFT is CPU-bound on most maps — upscaling buys little and DLSS softens distant players, which costs spotting.",
    },
  ];
  if (gpu) {
    recs.push({
      surface: "driver",
      setting: "Driver version",
      recommended: `Keep current (detected ${gpu.driverVersion}); prefer latest Game Ready before major EFT patches`,
      why: "BSG patches occasionally shift GPU load; Game Ready drivers carry the matching profile updates.",
    });
  }
  return recs;
}

export interface NvidiaReport {
  gpu: GpuInfo | null;
  recommendations: NvidiaRecommendation[];
}

/** One-call payload for the service route. */
export async function nvidiaReport(run: NvidiaSmiRunner = defaultRunner): Promise<NvidiaReport> {
  const gpu = await detectGpu(run);
  return { gpu, recommendations: nvidiaRecommendations(gpu) };
}
