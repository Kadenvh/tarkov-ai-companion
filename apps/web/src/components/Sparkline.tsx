/** Inline-SVG sparkline (no chart lib) — used for the flea income curve. */

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

export function Sparkline({ points, title }: { points: SparkPoint[]; title?: string }): ReactNode {
  if (points.length === 0) return null;
  const path = sparklinePath(points.map((p) => p.value));
  const area = `${path} L${W - PAD},${H - PAD} L${PAD},${H - PAD} Z`;
  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={title ?? "sparkline"}
    >
      {points.length > 1 ? <path className="area" d={area} /> : null}
      <path className="line" d={path} />
    </svg>
  );
}
