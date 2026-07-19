/** Small shared presentational components (no state, no fetching). */

import type { ReactNode } from "react";
import { fmtPct } from "../lib/format";

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <div className="empty">{children}</div>;
}

export function ProgressBar({
  label,
  done,
  total,
  pct,
  tone = "accent",
}: {
  label: string;
  done: number | null;
  total: number | null;
  /** 0..1, computed from done/total when omitted */
  pct?: number | null;
  tone?: "accent" | "good" | "info";
}): ReactNode {
  const ratio =
    pct ?? (done !== null && total !== null && total > 0 ? done / total : null);
  const width = ratio === null ? 0 : Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <div className="progress">
      <div className="p-head">
        <span>
          {label}
          {done !== null && total !== null ? (
            <span className="dim">
              {" "}
              — {done}/{total}
            </span>
          ) : null}
        </span>
        <span className="pct">{fmtPct(ratio)}</span>
      </div>
      <div className="track">
        <div
          className={`fill${tone !== "accent" ? ` ${tone}` : ""}`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

export function Badge({
  kind,
  children,
  dot = false,
}: {
  kind?:
    | "live"
    | "down"
    | "warn"
    | "kappa"
    | "anymap"
    | "fir"
    | "tier"
    | "ok"
    | "sev-high"
    | "sev-medium"
    | "sev-low";
  children: ReactNode;
  dot?: boolean;
}): ReactNode {
  return (
    <span className={`badge${kind ? ` ${kind}` : ""}`}>
      {dot ? <span className="dot" /> : null}
      {children}
    </span>
  );
}
