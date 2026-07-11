import { describe, expect, it } from "vitest";
import { buildPlanVM, neededByRaid, warningText, warningsForRaid } from "../src/lib/planView";
import type { AcquisitionItem, AcquisitionPlan, PlanResponse, PlannedRaid } from "../src/api/types";

function item(partial: Partial<AcquisitionItem>): AcquisitionItem {
  return {
    itemId: "item-1",
    name: "Gas analyzer",
    count: 2,
    fir: false,
    forTasks: [],
    route: { kind: "flea", detail: "flea market" },
    alternatives: [],
    reasons: [],
    ...partial,
  };
}

function raid(partial: Partial<PlannedRaid>): PlannedRaid {
  return {
    index: 1,
    map: "56f40101d2720b2a4d8b45d6",
    tasks: [],
    levelBefore: 12,
    levelAfter: 12,
    score: 10,
    ...partial,
  };
}

describe("neededByRaid", () => {
  it("uses route.raidIndex for find-in-raid items", () => {
    expect(
      neededByRaid(item({ route: { kind: "find-in-raid", detail: "Customs", raidIndex: 3 } })),
    ).toBe(3);
  });

  it("parses needed-by:raid-N machine reasons", () => {
    expect(neededByRaid(item({ reasons: ["needed-by:raid-4", "fir-required"] }))).toBe(4);
  });

  it("defaults to raid 1 (have it before the session starts)", () => {
    expect(neededByRaid(item({}))).toBe(1);
  });
});

describe("warningsForRaid", () => {
  it("prefers warnings embedded on the raid", () => {
    const r = raid({ warnings: [{ kind: "task-exclusivity" }] });
    expect(warningsForRaid(r, [{ kind: "other" }])).toEqual([{ kind: "task-exclusivity" }]);
  });

  it("matches plan-level array warnings by completing-task membership", () => {
    const r = raid({ tasks: [{ id: "t1", name: "Chemical Part 4", anyMap: false, reasons: [] }] });
    const warnings: PlanResponse["warnings"] = [
      { kind: "task-exclusivity", completing: { id: "t1", name: "Chemical Part 4" } },
      { kind: "task-exclusivity", completing: { id: "t9", name: "Elsewhere" } },
    ];
    expect(warningsForRaid(r, warnings)).toHaveLength(1);
  });

  it("supports record-keyed warnings and empty fallback", () => {
    const r = raid({ index: 2 });
    expect(warningsForRaid(r, { "2": [{ kind: "story-decision" }] })).toEqual([
      { kind: "story-decision" },
    ]);
    expect(warningsForRaid(r, undefined)).toEqual([]);
  });
});

describe("warningText", () => {
  it("prefers explicit consequence text", () => {
    expect(warningText({ kind: "story-decision", consequence: "Locks the Savior ending" })).toBe(
      "Locks the Savior ending",
    );
  });

  it("builds a consequence line from fails with Kappa/Lightkeeper tags", () => {
    const text = warningText({
      kind: "task-exclusivity",
      completing: { id: "a", name: "Loyalty Buyout" },
      fails: [
        { id: "b", name: "Chemical - Part 4", kappaRequired: true },
        { id: "c", name: "Big Customer", lightkeeperRequired: true },
      ],
    });
    expect(text).toBe(
      "Completing Loyalty Buyout permanently fails: Chemical - Part 4 (Kappa), Big Customer (Lightkeeper)",
    );
  });
});

describe("buildPlanVM", () => {
  const plan: PlanResponse = {
    raids: [
      raid({ index: 1, map: "56f40101d2720b2a4d8b45d6", levelBefore: 12, levelAfter: 14 }),
      raid({ index: 2, map: "any" }),
    ],
    freeTasksCompleted: [{ id: "f1", name: "Gunsmith - Part 1" }],
    goalTaskCount: 100,
    remainingGoalTasks: 42,
    levelStalls: [{ taskId: "s1", name: "Collector", requiredLevel: 45 }],
    reachedLevel: 15,
    hash: "abc123",
  };
  const quartermaster: AcquisitionPlan = {
    raids: 2,
    totalRubles: 50_000,
    craftSchedule: [],
    items: [
      item({ itemId: "salewa", reasons: ["needed-by:raid-2"] }),
      item({ itemId: "analyzer" }), // defaults to raid 1
      item({
        itemId: "bronze-lion",
        fir: true,
        route: { kind: "find-in-raid", detail: "Shoreline", raidIndex: 2 },
      }),
    ],
  };

  it("merges prep items into the raid they must be ready for", () => {
    const vm = buildPlanVM(plan, quartermaster, (k) => k);
    expect(vm?.raids[0]?.prep.map((i) => i.itemId)).toEqual(["analyzer"]);
    expect(vm?.raids[1]?.prep.map((i) => i.itemId)).toEqual(["salewa", "bronze-lion"]);
  });

  it("computes levelUps, filler flag, and applies the map-name resolver", () => {
    const vm = buildPlanVM(plan, quartermaster, (k) => (k === "any" ? "Any map" : "Customs"));
    expect(vm?.raids[0]?.levelUps).toBe(2);
    expect(vm?.raids[0]?.mapName).toBe("Customs");
    expect(vm?.raids[1]?.fillerOnly).toBe(true);
    expect(vm?.hash).toBe("abc123");
    expect(vm?.freeTasks).toHaveLength(1);
    expect(vm?.levelStalls[0]?.requiredLevel).toBe(45);
  });

  it("returns null when the plan is missing or malformed", () => {
    expect(buildPlanVM(null, quartermaster)).toBeNull();
    expect(buildPlanVM({} as PlanResponse, quartermaster)).toBeNull();
  });

  it("tolerates a missing quartermaster plan", () => {
    const vm = buildPlanVM(plan, null);
    expect(vm?.raids.every((r) => r.prep.length === 0)).toBe(true);
  });
});
