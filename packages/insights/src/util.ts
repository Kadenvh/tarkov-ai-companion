/**
 * Shared numeric + timestamp helpers for insights analytics.
 *
 * Timestamps in the profile DB are ISO-8601 TEXT written by @tac/state-engine.
 * Hour-of-day and calendar-day are extracted **lexically** from the string
 * (the wall-clock time as recorded), never via timezone conversion — so the
 * same DB produces the same analytics on any machine. Epoch parsing is used
 * only for *differences* (gaps, session lengths), where the timezone cancels.
 *
 * @tier T0 — pure computation over the app-owned profile SQLite; never
 * touches game files or the game process.
 */

/** Below this sample size a metric is flagged low-confidence (small-n honesty). */
export const LOW_CONFIDENCE_N = 5;

export function lowConfidence(n: number): boolean {
  return n < LOW_CONFIDENCE_N;
}

/** Round to 4 decimals for stable, JSON-friendly numbers. */
export function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Wall-clock hour (0-23) parsed lexically from an ISO-8601 string; null if unparseable. */
export function hourOf(ts: string | null): number | null {
  if (!ts) return null;
  const m = /T(\d{2})/.exec(ts);
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h <= 23 ? h : null;
}

/** Calendar day "YYYY-MM-DD" parsed lexically from an ISO-8601 string; null if unparseable. */
export function dayOf(ts: string | null): string | null {
  if (!ts) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(ts);
  return m ? m[1]! : null;
}

/** Epoch milliseconds (for gap/length arithmetic only); null if unparseable. */
export function epochMs(ts: string | null): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

const DAY_MS = 86_400_000;

/** Monday of the ISO week containing `day` ("YYYY-MM-DD"), as "YYYY-MM-DD". UTC math — deterministic. */
export function isoWeekMonday(day: string): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  const dow = new Date(ms).getUTCDay(); // 0 = Sunday
  const diff = (dow + 6) % 7; // days since Monday
  return new Date(ms - diff * DAY_MS).toISOString().slice(0, 10);
}

/** Next calendar day of a "YYYY-MM-DD" string (UTC math — deterministic). */
export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/** Whole days elapsed from `from` to `to` (both "YYYY-MM-DD"). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}
