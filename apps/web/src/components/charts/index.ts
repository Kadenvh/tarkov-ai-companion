/** Dependency-free SVG chart toolkit — token-styled, responsive, pure geometry.
 *  Import styles once here so any consumer of a chart pulls them in. */

import "./charts.css";

export { TimeSeries } from "./TimeSeries";
export type { TimeSeriesMetric, TimeSeriesProps, TimeMarker } from "./TimeSeries";
export { BarChart } from "./BarChart";
export type { BarChartProps, BarDatum, BarTone } from "./BarChart";
export { Histogram } from "./Histogram";
export type { HistogramProps } from "./Histogram";
export { PercentileBars } from "./PercentileBars";
export type { PercentileBarsProps, PercentileDatum } from "./PercentileBars";
export { StatTile } from "./StatTile";
export type { StatTileProps, DeltaPolarity } from "./StatTile";
export { ChartFrame } from "./ChartFrame";
export { Sparkline } from "../Sparkline";
export type { SparkPoint } from "../Sparkline";

export * as chartGeometry from "./geometry";
