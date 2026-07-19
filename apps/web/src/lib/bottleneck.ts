/**
 * CPU-vs-GPU bottleneck analysis over the live telemetry buffer — the single
 * most actionable performance read for Tarkov, which is famously CPU-bound.
 *
 * Why GPU utilization is the primary signal (not CPU%): the telemetry CPU% is
 * the HOST aggregate across all logical cores. EFT runs a few hot threads, so
 * on a many-thread CPU a genuine CPU bottleneck still shows only moderate
 * aggregate CPU% — an unreliable classifier. GPU utilization is not fooled:
 * if the GPU has headroom while FPS is limited, the CPU (or a frame cap) is the
 * limiter; if the GPU is pegged, it's GPU-bound. We report CPU% as context but
 * classify on GPU util.
 *
 * Pure + deterministic (caller passes samples). Mirrors the decoupled web lib
 * pattern (no @tac/* imports); the telemetry shape matches api/types.
 */

import type { TelemetrySample } from "../api/types";

export type BottleneckVerdict =
  | "gpu-bound"
  | "cpu-bound"
  | "well-matched"
  | "idle"
  | "no-gpu";

export interface BottleneckReading {
  verdict: BottleneckVerdict;
  /** median GPU utilization % over the window, or null when no GPU telemetry. */
  gpuUtilMedian: number | null;
  /** median host CPU % over the window (context only — see module note). */
  cpuPctMedian: number;
  /** samples considered in the window. */
  samples: number;
  confidence: "high" | "medium" | "low";
  headline: string;
  guidance: string[];
}

/** GPU util at/above this reads as pegged → GPU-bound. */
export const GPU_BOUND_PCT = 95;
/** GPU util below this (with low CPU) reads as idle/menu, not a real workload. */
export const GPU_IDLE_PCT = 20;
/** Below this GPU util while active → the GPU has headroom → CPU-bound. */
export const GPU_HEADROOM_PCT = 90;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const round = (n: number): number => Math.round(n * 10) / 10;

export interface BottleneckOptions {
  /** how many most-recent samples to consider (default 30 ≈ 30 s at 1 Hz). */
  window?: number;
}

export function analyzeBottleneck(
  samples: TelemetrySample[],
  opts: BottleneckOptions = {},
): BottleneckReading {
  const window = opts.window ?? 30;
  const recent = samples.slice(-window);
  const cpuPctMedian = round(median(recent.map((s) => s.system.cpuPct)));
  const gpuVals = recent.filter((s) => s.gpu).map((s) => s.gpu!.utilPct);
  const n = gpuVals.length;

  const confidence: BottleneckReading["confidence"] = n >= 15 ? "high" : n >= 5 ? "medium" : "low";
  const base = { cpuPctMedian, samples: recent.length, confidence };

  // No GPU telemetry at all → can't compare; CPU-side guidance only.
  if (n === 0) {
    return {
      ...base,
      verdict: "no-gpu",
      gpuUtilMedian: null,
      headline: "No GPU telemetry — connect an NVIDIA reading for CPU-vs-GPU analysis.",
      guidance: [
        "GPU-vs-CPU bottleneck detection needs GPU utilization, which comes from the NVIDIA connector (nvidia-smi).",
        "CPU-side wins regardless: enable “Only use physical cores” if your rig advice says so, use faster/low-latency RAM, and close background apps (browser, OBS) on this PC.",
      ],
    };
  }

  const gpuUtilMedian = round(median(gpuVals));

  if (gpuUtilMedian < GPU_IDLE_PCT && cpuPctMedian < 40) {
    return {
      ...base,
      verdict: "idle",
      gpuUtilMedian,
      headline: "Idle / in menus — load into a raid for a live bottleneck read.",
      guidance: ["The GPU is barely working, so this is menu/stash time rather than a real workload."],
    };
  }

  if (gpuUtilMedian >= GPU_BOUND_PCT) {
    return {
      ...base,
      verdict: "gpu-bound",
      gpuUtilMedian,
      headline: `GPU-bound — your GPU is pegged (~${gpuUtilMedian}% util).`,
      guidance: [
        "The GPU is the limiter, so GPU-side settings pay off: lower resolution / render scale, drop texture & shadow quality, turn OFF SSR, and enable DLSS/DLAA if available.",
        "CPU-side settings (physical cores, draw distance) won't raise FPS while the GPU is maxed.",
      ],
    };
  }

  if (gpuUtilMedian < GPU_HEADROOM_PCT) {
    return {
      ...base,
      verdict: "cpu-bound",
      gpuUtilMedian,
      headline: `CPU-bound — GPU has headroom (~${gpuUtilMedian}% util), the CPU is the limiter.`,
      guidance: [
        "Classic Tarkov: raising graphics quality barely costs FPS here, and lowering it barely helps — the CPU sets the ceiling.",
        "Turn on “Only use physical cores” if your rig advice recommends it; lower “Overall visibility” / draw distance and AI-heavy settings, which are CPU cost.",
        "Close CPU-hungry background apps (browser, Discord streams, OBS) on this PC; faster / lower-latency RAM helps a CPU-bound EFT more than a GPU upgrade.",
        `A frame cap or VSync can also idle the GPU — if your FPS is already at a cap, that's expected, not a bottleneck.`,
      ],
    };
  }

  return {
    ...base,
    verdict: "well-matched",
    gpuUtilMedian,
    headline: `Well-matched — GPU (~${gpuUtilMedian}%) and CPU are both near their limit.`,
    guidance: [
      "You're getting about all this hardware will give at these settings.",
      "To gain FPS, drop one GPU setting (resolution/textures) AND one CPU setting (visibility/draw distance) together.",
    ],
  };
}
