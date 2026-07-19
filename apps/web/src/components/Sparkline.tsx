/** Inline-SVG sparkline (no chart lib) — the smallest chart primitive: a bare
 *  trend line + area with an emphasized latest-point marker, direct-labelled by
 *  its caller's title. Hue selectable from the DS tokens (teal for system/perf,
 *  tan for progression/economy). Pure path builder exported for tests. */

import type { ReactNode } from "react";

export interface SparkPoint {
  label: string;
  value: number;
}

const W = 600;
const H = 64;
const PAD = 4;

/** Pure path builder — exported for tests. */
export function sparklinePath(values: number[], w = W, h = H, pad = PAD): string {
  if (values.length === 0) return "";
  const min = Math.min(...values, 0);
  const max = Math.max(...values);
  const span = max - min || 1;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;
  const step = values.length > 1 ? innerW / (values.length - 1) : 0;
  return values
    .map((v, i) => {
      const x = pad + (values.length > 1 ? i * step : innerW / 2);
      const y = pad + innerH - ((v - min) / span) * innerH;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/** Pixel coordinates of the last point (for the endpoint marker). */
export function sparklineEndpoint(values: number[], w = W, h = H, pad = PAD): { x: number; y: number } | null {
  if (values.length === 0) return null;
  const min = Math.min(...values, 0);
  const max = Math.max(...values);
  const span = max - min || 1;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;
  const step = values.length > 1 ? innerW / (values.length - 1) : 0;
  const i = values.length - 1;
  const x = pad + (values.length > 1 ? i * step : innerW / 2);
  const y = pad + innerH - ((values[i]! - min) / span) * innerH;
  return { x, y };
}

export function Sparkline({
  points,
  title,
  hue = "primary",
}: {
  points: SparkPoint[];
  title?: string;
  hue?: "primary" | "secondary";
}): ReactNode {
  if (points.length === 0) return null;
  const values = points.map((p) => p.value);
  const path = sparklinePath(values);
  const area = `${path} L${W - PAD},${H - PAD} L${PAD},${H - PAD} Z`;
  const end = sparklineEndpoint(values);
  return (
    <svg
      className={`sparkline hue-${hue}`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={title ?? "sparkline"}
    >
      {points.length > 1 ? <path className="area" d={area} /> : null}
      <path className="line" d={path} />
      {end ? <circle className="endpoint" cx={end.x} cy={end.y} r={3} /> : null}
    </svg>
  );
}
