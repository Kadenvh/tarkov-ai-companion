/**
 * Pure chart geometry — scales, tick math, SVG path builders, binning, layout.
 * Zero React / DOM so every helper is unit-testable in node. All the SVG
 * components in this folder are thin renderers over these functions.
 */

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

/** A linear scale mapping a data domain onto a pixel range. */
export function linScale(
  d0: number,
  d1: number,
  r0: number,
  r1: number,
): (v: number) => number {
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** Min/max of the finite values, ignoring null/undefined/NaN. Null when empty. */
export function extent(values: readonly (number | null | undefined)[]): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min === Infinity ? null : [min, max];
}

/**
 * Pad a [min,max] domain into a "nice" one. `baselineZero` anchors the low end
 * to 0 (bars, percentages); `padFrac` adds headroom above the max.
 */
export function niceDomain(
  min: number,
  max: number,
  opts: { baselineZero?: boolean; padFrac?: number } = {},
): [number, number] {
  const { baselineZero = false, padFrac = 0.05 } = opts;
  let lo = baselineZero ? Math.min(0, min) : min;
  let hi = max;
  if (lo === hi) {
    // flat series — open a symmetric window so a horizontal line sits mid-panel
    const pad = Math.abs(hi) * 0.1 || 1;
    return [baselineZero ? 0 : lo - pad, hi + pad];
  }
  const pad = (hi - lo) * padFrac;
  hi += pad;
  if (!baselineZero) lo -= pad;
  return [lo, hi];
}

function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range));
  const frac = range / Math.pow(10, exp);
  let nf: number;
  if (round) {
    nf = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  } else {
    nf = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  }
  return nf * Math.pow(10, exp);
}

/** Evenly spaced "nice" tick values covering [min,max]. */
export function niceTicks(min: number, max: number, maxTicks = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return Number.isFinite(min) ? [min] : [];
  }
  if (min > max) [min, max] = [max, min];
  const range = niceNum(max - min, false);
  const step = niceNum(range / Math.max(1, maxTicks - 1), true);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step * 0.5; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  return ticks;
}

/**
 * Build an SVG polyline `d` from parallel x/y data through pixel scales. Null
 * y-values break the line into separate segments (gaps, never interpolated).
 */
export function buildLinePath(
  xs: readonly number[],
  ys: readonly (number | null | undefined)[],
  sx: (v: number) => number,
  sy: (v: number) => number,
): string {
  let d = "";
  let pen = false;
  for (let i = 0; i < xs.length; i++) {
    const y = ys[i];
    const x = xs[i];
    if (y == null || !Number.isFinite(y) || x == null) {
      pen = false;
      continue;
    }
    const X = sx(x).toFixed(2);
    const Y = sy(y).toFixed(2);
    d += `${pen ? "L" : "M"}${X},${Y} `;
    pen = true;
  }
  return d.trim();
}

/** Area fill matching buildLinePath, closed to `baselineY`, per contiguous run. */
export function buildAreaPath(
  xs: readonly number[],
  ys: readonly (number | null | undefined)[],
  sx: (v: number) => number,
  sy: (v: number) => number,
  baselineY: number,
): string {
  let d = "";
  let run: [number, number][] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    d += "M" + run.map(([x, y], i) => `${i === 0 ? "" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
    const first = run[0]!;
    const last = run[run.length - 1]!;
    d += ` L${last[0].toFixed(2)},${baselineY.toFixed(2)} L${first[0].toFixed(2)},${baselineY.toFixed(2)} Z `;
    run = [];
  };
  for (let i = 0; i < xs.length; i++) {
    const y = ys[i];
    const x = xs[i];
    if (y == null || !Number.isFinite(y) || x == null) {
      flush();
      continue;
    }
    run.push([sx(x), sy(y)]);
  }
  flush();
  return d.trim();
}

/** Band layout for N categorical bars across `width` px, with a gap between bars. */
export function barBand(
  count: number,
  width: number,
  gap = 2,
): { step: number; bandWidth: number; xOf: (i: number) => number } {
  if (count <= 0) return { step: 0, bandWidth: 0, xOf: () => 0 };
  const step = width / count;
  const bandWidth = Math.max(1, step - gap);
  return { step, bandWidth, xOf: (i: number) => i * step + (step - bandWidth) / 2 };
}

/** SVG path for a bar with a rounded top edge, anchored on a flat bottom. */
export function roundedTopBar(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  if (rr <= 0.01) return `M${x},${y} h${w} v${h} h${-w} Z`;
  return (
    `M${x},${(y + h).toFixed(2)} ` +
    `L${x},${(y + rr).toFixed(2)} ` +
    `Q${x},${y} ${(x + rr).toFixed(2)},${y} ` +
    `L${(x + w - rr).toFixed(2)},${y} ` +
    `Q${(x + w).toFixed(2)},${y} ${(x + w).toFixed(2)},${(y + rr).toFixed(2)} ` +
    `L${(x + w).toFixed(2)},${(y + h).toFixed(2)} Z`
  );
}

export interface HistogramBin {
  x0: number;
  x1: number;
  count: number;
}

/** Bucket raw values into `binCount` equal-width bins over [min,max] (or `domain`). */
export function histogram(
  values: readonly number[],
  binCount = 12,
  domain?: [number, number],
): HistogramBin[] {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0 || binCount <= 0) return [];
  let [lo, hi] = domain ?? [Math.min(...clean), Math.max(...clean)];
  if (lo === hi) hi = lo + 1;
  const width = (hi - lo) / binCount;
  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, i) => ({
    x0: lo + i * width,
    x1: lo + (i + 1) * width,
    count: 0,
  }));
  for (const v of clean) {
    if (v < lo || v > hi) continue;
    let idx = Math.floor((v - lo) / width);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    bins[idx]!.count++;
  }
  return bins;
}

/** Index of the datum whose x is closest to `target` (for crosshair snapping). */
export function nearestIndex(xs: readonly number[], target: number): number {
  if (xs.length === 0) return -1;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const d = Math.abs(xs[i]! - target);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Compact numeric label for a crowded axis: 1_200_000 -> "1.2M", 3400 -> "3.4k". */
export function compactNum(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(v));
}

/** Percent change from `prev` to `curr` in [−1,∞); null when prev is 0/absent. */
export function pctDelta(curr: number | null | undefined, prev: number | null | undefined): number | null {
  if (curr == null || prev == null || !Number.isFinite(curr) || !Number.isFinite(prev) || prev === 0) {
    return null;
  }
  return (curr - prev) / Math.abs(prev);
}
