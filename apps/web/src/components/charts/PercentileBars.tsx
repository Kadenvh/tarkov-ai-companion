/**
 * PercentileBars — horizontal bars for a small set of same-unit summary values
 * (e.g. FPS avg / 1% low). One hue, one shared x-scale anchored at zero, direct
 * value labels at each bar end (tabular-nums), recessive vertical grid. Because
 * every value shares a unit this stays single-axis; mix different units (FPS vs
 * frametime-ms) across *separate* PercentileBars, never one dual-scale chart.
 */

import type { ReactNode } from "react";
import { linScale, niceDomain, niceTicks } from "./geometry";
import { ChartFrame } from "./ChartFrame";
import { useChartWidth } from "./useChartWidth";

export interface PercentileDatum {
  label: string;
  value: number | null | undefined;
}

export interface PercentileBarsProps {
  data: PercentileDatum[];
  unit?: string;
  hue?: "secondary" | "primary";
  title?: ReactNode;
  format?: (v: number) => string;
  /** emphasize the last bar's endpoint (e.g. the "current" percentile) */
}

const PAD_L = 96;
const PAD_R = 56;
const PAD_T = 8;
const ROW_H = 30;
const BAR_H = 16;

export function PercentileBars({
  data,
  unit,
  hue = "secondary",
  title,
  format = (v) => String(Math.round(v)),
}: PercentileBarsProps): ReactNode {
  const { ref, width: W } = useChartWidth();
  const rows = data.filter((d) => d.value != null && Number.isFinite(d.value)) as {
    label: string;
    value: number;
  }[];

  if (rows.length === 0) {
    return (
      <ChartFrame title={title} caption={unit}>
        <div className="chart-empty">no data</div>
      </ChartFrame>
    );
  }

  const H = PAD_T * 2 + rows.length * ROW_H + 16;
  const innerW = W - PAD_L - PAD_R;
  const maxV = Math.max(...rows.map((r) => r.value), 0);
  const [dLo, dHi] = niceDomain(0, maxV, { baselineZero: true });
  const ticks = niceTicks(dLo, dHi, 4);
  const sx = linScale(dLo, dHi, PAD_L, PAD_L + innerW);
  const x0 = sx(0);

  return (
    <ChartFrame title={title} caption={unit}>
      <div className="chart-wrap" ref={ref}>
      <svg
        className={`chart hue-${hue}`}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={typeof title === "string" ? title : "percentile bars"}
      >
        {ticks.map((t) => {
          const x = sx(t);
          return (
            <g key={t}>
              <line className="grid" x1={x} x2={x} y1={PAD_T} y2={PAD_T + rows.length * ROW_H} />
              <text
                className="axis-x"
                x={x}
                y={PAD_T + rows.length * ROW_H + 12}
                textAnchor="middle"
              >
                {format(t)}
              </text>
            </g>
          );
        })}
        {rows.map((r, i) => {
          const cy = PAD_T + i * ROW_H + ROW_H / 2;
          const w = Math.max(0, sx(r.value) - x0);
          return (
            <g key={`${r.label}-${i}`}>
              <text className="axis-y" x={PAD_L - 8} y={cy} dy="0.32em" textAnchor="end">
                {r.label}
              </text>
              <rect className="bar" x={x0} y={cy - BAR_H / 2} width={w} height={BAR_H} rx={3} />
              <text className="bar-value tnum" x={sx(r.value) + 6} y={cy} dy="0.32em">
                {format(r.value)}
              </text>
            </g>
          );
        })}
      </svg>
      </div>
    </ChartFrame>
  );
}
