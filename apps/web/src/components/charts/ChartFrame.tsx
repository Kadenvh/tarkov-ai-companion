/**
 * Shared chrome for the SVG charts: a direct-label title (single-series charts
 * are labelled here, never by a legend), an optional data-table toggle for
 * accessibility, and the sizing wrapper. The chart itself and its table are
 * passed as render props so the toggle lives in one place.
 */

import { useId, useState, type ReactNode } from "react";

export interface ChartFrameProps {
  title?: ReactNode;
  /** short unit / caption shown next to the title (ink color, never series color) */
  caption?: ReactNode;
  /** when provided, a "table" toggle appears; renders this instead of the chart */
  table?: ReactNode;
  children: ReactNode;
}

export function ChartFrame({ title, caption, table, children }: ChartFrameProps): ReactNode {
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  return (
    <figure className="chart-fig">
      {title || caption || table ? (
        <figcaption className="chart-cap">
          <span className="chart-title">{title}</span>
          {caption ? <span className="chart-unit">{caption}</span> : null}
          {table ? (
            <button
              type="button"
              className="chart-toggle"
              aria-pressed={showTable}
              aria-controls={tableId}
              onClick={() => setShowTable((v) => !v)}
            >
              {showTable ? "chart" : "table"}
            </button>
          ) : null}
        </figcaption>
      ) : null}
      {showTable && table ? (
        <div id={tableId} className="chart-table table-scroll">
          {table}
        </div>
      ) : (
        children
      )}
    </figure>
  );
}
