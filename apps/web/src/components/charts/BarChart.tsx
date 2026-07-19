/**
 * BarChart — single-series categorical bars, 4px rounded tops anchored to a
 * shared zero baseline, a 2px gap between adjacent bars, and a recessive
 * gridded y-axis. Per-bar hover tooltip. Bars are one hue by default; a per-bar
 * `tone` opts individual bars into a status color, always paired with its label
 * in the tooltip (color is never the only signal).
 */

import { useState, type ReactNode } from "react";
import { barBand, linScale, niceDomain, niceTicks, roundedTopBar } from "./geometry";
import { ChartFrame } from "./ChartFrame";
import { useChartWidth } from "./useChartWidth";

export type BarTone = "default" | "good" | "warn" | "bad";

export interface BarDatum {
  label: string;
  value: number;
  tone?: BarTone;
  /** secondary line in the tooltip (e.g. "n=12") */
  sub?: string;
}

export interface BarChartProps {
  data: BarDatum[];
  hue?: "secondary" | "primary";
  unit?: string;
  title?: ReactNode;
  height?: number;
  format?: (v: number) => string;
  /** show the accessible data-table toggle */
  withTable?: boolean;
}

const PAD_L = 42;
const PAD_R = 10;
const PAD_T = 10;
const PAD_B = 30;

export function BarChart({
  data,
  hue = "secondary",
  unit,
  title,
  height = 200,
  format = (v) => String(Math.round(v)),
  withTable = true,
}: BarChartProps): ReactNode {
  const [hover, setHover] = useState<number | null>(null);
  const { ref, width: W } = useChartWidth();
  const H = height;

  if (data.length === 0) {
    return (
      <ChartFrame title={title} caption={unit}>
        <div className="chart-empty">no data</div>
      </ChartFrame>
    );
  }

  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const maxV = Math.max(...data.map((d) => d.value), 0);
  const [dLo, dHi] = niceDomain(0, maxV, { baselineZero: true });
  const ticks = niceTicks(dLo, dHi, 4);
  const sy = linScale(dLo, dHi, PAD_T + innerH, PAD_T);
  const { bandWidth, xOf } = barBand(data.length, innerW, 2);
  const baseY = sy(0);

  const table = withTable ? (
    <table className="data">
      <thead>
        <tr>
          <th>Category</th>
          <th className="num">Value</th>
        </tr>
      </thead>
      <tbody>
        {data.map((d, i) => (
          <tr key={`${d.label}-${i}`}>
            <td>{d.label}</td>
            <td className="num">
              {format(d.value)}
              {unit ? ` ${unit}` : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  ) : undefined;

  const hovered = hover != null ? data[hover] : null;
  const hoverX = hover != null ? ((PAD_L + xOf(hover) + bandWidth / 2) / W) * 100 : 0;

  return (
    <ChartFrame title={title} caption={unit} table={table}>
      <div className="chart-wrap" ref={ref}>
        <svg
          className={`chart hue-${hue}`}
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          role="img"
          aria-label={typeof title === "string" ? title : "bar chart"}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t) => {
            const y = sy(t);
            return (
              <g key={t}>
                <line className="grid" x1={PAD_L} x2={W - PAD_R} y1={y} y2={y} />
                <text className="axis-y" x={PAD_L - 6} y={y} dy="0.32em" textAnchor="end">
                  {format(t)}
                </text>
              </g>
            );
          })}
          {data.map((d, i) => {
            const x = PAD_L + xOf(i);
            const y = sy(d.value);
            const h = Math.max(0, baseY - y);
            const tone = d.tone && d.tone !== "default" ? ` tone-${d.tone}` : "";
            return (
              <g key={`${d.label}-${i}`}>
                <path className={`bar${tone}`} d={roundedTopBar(x, y, bandWidth, h, 4)} />
                {/* full-height hover target */}
                <rect
                  x={x}
                  y={PAD_T}
                  width={bandWidth}
                  height={innerH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                />
                <text
                  className="axis-x"
                  x={x + bandWidth / 2}
                  y={H - PAD_B + 14}
                  textAnchor="middle"
                >
                  {d.label}
                </text>
              </g>
            );
          })}
        </svg>
        {hovered ? (
          <div
            className="chart-tip"
            style={{ left: `${hoverX}%` }}
            role="status"
          >
            <div className="tip-label">{hovered.label}</div>
            <div className="tip-val tnum">
              {format(hovered.value)}
              {unit ? ` ${unit}` : ""}
            </div>
            {hovered.sub ? <div className="tip-sub">{hovered.sub}</div> : null}
          </div>
        ) : null}
      </div>
    </ChartFrame>
  );
}
