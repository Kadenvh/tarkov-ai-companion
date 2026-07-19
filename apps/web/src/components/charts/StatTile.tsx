/**
 * StatTile — a hero number with a unit and an optional signed delta. The delta
 * only takes a status color (success/error) when the caller declares a polarity
 * ("up-good" / "down-good"); otherwise it is ink-colored and neutral, since for
 * most telemetry (temperature, utilisation) higher is neither good nor bad. The
 * arrow + sign always carry the meaning so color is never load-bearing alone.
 */

import type { ReactNode } from "react";

export type DeltaPolarity = "up-good" | "down-good" | "neutral";

export interface StatTileProps {
  label: string;
  value: ReactNode;
  unit?: string;
  /** signed fractional change (e.g. 0.12 = +12%); rendered as a percentage */
  delta?: number | null;
  deltaPolarity?: DeltaPolarity;
  /** DS hue for the accent hairline */
  hue?: "secondary" | "primary";
  sub?: ReactNode;
}

function deltaTone(delta: number, polarity: DeltaPolarity): "good" | "bad" | "neutral" {
  if (polarity === "neutral" || delta === 0) return "neutral";
  const rising = delta > 0;
  if (polarity === "up-good") return rising ? "good" : "bad";
  return rising ? "bad" : "good";
}

export function StatTile({
  label,
  value,
  unit,
  delta,
  deltaPolarity = "neutral",
  hue = "secondary",
  sub,
}: StatTileProps): ReactNode {
  const showDelta = delta != null && Number.isFinite(delta);
  const tone = showDelta ? deltaTone(delta, deltaPolarity) : "neutral";
  const arrow = !showDelta ? "" : delta > 0 ? "▲" : delta < 0 ? "▼" : "▪";
  const pct = showDelta ? `${delta > 0 ? "+" : ""}${Math.round(delta * 100)}%` : "";
  return (
    <div className={`stat-tile hue-${hue}`}>
      <div className="st-label">{label}</div>
      <div className="st-value">
        <span className="st-num tnum">{value}</span>
        {unit ? <span className="st-unit">{unit}</span> : null}
      </div>
      {showDelta ? (
        <div className={`st-delta ${tone}`}>
          <span className="st-arrow">{arrow}</span> {pct}
        </div>
      ) : null}
      {sub ? <div className="st-sub">{sub}</div> : null}
    </div>
  );
}
