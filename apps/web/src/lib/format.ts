/** Display formatting helpers — locale pinned to en-US for stable output. */

export function fmtRubles(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `₽${Math.round(n).toLocaleString("en-US")}`;
}

export function fmtNumber(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

export function fmtPct(rate: number | null | undefined): string {
  if (rate == null || Number.isNaN(rate)) return "—";
  return `${Math.round(rate * 100)}%`;
}

export function fmtMinutes(min: number | null | undefined): string {
  if (min == null || Number.isNaN(min)) return "—";
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} h` : `${h} h ${rem} min`;
}

export function fmtSeconds(sec: number | null | undefined): string {
  if (sec == null || Number.isNaN(sec)) return "—";
  if (sec < 90) return `${Math.round(sec)} s`;
  return fmtMinutes(sec / 60);
}

/** "just now" / "42s ago" / "5m ago" / "2h ago" — for freshness indicators. */
export function timeAgo(thenMs: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, nowMs - thenMs);
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** Hour label for a 0-23 wall-clock hour. */
export function fmtHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}
