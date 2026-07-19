/**
 * Histogram — distribution of raw values into equal-width bins. Frequency on a
 * single zero-based y-axis, bin ranges on x. One hue, recessive grid, per-bin
 * hover tooltip showing the range + count. Bars sit near-flush (1px gap) so the
 * shape of the distribution reads as one form.
 */

import { useState, type ReactNode } from "react";
import { histogram, linScale, niceDomain, niceTicks } from "./geometry";
import { ChartFrame } from "./ChartFrame";
import { useChartWidth } from "./useChartWidth";

export interface HistogramProps {
  values: number[];
  binCount?: number;
  domain?: [number, number];
  hue?: "secondary" | "primary";
  unit?: string;
  title?: ReactNode;
  height?: number;
  /** format a bin-edge value for the x-axis / tooltip */
  format?: (v: number) => string;
}

const PAD_L = 36;
const PAD_R = 10;
const PAD_T = 10;
const PAD_B = 28;

export function Histogram({
  values,
  binCount = 14,
  domain,
  hue = "secondary",
  unit,
  title,
  height = 180,
  format = (v) => String(Math.round(v)),
}: HistogramProps): ReactNode {
  const [hover, setHover] = useState<number | null>(null);
  const { ref, width: W } = useChartWidth();
  const bins = histogram(values, binCount, domain);
  const H = height;

  if (bins.length === 0 || values.length === 0) {
    return (
      <ChartFrame title={title} caption={unit}>
        <div className="chart-empty">no samples</div>
      </ChartFrame>
    );
  }

  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const maxCount = Math.max(...bins.map((b) => b.count), 1);
  const [dLo, dHi] = niceDomain(0, maxCount, { baselineZero: true });
  const ticks = niceTicks(dLo, dHi, 4);
  const sy = linScale(dLo, dHi, PAD_T + innerH, PAD_T);
  const step = innerW / bins.length;
  const bandW = Math.max(1, step - 1);
  const baseY = sy(0);

  const hovered = hover != null ? bins[hover] : null;
  const hoverX = hover != null ? ((PAD_L + hover * step + step / 2) / W) * 100 : 0;

  return (
    <ChartFrame title={title} caption={unit}>
      <div className="chart-wrap" ref={ref}>
        <svg
          className={`chart hue-${hue}`}
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          role="img"
          aria-label={typeof title === "string" ? title : "histogram"}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t) => {
            const y = sy(t);
            return (
              <g key={t}>
                <line className="grid" x1={PAD_L} x2={W - PAD_R} y1={y} y2={y} />
                <text className="axis-y" x={PAD_L - 6} y={y} dy="0.32em" textAnchor="end">
                  {t}
                </text>
              </g>
            );
          })}
          {bins.map((b, i) => {
            const x = PAD_L + i * step;
            const y = sy(b.count);
            const h = Math.max(0, baseY - y);
            return (
              <g key={i}>
                {b.count > 0 ? <rect className="bar" x={x} y={y} width={bandW} height={h} rx={1} /> : null}
                <rect
                  x={x}
                  y={PAD_T}
                  width={step}
                  height={innerH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                />
              </g>
            );
          })}
          {/* sparse x labels: first, middle, last bin edge */}
          {[0, Math.floor(bins.length / 2), bins.length - 1].map((i) => (
            <text
              key={`xl-${i}`}
              className="axis-x"
              x={PAD_L + i * step + step / 2}
              y={H - PAD_B + 14}
              textAnchor="middle"
            >
              {format(bins[i]!.x0)}
            </text>
          ))}
        </svg>
        {hovered ? (
          <div className="chart-tip" style={{ left: `${hoverX}%` }} role="status">
            <div className="tip-label tnum">
              {format(hovered.x0)}–{format(hovered.x1)}
              {unit ? ` ${unit}` : ""}
            </div>
            <div className="tip-val tnum">{hovered.count} samples</div>
          </div>
        ) : null}
      </div>
    </ChartFrame>
  );
}
