import { describe, expect, it } from "vitest";
import { explainReasons, groupByRoute, planTotals, ROUTE_ORDER } from "../src/lib/quartermasterView";
import type { AcquisitionItem, AcquisitionPlan } from "../src/api/types";

function item(partial: Partial<AcquisitionItem>): AcquisitionItem {
  return {
    itemId: "x",
    name: "Item",
    count: 1,
    fir: false,
    forTasks: [],
    route: { kind: "flea", detail: "flea" },
    alternatives: [],
    reasons: [],
    ...partial,
  };
}

const PLAN: AcquisitionPlan = {
  raids: 5,
  totalRubles: 123_456,
  craftSchedule: [{ itemId: "c1", station: "Workbench", startBy: "2026-07-11T18:00:00Z", minutes: 90 }],
  items: [
    item({ itemId: "fir1", fir: true, count: 3, route: { kind: "find-in-raid", detail: "Customs", raidIndex: 2 } }),
    item({ itemId: "flea1", count: 2, route: { kind: "flea", detail: "flea", unitCost: 10_000, totalCost: 20_000 } }),
    item({ itemId: "craft1", route: { kind: "craft", detail: "Workbench", craftStation: "Workbench", craftMinutes: 90, totalCost: 5_000 } }),
    item({ itemId: "flea2", route: { kind: "flea", detail: "flea", unitCost: 7_000, totalCost: 7_000 } }),
    item({ itemId: "trader1", route: { kind: "trader", detail: "Therapist LL2", totalCost: 12_000 } }),
  ],
};

describe("groupByRoute", () => {
  it("groups items by primary route kind in fixed display order, dropping empty groups", () => {
    const groups = groupByRoute(PLAN);
    expect(groups.map((g) => g.kind)).toEqual(["flea", "trader", "craft", "find-in-raid"]);
    // barter missing from fixture -> dropped; order follows ROUTE_ORDER
    const orderIdx = groups.map((g) => ROUTE_ORDER.indexOf(g.kind));
    expect([...orderIdx].sort((a, b) => a - b)).toEqual(orderIdx);
  });

  it("sums group cost and unit counts", () => {
    const flea = groupByRoute(PLAN).find((g) => g.kind === "flea")!;
    expect(flea.items).toHaveLength(2);
    expect(flea.totalRubles).toBe(27_000);
    expect(flea.unitCount).toBe(3);
    const fir = groupByRoute(PLAN).find((g) => g.kind === "find-in-raid")!;
    expect(fir.totalRubles).toBe(0);
  });

  it("returns [] for a missing plan", () => {
    expect(groupByRoute(null)).toEqual([]);
    expect(groupByRoute(undefined)).toEqual([]);
  });
});

describe("planTotals", () => {
  it("computes header totals from the plan", () => {
    expect(planTotals(PLAN)).toEqual({
      totalRubles: 123_456,
      itemLines: 5,
      units: 8,
      firLines: 1,
      craftLines: 1,
      raids: 5,
    });
  });

  it("degrades to zeros without a plan", () => {
    expect(planTotals(null).totalRubles).toBe(0);
    expect(planTotals(null).itemLines).toBe(0);
  });
});

describe("explainReasons", () => {
  it("translates machine reasons into readable why-lines", () => {
    const lines = explainReasons(
      item({
        reasons: [
          "needed-by:raid-3",
          "fir-required",
          "route:find-in-raid:fir-required",
          "skipped-cheaper:flea:level-gate-25",
          "route:trader:cheapest-feasible",
        ],
      }),
    );
    expect(lines).toEqual([
      "Needed before raid 3",
      "Must be Found in Raid — purchases don't count",
      "A cheaper flea route exists but is gated (level-gate-25)",
      "Cheapest route you can use right now: trader",
    ]);
  });

  it("passes unknown reasons through verbatim (never hides information)", () => {
    expect(explainReasons(item({ reasons: ["some-new-reason"] }))).toEqual(["some-new-reason"]);
  });
});
