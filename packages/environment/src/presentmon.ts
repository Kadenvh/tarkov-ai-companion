/**
 * @tier T0 (parses a CSV the USER captured with Intel PresentMon — ETW-based,
 * external to the game; we never bundle, download, or launch capture binaries.
 * See README for how the user runs PresentMon.)
 *
 * M6.3 ingestion: PresentMon CSV -> per-run frame-time summary shaped exactly
 * for the `perf_samples` DDL (CONTRACTS §4), plus a per-map regression
 * detector.
 */

/** Summary stats for one capture/run. Field names match perf_samples columns. */
export interface RunSummary {
  frameCount: number;
  fps_avg: number;
  /** "1% low" FPS, computed as 1000 / p99 frame time (the standard approximation). */
  fps_p1: number;
  frametime_p50: number;
  frametime_p95: number;
  frametime_p99: number;
}

export interface ParseOptions {
  /** Keep only rows whose Application matches (default: EscapeFromTarkov.exe). Pass null to keep all. */
  process?: string | null;
}

const DEFAULT_PROCESS = "EscapeFromTarkov.exe";

/**
 * Parse a PresentMon CSV into frame times (ms). Supports both column layouts:
 *  - PresentMon 1.x: `MsBetweenPresents` (+ `Dropped` flag rows are skipped)
 *  - PresentMon 2.x: `FrameTime`
 * Rows for other processes (dwm.exe etc. when captured without -process_name)
 * are filtered out. Malformed rows are skipped, not fatal.
 */
export function parsePresentMonCsv(text: string, opts: ParseOptions = {}): number[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0];
  if (!header) return [];
  const cols = header.split(",").map((c) => c.trim().toLowerCase());
  const appIdx = cols.indexOf("application");
  const droppedIdx = cols.indexOf("dropped");
  let ftIdx = cols.indexOf("msbetweenpresents"); // v1
  if (ftIdx < 0) ftIdx = cols.indexOf("frametime"); // v2
  if (ftIdx < 0) throw new Error("Not a PresentMon CSV: no MsBetweenPresents/FrameTime column");

  const wantProcess = opts.process === null ? null : (opts.process ?? DEFAULT_PROCESS).toLowerCase();
  const frametimes: number[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    if (wantProcess && appIdx >= 0 && cells[appIdx]?.trim().toLowerCase() !== wantProcess) continue;
    if (droppedIdx >= 0 && cells[droppedIdx]?.trim() === "1") continue;
    const ft = Number.parseFloat(cells[ftIdx] ?? "");
    if (Number.isFinite(ft) && ft > 0) frametimes.push(ft);
  }
  return frametimes;
}

/** Nearest-rank percentile over an unsorted sample. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

export function summarizeRun(frametimesMs: number[]): RunSummary {
  if (frametimesMs.length === 0) {
    return { frameCount: 0, fps_avg: 0, fps_p1: 0, frametime_p50: 0, frametime_p95: 0, frametime_p99: 0 };
  }
  const mean = frametimesMs.reduce((a, b) => a + b, 0) / frametimesMs.length;
  const p99 = percentile(frametimesMs, 99);
  return {
    frameCount: frametimesMs.length,
    fps_avg: 1000 / mean,
    fps_p1: p99 > 0 ? 1000 / p99 : 0,
    frametime_p50: percentile(frametimesMs, 50),
    frametime_p95: percentile(frametimesMs, 95),
    frametime_p99: p99,
  };
}

/** Row shaped for `INSERT INTO perf_samples` (CONTRACTS §4) — state-engine/service does the insert. */
export interface PerfSampleRow {
  raid_id: number | null;
  map: string | null;
  ts: string;
  fps_avg: number;
  fps_p1: number;
  frametime_p50: number;
  frametime_p95: number;
  frametime_p99: number;
  source: "presentmon";
}

export function toPerfSampleRow(
  summary: RunSummary,
  meta: { ts: string; map?: string | null; raidId?: number | null },
): PerfSampleRow {
  return {
    raid_id: meta.raidId ?? null,
    map: meta.map ?? null,
    ts: meta.ts,
    fps_avg: round2(summary.fps_avg),
    fps_p1: round2(summary.fps_p1),
    frametime_p50: round2(summary.frametime_p50),
    frametime_p95: round2(summary.frametime_p95),
    frametime_p99: round2(summary.frametime_p99),
    source: "presentmon",
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface RegressionOptions {
  /** Relative drop that counts as a regression. Default 0.10 (10%). */
  dropPct?: number;
  /** Ignore drops smaller than this many FPS even if past dropPct (noise floor). Default 5. */
  minAbsFpsDrop?: number;
}

export interface RegressionResult {
  regressed: boolean;
  reasons: string[];
}

/**
 * Regression detector (M6.3): compare a run against the per-map baseline
 * (median or mean of prior runs on the same map+patch — the caller aggregates;
 * insights/service owns the SQL).
 *
 * Threshold (documented): a metric regresses when it drops MORE than 10%
 * relative AND more than 5 FPS absolute vs baseline. Both fps_avg and fps_p1
 * are checked — p1 catches "same average, new stutter" regressions, the usual
 * post-patch signature. The 10%/5fps floor keeps run-to-run raid variance
 * (different spawns, PMC density) from spamming alerts.
 */
export function detectRegression(
  run: Pick<RunSummary, "fps_avg" | "fps_p1">,
  baseline: Pick<RunSummary, "fps_avg" | "fps_p1">,
  opts: RegressionOptions = {},
): RegressionResult {
  const dropPct = opts.dropPct ?? 0.1;
  const minAbs = opts.minAbsFpsDrop ?? 5;
  const reasons: string[] = [];
  for (const metric of ["fps_avg", "fps_p1"] as const) {
    const base = baseline[metric];
    const cur = run[metric];
    if (base <= 0) continue;
    const drop = base - cur;
    if (drop > minAbs && drop / base > dropPct) {
      reasons.push(
        `${metric} dropped ${drop.toFixed(1)} FPS (${((drop / base) * 100).toFixed(0)}%) vs baseline ${base.toFixed(1)}`,
      );
    }
  }
  return { regressed: reasons.length > 0, reasons };
}
