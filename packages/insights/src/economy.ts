/**
 * M7.2 — Economy tracking over `flea_sales` (log-derived flea market income).
 *
 * What this can and cannot know (documented limits):
 * - `flea_sales` only records **flea income** the log watcher saw. Trader
 *   sales, insurance returns, raid loot value, and all SPENDING are invisible
 *   to the logs.
 * - Net worth is therefore an **ESTIMATE**: cumulative flea income minus a
 *   user-configurable flat daily spend heuristic, plus an optional starting
 *   balance. It is directional, not an accounting statement. Real stash
 *   valuation arrives with the OCR capture channel (M2.6/T2) later.
 *
 * @tier T0 — pure computation over the app-owned profile DB.
 */

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { dayOf, daysBetween, isoWeekMonday, lowConfidence, nextDay, round4 } from "./util.js";

export interface FleaSaleRow {
  id: number;
  itemName: string;
  amount: number;
  ts: string;
}

export function loadFleaSales(db: DatabaseSync): FleaSaleRow[] {
  const rows = db
    .prepare(`SELECT id, item_name, amount, ts FROM flea_sales ORDER BY ts, id`)
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r["id"]),
    itemName: String(r["item_name"]),
    amount: Number(r["amount"]),
    ts: String(r["ts"]),
  }));
}

// ---------------------------------------------------------------------------
// Flea income over time
// ---------------------------------------------------------------------------

export type IncomeBucket = "daily" | "weekly";

export interface IncomePoint {
  /** "YYYY-MM-DD": the calendar day (daily) or the Monday of the ISO week (weekly). */
  period: string;
  /** Rubles received in this period. */
  total: number;
  /** Number of sales in this period. */
  count: number;
  /** Running total of all income up to and including this period. */
  cumulative: number;
}

export interface FleaIncome {
  bucket: IncomeBucket;
  /** Only periods with at least one sale appear (no zero-fill). Chronological. */
  points: IncomePoint[];
  totalIncome: number;
  /** n = number of individual sales. */
  n: number;
  lowConfidence: boolean;
  /** Sales skipped because their timestamp had no parseable date. */
  excluded: number;
}

export function fleaIncome(db: DatabaseSync, bucket: IncomeBucket = "daily"): FleaIncome {
  const sales = loadFleaSales(db);
  const byPeriod = new Map<string, { total: number; count: number }>();
  let excluded = 0;
  let included = 0;
  for (const sale of sales) {
    const day = dayOf(sale.ts);
    if (day === null) {
      excluded++;
      continue;
    }
    included++;
    const period = bucket === "weekly" ? isoWeekMonday(day) : day;
    const agg = byPeriod.get(period) ?? { total: 0, count: 0 };
    agg.total += sale.amount;
    agg.count += 1;
    byPeriod.set(period, agg);
  }
  const points: IncomePoint[] = [];
  let cumulative = 0;
  for (const period of [...byPeriod.keys()].sort()) {
    const agg = byPeriod.get(period)!;
    cumulative += agg.total;
    points.push({ period, total: agg.total, count: agg.count, cumulative });
  }
  return {
    bucket,
    points,
    totalIncome: cumulative,
    n: included,
    lowConfidence: lowConfidence(included),
    excluded,
  };
}

// ---------------------------------------------------------------------------
// Net-worth ESTIMATE
// ---------------------------------------------------------------------------

export const NetWorthConfig = z.object({
  /** Rubles assumed on hand at the first recorded sale day. */
  startingRubles: z.number().default(0),
  /** Flat heuristic: rubles spent per elapsed day (gear, ammo, meds, barters). */
  dailySpendRubles: z.number().min(0).default(0),
});
export type NetWorthConfig = z.infer<typeof NetWorthConfig>;

export interface NetWorthPoint {
  day: string;
  fleaCumulative: number;
  /** startingRubles + fleaCumulative − dailySpendRubles × daysElapsed. */
  estimatedNetWorth: number;
}

export interface NetWorthEstimate {
  /** Always true — this is a heuristic, not an accounting statement. */
  isEstimate: true;
  method: string;
  caveats: string[];
  config: NetWorthConfig;
  /** One point per calendar day from first to last recorded sale (gaps filled). */
  points: NetWorthPoint[];
  /** n = number of sales backing the curve. */
  n: number;
  lowConfidence: boolean;
}

export const NET_WORTH_CAVEATS: readonly string[] = [
  "Income side only counts flea-market sales seen in the logs; trader sales, insurance returns, and loot value are invisible.",
  "Spending is a flat configurable daily heuristic (dailySpendRubles), not observed data.",
  "Currency is rubles as logged; dollar/euro sales are whatever amount the log reported.",
  "Real stash valuation arrives with the OCR capture channel (M2.6) and will supersede this estimate.",
];

export function netWorthEstimate(db: DatabaseSync, config: unknown = {}): NetWorthEstimate {
  const parsed = NetWorthConfig.parse(config);
  const daily = fleaIncome(db, "daily");
  const points: NetWorthPoint[] = [];
  if (daily.points.length > 0) {
    const firstDay = daily.points[0]!.period;
    const lastDay = daily.points[daily.points.length - 1]!.period;
    const incomeByDay = new Map(daily.points.map((p) => [p.period, p.total]));
    let cumulative = 0;
    for (let day = firstDay; ; day = nextDay(day)) {
      cumulative += incomeByDay.get(day) ?? 0;
      const elapsed = daysBetween(firstDay, day);
      points.push({
        day,
        fleaCumulative: cumulative,
        estimatedNetWorth: round4(parsed.startingRubles + cumulative - parsed.dailySpendRubles * elapsed),
      });
      if (day === lastDay) break;
    }
  }
  return {
    isEstimate: true,
    method: "cumulative flea income minus flat daily spend heuristic",
    caveats: [...NET_WORTH_CAVEATS],
    config: parsed,
    points,
    n: daily.n,
    lowConfidence: daily.lowConfidence,
  };
}
