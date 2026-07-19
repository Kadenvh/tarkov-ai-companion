/**
 * GPU thermal / clock-throttle detection over the live telemetry buffer.
 * Overheating is one of the most common real-world FPS killers: as a GPU passes
 * its thermal limit it drops core clocks to stay safe, silently costing frames.
 * We already sample GPU temp, core clock, and power, so we can flag it.
 *
 * Honest + conservative: temp is the clear signal; a co-occurring core-clock
 * decline strengthens it to a throttle call, otherwise we only warn "running
 * hot". CPU thermals aren't assessable (telemetry has no per-core temp/clock).
 * Pure + deterministic. Mirrors the decoupled web-lib pattern.
 */

import type { TelemetrySample } from "../api/types";

export type ThermalVerdict = "throttling" | "hot" | "ok" | "no-gpu";

export interface ThermalReading {
  verdict: ThermalVerdict;
  maxTempC: number | null;
  medianTempC: number | null;
  /** median core clock over the first vs last third of the window (MHz). */
  clockEarlyMhz: number | null;
  clockLateMhz: number | null;
  samples: number;
  headline: string;
  guidance: string[];
}

/** Sustained temp at/above this reads as "hot" (warn). */
export const HOT_TEMP_C = 80;
/** Temp at/above this, with a clock decline, reads as thermal throttling. */
export const THROTTLE_TEMP_C = 84;
/** Core-clock drop (MHz) across the window that corroborates a throttle. */
export const THROTTLE_CLOCK_DROP_MHZ = 60;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const r0 = (n: number): number => Math.round(n);

export function analyzeThermals(
  samples: TelemetrySample[],
  opts: { window?: number } = {},
): ThermalReading {
  const window = opts.window ?? 60;
  const recent = samples.slice(-window).filter((s) => s.gpu);
  const n = recent.length;

  if (n === 0) {
    return {
      verdict: "no-gpu",
      maxTempC: null,
      medianTempC: null,
      clockEarlyMhz: null,
      clockLateMhz: null,
      samples: 0,
      headline: "No GPU telemetry — thermals unavailable.",
      guidance: [],
    };
  }

  const temps = recent.map((s) => s.gpu!.tempC);
  const maxTempC = r0(Math.max(...temps));
  const medianTempC = r0(median(temps));

  // Compare the first third vs the last third of the window for a clock trend.
  const third = Math.max(1, Math.floor(n / 3));
  const clockEarlyMhz = r0(median(recent.slice(0, third).map((s) => s.gpu!.coreClockMhz)));
  const clockLateMhz = r0(median(recent.slice(-third).map((s) => s.gpu!.coreClockMhz)));
  const clockDropped = clockEarlyMhz - clockLateMhz >= THROTTLE_CLOCK_DROP_MHZ;

  const common = { maxTempC, medianTempC, clockEarlyMhz, clockLateMhz, samples: n };

  if (maxTempC >= THROTTLE_TEMP_C && clockDropped) {
    return {
      ...common,
      verdict: "throttling",
      headline: `GPU thermal throttling — ${maxTempC}°C peak, core clock fell ${clockEarlyMhz}→${clockLateMhz} MHz.`,
      guidance: [
        "The GPU is dropping clocks to stay under its thermal limit — that's lost FPS you can recover for free.",
        "Improve case airflow, raise the GPU fan curve (MSI Afterburner), and clear dust; a mild undervolt keeps clocks high at lower temps.",
        "Lower ambient / room temp and make sure intake isn't blocked.",
      ],
    };
  }

  if (medianTempC >= HOT_TEMP_C || maxTempC >= THROTTLE_TEMP_C) {
    return {
      ...common,
      verdict: "hot",
      headline: `GPU running hot — ${maxTempC}°C peak (median ${medianTempC}°C).`,
      guidance: [
        "No clear clock drop yet, but this is near the throttle point — a longer raid could start costing frames.",
        "A steeper fan curve or better case airflow gives you headroom before it throttles.",
      ],
    };
  }

  return {
    ...common,
    verdict: "ok",
    headline: `GPU thermals healthy — ${maxTempC}°C peak.`,
    guidance: [],
  };
}
