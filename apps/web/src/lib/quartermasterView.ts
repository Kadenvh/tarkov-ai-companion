/**
 * Quartermaster view-model (M5.4) — grouping/totals over the CONTRACTS §7
 * AcquisitionPlan. Pure, unit-tested.
 */

import type { AcquisitionItem, AcquisitionPlan, RouteKind } from "../api/types";

export const ROUTE_ORDER: RouteKind[] = ["flea", "trader", "barter", "craft", "find-in-raid"];

export const ROUTE_LABELS: Record<RouteKind, string> = {
  flea: "Buy — flea market",
  trader: "Buy — trader",
  barter: "Barter",
  craft: "Craft",
  "find-in-raid": "Find in raid",
};

export interface RouteGroup {
  kind: RouteKind;
  label: string;
  items: AcquisitionItem[];
  /** sum of route.totalCost over the group (0 for FIR) */
  totalRubles: number;
  /** total unit count across items */
  unitCount: number;
}

export interface QuartermasterTotals {
  totalRubles: number;
  itemLines: number;
  units: number;
  firLines: number;
  craftLines: number;
  raids: number;
}

/** Group items by primary route kind, in fixed display order; empty groups dropped. */
export function groupByRoute(plan: AcquisitionPlan | null | undefined): RouteGroup[] {
  if (!plan) return [];
  const buckets = new Map<RouteKind, AcquisitionItem[]>();
  for (const item of plan.items) {
    const kind = item.route.kind;
    const bucket = buckets.get(kind) ?? [];
    bucket.push(item);
    buckets.set(kind, bucket);
  }
  const groups: RouteGroup[] = [];
  for (const kind of ROUTE_ORDER) {
    const items = buckets.get(kind);
    if (!items || items.length === 0) continue;
    groups.push({
      kind,
      label: ROUTE_LABELS[kind],
      items,
      totalRubles: items.reduce((s, it) => s + (it.route.totalCost ?? 0), 0),
      unitCount: items.reduce((s, it) => s + it.count, 0),
    });
  }
  return groups;
}

/** Header totals for the whole acquisition plan. */
export function planTotals(plan: AcquisitionPlan | null | undefined): QuartermasterTotals {
  if (!plan) return { totalRubles: 0, itemLines: 0, units: 0, firLines: 0, craftLines: 0, raids: 0 };
  return {
    totalRubles: plan.totalRubles,
    itemLines: plan.items.length,
    units: plan.items.reduce((s, it) => s + it.count, 0),
    firLines: plan.items.filter((it) => it.fir).length,
    craftLines: plan.items.filter((it) => it.route.kind === "craft").length,
    raids: plan.raids,
  };
}

/** Machine reasons -> readable "why" lines for the expander (M3.6 explainability). */
export function explainReasons(item: AcquisitionItem): string[] {
  const out: string[] = [];
  for (const reason of item.reasons) {
    const neededBy = /^needed-by:raid-(\d+)$/.exec(reason);
    if (neededBy) {
      out.push(`Needed before raid ${neededBy[1]}`);
      continue;
    }
    if (reason === "fir-required") {
      out.push("Must be Found in Raid — purchases don't count");
      continue;
    }
    if (reason === "route:find-in-raid:fir-required") continue; // covered above
    if (reason === "alternative:craft-output-counts-as-fir") {
      out.push("Hideout craft output counts as Found in Raid (alternative)");
      continue;
    }
    if (reason === "route:find-in-raid:no-feasible-purchase") {
      out.push("No purchasable route at your current level/traders — find it in raid");
      continue;
    }
    if (reason === "assumed:hideout-built") {
      out.push("Assumes the hideout station is built — verify before starting the craft");
      continue;
    }
    const cheapest = /^route:([a-z-]+):cheapest-feasible$/.exec(reason);
    if (cheapest) {
      out.push(`Cheapest route you can use right now: ${cheapest[1]}`);
      continue;
    }
    const skipped = /^skipped-cheaper:([a-z-]+):(.+)$/.exec(reason);
    if (skipped) {
      out.push(`A cheaper ${skipped[1]} route exists but is gated (${skipped[2]})`);
      continue;
    }
    const blocked = /^blocked:([a-z-]+):(.+)$/.exec(reason);
    if (blocked) {
      out.push(`${blocked[1]} route blocked: ${blocked[2]}`);
      continue;
    }
    out.push(reason);
  }
  return out;
}
