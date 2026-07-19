/**
 * TimeSeries — line + area over a shared time axis. Multiple metrics of
 * different scale are drawn as *stacked small-multiples* (each its own y-scale
 * and row), never a dual-axis chart. One crosshair spans every row and a single
 * tooltip reads out all metrics at the hovered time. The latest point carries
 * an emphasized endpoint marker. Vertical `markers` annotate future/other times
 * (e.g. a goal-ETA). Purely prop-driven, so appending to a live buffer just
 * re-renders. A table toggle mirrors the data for accessibility.
 */

import { useState, type ReactNode } from "react";
import {
  buildAreaPath,
  buildLinePath,
  clamp,
  compactNum,
  extent,
  linScale,
  nearestIndex,
  niceDomain,
  niceTicks,
} from "./geometry";
import { ChartFrame } from "./ChartFrame";
import { useChartWidth } from "./useChartWidth";

export interface TimeSeriesMetric {
  key: string;
  label: string;
  unit?: string;
  hue?: "secondary" | "primary";
  /** aligned 1:1 with `times`; null = gap (never interpolated) */
  values: (number | null)[];
  /** fixed y-domain (e.g. [0,100] for a percentage); auto-scaled when omitted */
  domain?: [number, number];
  format?: (v: number) => string;
}

export interface TimeMarker {
  t: number;
  label: string;
  tone?: "kappa" | "good" | "warn";
}

export interface TimeSeriesProps {
  times: number[];
  metrics: TimeSeriesMetric[];
  rowHeight?: number;
  title?: ReactNode;
  markers?: TimeMarker[];
  xFormat?: (t: number) => string;
  withTable?: boolean;
}

const PAD_L = 44;
const PAD_R = 12;
const PAD_T = 6;
const PAD_B = 22;
const ROW_GAP = 10;
const ROW_INNER = 8;

const defaultXFormat = (t: number): string =>
  new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

export function TimeSeries({
  times,
  metrics,
  rowHeight = 78,
  title,
  markers = [],
  xFormat = defaultXFormat,
  withTable = true,
}: TimeSeriesProps): ReactNode {
  const [hover, setHover] = useState<number | null>(null);
  const { ref, width: W } = useChartWidth();

  if (times.length === 0 || metrics.length === 0) {
    return (
      <ChartFrame title={title}>
        <div className="chart-empty">no telemetry yet</div>
      </ChartFrame>
    );
  }

  const H = PAD_T + metrics.length * rowHeight + (metrics.length - 1) * ROW_GAP + PAD_B;
  const markerTs = markers.map((m) => m.t);
  const xMin = Math.min(times[0]!, ...markerTs);
  const xMax = Math.max(times[times.length - 1]!, ...markerTs);
  const sx = linScale(xMin, xMax, PAD_L, W - PAD_R);
  const sxInv = linScale(PAD_L, W - PAD_R, xMin, xMax);

  const rows = metrics.map((m, i) => {
    const top = PAD_T + i * (rowHeight + ROW_GAP);
    const y0 = top + rowHeight - ROW_INNER;
    const y1 = top + ROW_INNER;
    const ext = extent(m.values) ?? [0, 1];
    const [dLo, dHi] = m.domain ?? niceDomain(ext[0], ext[1], { baselineZero: ext[0] >= 0 && ext[0] < ext[1] * 0.4, padFrac: 0.1 });
    const sy = linScale(dLo, dHi, y0, y1);
    const line = buildLinePath(times, m.values, sx, sy);
    const area = buildAreaPath(times, m.values, sx, sy, y0);
    const ticks = niceTicks(dLo, dHi, 3);
    // last non-null point for the endpoint marker
    let lastIdx = -1;
    for (let k = m.values.length - 1; k >= 0; k--) {
      const v = m.values[k];
      if (v != null && Number.isFinite(v)) {
        lastIdx = k;
        break;
      }
    }
    const fmt = m.format ?? ((v: number) => String(Math.round(v)));
    return { m, top, y0, y1, sy, line, area, ticks, lastIdx, fmt };
  });

  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const t = sxInv(ratio * W);
    setHover(nearestIndex(times, t));
  };

  const hoverT = hover != null ? times[hover] : null;
  const hoverX = hoverT != null ? (sx(hoverT) / W) * 100 : 0;
  const tipRight = hoverX > 62;

  const table = withTable ? (
    <table className="data">
      <thead>
        <tr>
          <th>Time</th>
          {metrics.map((m) => (
            <th key={m.key} className="num">
              {m.label}
              {m.unit ? ` (${m.unit})` : ""}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {times.map((t, i) => (
          <tr key={t}>
            <td className="tnum">{new Date(t).toLocaleTimeString("en-US", { hour12: false })}</td>
            {rows.map(({ m, fmt }) => {
              const v = m.values[i];
              return (
                <td key={m.key} className="num">
                  {v == null ? "—" : fmt(v)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  ) : undefined;

  return (
    <ChartFrame title={title} table={table}>
      <div className="chart-wrap" ref={ref}>
        <svg
          className="chart timeseries"
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          role="img"
          aria-label={typeof title === "string" ? title : "time series"}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          {rows.map(({ m, top, y0, y1, sy, line, area, ticks, lastIdx, fmt }) => (
            <g key={m.key} className={`ts-row hue-${m.hue ?? "secondary"}`}>
              {ticks.map((t) => {
                const y = clamp(sy(t), y1, y0);
                return (
                  <g key={t}>
                    <line className="grid" x1={PAD_L} x2={W - PAD_R} y1={y} y2={y} />
                    <text className="axis-y" x={PAD_L - 6} y={y} dy="0.32em" textAnchor="end">
                      {compactNum(t)}
                    </text>
                  </g>
                );
              })}
              <text className="ts-rowlabel" x={PAD_L} y={top - 1}>
                {m.label}
                {m.unit ? ` · ${m.unit}` : ""}
              </text>
              {area ? <path className="area" d={area} /> : null}
              {line ? <path className="line" d={line} /> : null}
              {lastIdx >= 0 ? (
                <circle
                  className="endpoint"
                  cx={sx(times[lastIdx]!)}
                  cy={sy(m.values[lastIdx] as number)}
                  r={4}
                />
              ) : null}
              {hover != null && m.values[hover] != null ? (
                <circle className="crosshair-dot" cx={sx(times[hover]!)} cy={sy(m.values[hover] as number)} r={3} />
              ) : null}
            </g>
          ))}

          {markers.map((mk, i) => {
            const x = sx(mk.t);
            return (
              <g key={`mk-${i}`} className={`ts-marker tone-${mk.tone ?? "kappa"}`}>
                <line className="marker-line" x1={x} x2={x} y1={PAD_T} y2={H - PAD_B} />
                <text className="marker-label" x={x} y={PAD_T + 2} textAnchor={x > W * 0.7 ? "end" : "start"}>
                  {mk.label}
                </text>
              </g>
            );
          })}

          {hoverT != null ? (
            <line className="crosshair" x1={sx(hoverT)} x2={sx(hoverT)} y1={PAD_T} y2={H - PAD_B} />
          ) : null}

          <text className="axis-x" x={PAD_L} y={H - 6} textAnchor="start">
            {xFormat(xMin)}
          </text>
          <text className="axis-x" x={W - PAD_R} y={H - 6} textAnchor="end">
            {xFormat(xMax)}
          </text>
        </svg>
        {hoverT != null ? (
          <div className={`chart-tip ${tipRight ? "flip" : ""}`} style={{ left: `${hoverX}%` }} role="status">
            <div className="tip-label tnum">{xFormat(hoverT)}</div>
            {rows.map(({ m, fmt }) => {
              const v = hover != null ? m.values[hover] : null;
              return (
                <div key={m.key} className="tip-row">
                  <span className={`tip-swatch hue-${m.hue ?? "secondary"}`} />
                  <span className="tip-name">{m.label}</span>
                  <span className="tip-val tnum">
                    {v == null ? "—" : fmt(v)}
                    {m.unit ? ` ${m.unit}` : ""}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </ChartFrame>
  );
}
