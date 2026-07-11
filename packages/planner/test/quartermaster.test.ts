import { describe, expect, it } from "vitest";
import type { Market, MarketItem, Task, TaskGraph } from "@tac/data-core";
import { buildTaskGraph, loadMarket, loadWorld } from "@tac/data-core";
import { LevelCurve } from "../src/levels.js";
import { PlayerState, toSim } from "../src/state.js";
import { resolveGoalTasks } from "../src/goals.js";
import { buildPlan, type Plan } from "../src/director.js";
import { buildAcquisitionPlan } from "../src/quartermaster.js";

// ---------- fixture builders ----------

const PRAPOR = "trader-prapor";

function mkItem(id: string, over: Partial<MarketItem> = {}): MarketItem {
  return {
    id,
    name: `Item ${id}`,
    shortName: id,
    types: [],
    basePrice: 100,
    fleaBanned: false,
    fleaLevelGate: 15,
    fleaAvg24h: null,
    fleaLastLow: null,
    fleaLow24h: null,
    traderOffers: [],
    bestTraderSell: null,
    ...over,
  };
}

function mkMarket(over: Partial<Market> = {}): Market {
  const items: Record<string, MarketItem> = over.items ?? {};
  const traders = over.traders ?? {
    [PRAPOR]: {
      id: PRAPOR,
      name: "Prapor",
      currency: "RUB",
      levels: [
        { level: 1, requiredPlayerLevel: 0, requiredReputation: 0, requiredCommerce: 0 },
        { level: 2, requiredPlayerLevel: 15, requiredReputation: 0.2, requiredCommerce: 0 },
        { level: 3, requiredPlayerLevel: 26, requiredReputation: 0.35, requiredCommerce: 0 },
        { level: 4, requiredPlayerLevel: 36, requiredReputation: 0.5, requiredCommerce: 0 },
      ],
    },
  };
  const stations = over.stations ?? {
    "station-med": { id: "station-med", name: "Medstation", levels: [] },
  };
  return {
    ref: { version: "test", dir: "test" },
    mode: "regular",
    fleaEnabled: true,
    fleaMinPlayerLevel: 15,
    items,
    barters: [],
    crafts: [],
    traders,
    stations,
    itemName: (id) => items[id]?.name ?? id,
    traderName: (id) => traders[id]?.name ?? id,
    stationName: (id) => stations[id]?.name ?? id,
    issues: [],
    ...over,
  };
}

interface ObjSpec {
  type?: string;
  items: string[];
  count?: number;
  foundInRaid?: boolean;
  optional?: boolean;
}

function mkTask(id: string, objectives: ObjSpec[], map: string | null = null): Task {
  return {
    id,
    name: `Task ${id}`,
    trader: PRAPOR,
    map,
    taskRequirements: [],
    traderRequirements: [],
    objectives: objectives.map((o, i) => ({
      id: `${id}-obj-${i}`,
      type: o.type ?? "giveItem",
      optional: o.optional ?? false,
      items: o.items,
      count: o.count ?? 1,
      foundInRaid: o.foundInRaid ?? false,
    })),
  } as unknown as Task;
}

function mkGraph(tasks: Task[]): TaskGraph {
  return buildTaskGraph(Object.fromEntries(tasks.map((t) => [t.id, t])));
}

function mkPlan(raids: { map: string; taskIds: string[] }[], freeIds: string[] = []): Plan {
  return {
    raids: raids.map((r, i) => ({
      index: i + 1,
      map: r.map,
      tasks: r.taskIds.map((id) => ({ id, name: `Task ${id}`, anyMap: false, reasons: [] })),
      levelBefore: 1,
      levelAfter: 1,
      score: 1,
    })),
    freeTasksCompleted: freeIds.map((id) => ({ id, name: `Task ${id}` })),
    goalTaskCount: 0,
    remainingGoalTasks: 0,
    levelStalls: [],
    reachedLevel: 1,
  };
}

const at = (level: number, rep = 0) =>
  PlayerState.parse({ level, traderRep: { [PRAPOR]: rep } });

// ---------- route selection: level & LL gates ----------

describe("route selection respects level and loyalty gates", () => {
  const itemId = "item-gated";
  const market = mkMarket({
    items: {
      [itemId]: mkItem(itemId, {
        fleaAvg24h: 10_000,
        fleaLevelGate: 15,
        traderOffers: [
          { trader: PRAPOR, priceRub: 8_000, currency: "RUB", minTraderLevel: 4, taskUnlock: null, buyLimit: null },
        ],
      }),
    },
  });
  const graph = mkGraph([mkTask("t1", [{ items: [itemId], count: 1 }])]);
  const plan = mkPlan([{ map: "factory", taskIds: ["t1"] }]);

  it("level 5: flea and LL4 trader both gated -> find-in-raid with blocked reasons", () => {
    const acq = buildAcquisitionPlan(graph, market, plan, at(5));
    expect(acq.items).toHaveLength(1);
    const item = acq.items[0]!;
    expect(item.route.kind).toBe("find-in-raid");
    expect(item.reasons).toContain("route:find-in-raid:no-feasible-purchase");
    expect(item.reasons.some((r) => r.startsWith("blocked:flea:level-gate-15"))).toBe(true);
    expect(item.reasons.some((r) => r.startsWith("blocked:trader:trader-ll-gate-Prapor-LL4"))).toBe(true);
    // gated routes are still visible as alternatives
    expect(item.alternatives.map((a) => a.kind)).toEqual(expect.arrayContaining(["flea", "trader"]));
  });

  it("level 40, rep 0: LL stays 1 (rep gate), so flea wins despite pricier", () => {
    const acq = buildAcquisitionPlan(graph, market, plan, at(40, 0));
    const item = acq.items[0]!;
    expect(item.route.kind).toBe("flea");
    expect(item.route.totalCost).toBe(10_000);
    expect(item.reasons).toContain("route:flea:cheapest-feasible");
    // the cheaper-but-LL-gated trader offer is explained
    expect(item.reasons.some((r) => r.startsWith("skipped-cheaper:trader:"))).toBe(true);
  });

  it("level 40, rep 0.5: LL4 unlocked, cheaper trader offer becomes primary", () => {
    const acq = buildAcquisitionPlan(graph, market, plan, at(40, 0.5));
    const item = acq.items[0]!;
    expect(item.route.kind).toBe("trader");
    expect(item.route.totalCost).toBe(8_000);
    expect(item.route.traderGate).toBe("Prapor LL4");
  });
});

// ---------- FIR gating ----------

describe("found-in-raid items", () => {
  it("are NEVER routed to flea or trader (primary or alternatives)", () => {
    const itemId = "item-fir";
    const market = mkMarket({
      items: {
        [itemId]: mkItem(itemId, {
          fleaAvg24h: 500,
          traderOffers: [
            { trader: PRAPOR, priceRub: 400, currency: "RUB", minTraderLevel: 1, taskUnlock: null, buyLimit: null },
          ],
        }),
      },
    });
    const graph = mkGraph([mkTask("t1", [{ items: [itemId], count: 3, foundInRaid: true }])]);
    const plan = mkPlan([{ map: "factory", taskIds: ["t1"] }]);

    const acq = buildAcquisitionPlan(graph, market, plan, at(40, 1));
    const item = acq.items[0]!;
    expect(item.fir).toBe(true);
    expect(item.route.kind).toBe("find-in-raid");
    expect(item.route.raidIndex).toBe(1);
    for (const alt of item.alternatives) expect(["flea", "trader", "barter"]).not.toContain(alt.kind);
    expect(item.reasons).toContain("fir-required");
  });

  it("offer feasible crafts as FIR alternatives (craft outputs count as FIR)", () => {
    const itemId = "item-fir-craftable";
    const inputId = "item-input";
    const market = mkMarket({
      items: {
        [itemId]: mkItem(itemId, { fleaAvg24h: 30_000 }),
        [inputId]: mkItem(inputId, { fleaAvg24h: 1_000 }),
      },
      crafts: [
        {
          id: "c1",
          station: "station-med",
          level: 1,
          durationSec: 3600,
          taskUnlock: null,
          requiredItems: [{ item: inputId, count: 2, tool: false }],
          productItem: { item: itemId, count: 1 },
        },
      ],
    });
    const graph = mkGraph([mkTask("t1", [{ items: [itemId], count: 1, foundInRaid: true }])]);
    const plan = mkPlan([{ map: "factory", taskIds: ["t1"] }]);

    const acq = buildAcquisitionPlan(graph, market, plan, at(40));
    const item = acq.items[0]!;
    expect(item.route.kind).toBe("find-in-raid");
    expect(item.alternatives).toHaveLength(1);
    expect(item.alternatives[0]!.kind).toBe("craft");
    expect(item.reasons).toContain("alternative:craft-output-counts-as-fir");
  });

  it("routes FIR needs to a planned raid whose map matches the task's map", () => {
    const itemId = "item-fir-map";
    const market = mkMarket({ items: { [itemId]: mkItem(itemId) } });
    const graph = mkGraph([mkTask("t1", [{ items: [itemId], foundInRaid: true }], "map-shoreline")]);
    const plan = mkPlan([
      { map: "map-customs", taskIds: [] },
      { map: "map-shoreline", taskIds: ["t1"] },
    ]);
    const acq = buildAcquisitionPlan(graph, market, plan, at(20));
    expect(acq.items[0]!.route.raidIndex).toBe(2);
  });
});

// ---------- barter arithmetic ----------

describe("barter cost arithmetic", () => {
  it("cost = sum(input prices) x ceil(count/outputCount); unit = total/count", () => {
    const out = "item-out";
    const inA = "item-a";
    const inB = "item-b";
    const market = mkMarket({
      items: {
        [out]: mkItem(out, { fleaBanned: true }), // force the barter to win
        [inA]: mkItem(inA, { fleaAvg24h: 1_000 }),
        [inB]: mkItem(inB, { fleaAvg24h: 500 }),
      },
      barters: [
        {
          id: "b1",
          trader: PRAPOR,
          minTraderLevel: 1,
          taskUnlock: null,
          requiredItems: [
            { item: inA, count: 2 },
            { item: inB, count: 1 },
          ],
          offeredItem: { item: out, count: 2 },
        },
      ],
    });
    const graph = mkGraph([mkTask("t1", [{ items: [out], count: 3 }])]);
    const plan = mkPlan([{ map: "factory", taskIds: ["t1"] }]);

    const acq = buildAcquisitionPlan(graph, market, plan, at(20));
    const item = acq.items[0]!;
    expect(item.route.kind).toBe("barter");
    // inputs: 2x1000 + 1x500 = 2500 per trade; 3 needed / 2 per trade -> 2 trades
    expect(item.route.totalCost).toBe(5_000);
    expect(item.route.unitCost).toBe(Math.round(5_000 / 3));
    expect(acq.totalRubles).toBe(5_000);
  });

  it("flags barters whose inputs cannot be bought (must be found in raid)", () => {
    const out = "item-out2";
    const inA = "item-unbuyable";
    const market = mkMarket({
      items: {
        [out]: mkItem(out, { fleaBanned: true }),
        [inA]: mkItem(inA, { fleaBanned: true }), // no flea, no trader offers
      },
      barters: [
        {
          id: "b1",
          trader: PRAPOR,
          minTraderLevel: 1,
          taskUnlock: null,
          requiredItems: [{ item: inA, count: 1 }],
          offeredItem: { item: out, count: 1 },
        },
      ],
    });
    const graph = mkGraph([mkTask("t1", [{ items: [out] }])]);
    const plan = mkPlan([{ map: "factory", taskIds: ["t1"] }]);

    const acq = buildAcquisitionPlan(graph, market, plan, at(20));
    const item = acq.items[0]!;
    expect(item.route.kind).toBe("find-in-raid"); // barter infeasible
    expect(item.reasons.some((r) => r.startsWith("blocked:barter:barter-input-unbuyable"))).toBe(true);
    const barterAlt = item.alternatives.find((a) => a.kind === "barter");
    expect(barterAlt?.detail).toContain("must be found in raid");
  });
});

// ---------- craft schedule ----------

describe("craft schedule", () => {
  it("orders crafts by needing raid, longest first within a raid", () => {
    const mk = (suffix: string, minutes: number) => {
      const id = `item-craft-${suffix}`;
      return {
        item: mkItem(id, { fleaBanned: true }),
        craft: {
          id: `c-${suffix}`,
          station: "station-med",
          level: 1,
          durationSec: minutes * 60,
          taskUnlock: null,
          requiredItems: [{ item: "item-cheap", count: 1, tool: false }],
          productItem: { item: id, count: 1 },
        },
      };
    };
    const a = mk("a", 120); // needed raid 1
    const b = mk("b", 300); // needed raid 2
    const c = mk("c", 60); //  needed raid 1
    const market = mkMarket({
      items: {
        [a.item.id]: a.item,
        [b.item.id]: b.item,
        [c.item.id]: c.item,
        "item-cheap": mkItem("item-cheap", { fleaAvg24h: 100 }),
      },
      crafts: [a.craft, b.craft, c.craft],
    });
    const graph = mkGraph([
      mkTask("t1", [{ items: [a.item.id] }, { items: [c.item.id] }]),
      mkTask("t2", [{ items: [b.item.id] }]),
    ]);
    const plan = mkPlan([
      { map: "factory", taskIds: ["t1"] },
      { map: "customs", taskIds: ["t2"] },
    ]);

    const acq = buildAcquisitionPlan(graph, market, plan, at(20));
    expect(acq.craftSchedule.map((s) => s.itemId)).toEqual([a.item.id, c.item.id, b.item.id]);
    expect(acq.craftSchedule[0]!.startBy).toBe("before raid 1");
    expect(acq.craftSchedule[2]!.startBy).toBe("before raid 2");
    expect(acq.craftSchedule[0]!.minutes).toBe(120);
    expect(acq.craftSchedule[0]!.station).toBe("Medstation");
  });

  it("gates crafts on hideout station level when provided", () => {
    const id = "item-craft-gated";
    const market = mkMarket({
      items: { [id]: mkItem(id, { fleaBanned: true }), "item-cheap": mkItem("item-cheap", { fleaAvg24h: 100 }) },
      crafts: [
        {
          id: "c1",
          station: "station-med",
          level: 3,
          durationSec: 600,
          taskUnlock: null,
          requiredItems: [{ item: "item-cheap", count: 1, tool: false }],
          productItem: { item: id, count: 1 },
        },
      ],
    });
    const graph = mkGraph([mkTask("t1", [{ items: [id] }])]);
    const plan = mkPlan([{ map: "factory", taskIds: ["t1"] }]);

    const gated = buildAcquisitionPlan(graph, market, plan, at(20), { hideoutLevels: { "station-med": 1 } });
    expect(gated.items[0]!.route.kind).toBe("find-in-raid");
    expect(gated.items[0]!.reasons.some((r) => r.includes("craft-station-gate"))).toBe(true);

    const built = buildAcquisitionPlan(graph, market, plan, at(20), { hideoutLevels: { "station-med": 3 } });
    expect(built.items[0]!.route.kind).toBe("craft");
    expect(built.craftSchedule).toHaveLength(1);
  });
});

// ---------- need collection ----------

describe("need collection", () => {
  it("does not double-count findItem objectives that pair with a giveItem", () => {
    const id = "item-pair";
    const market = mkMarket({ items: { [id]: mkItem(id, { fleaAvg24h: 1_000 }) } });
    const graph = mkGraph([
      mkTask("t1", [
        { type: "findItem", items: [id], count: 3, foundInRaid: true },
        { type: "giveItem", items: [id], count: 3, foundInRaid: true },
      ]),
    ]);
    const plan = mkPlan([{ map: "factory", taskIds: ["t1"] }]);
    const acq = buildAcquisitionPlan(graph, market, plan, at(20));
    expect(acq.items).toHaveLength(1);
    expect(acq.items[0]!.count).toBe(3);
  });

  it("aggregates the same item across tasks and skips optional objectives", () => {
    const id = "item-shared";
    const market = mkMarket({ items: { [id]: mkItem(id, { fleaAvg24h: 1_000 }) } });
    const graph = mkGraph([
      mkTask("t1", [{ items: [id], count: 2 }]),
      mkTask("t2", [
        { items: [id], count: 1 },
        { items: ["item-optional"], count: 5, optional: true },
      ]),
    ]);
    const plan = mkPlan([{ map: "factory", taskIds: ["t1", "t2"] }]);
    const acq = buildAcquisitionPlan(graph, market, plan, at(20));
    expect(acq.items).toHaveLength(1);
    const item = acq.items[0]!;
    expect(item.count).toBe(3);
    expect(item.forTasks.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    expect(acq.totalRubles).toBe(3_000);
  });
});

// ---------- real-data smoke ----------

describe("real 1.0.6 Kappa plan smoke", () => {
  it("produces a non-empty, internally-consistent shopping list", () => {
    const world = loadWorld("regular");
    const market = loadMarket("regular", world.ref);
    const curve = new LevelCurve(world.playerLevels);
    const state = PlayerState.parse({ level: 15, faction: "USEC" });
    const sim = toSim(state, (l) => curve.xpForLevel(l));
    const goal = resolveGoalTasks(world.graph, [{ type: "kappa" }]);
    const plan = buildPlan(world.graph, sim, goal, curve, { horizon: 5 });

    const acq = buildAcquisitionPlan(world.graph, market, plan, state, { raids: 5 });

    expect(acq.raids).toBe(5);
    expect(acq.items.length).toBeGreaterThan(5);

    let sum = 0;
    for (const item of acq.items) {
      expect(item.count).toBeGreaterThan(0);
      expect(item.forTasks.length).toBeGreaterThan(0);
      expect(item.name).not.toMatch(/ Name$/); // display names resolved
      expect(item.reasons.length).toBeGreaterThan(0);
      // FIR needs never purchase routes
      if (item.fir) {
        expect(item.route.kind).toBe("find-in-raid");
        expect(item.route.raidIndex).toBeGreaterThanOrEqual(1);
        expect(item.route.raidIndex).toBeLessThanOrEqual(5);
        for (const alt of item.alternatives) expect(["flea", "trader", "barter"]).not.toContain(alt.kind);
      }
      // totalCost coherent with unitCost when both present
      if (item.route.unitCost != null && item.route.totalCost != null && item.route.kind !== "barter" && item.route.kind !== "craft") {
        expect(item.route.totalCost).toBe(item.route.unitCost * item.count);
      }
      // flea routes only when the player clears the gate
      if (item.route.kind === "flea") {
        expect(item.route.levelGate).toBeLessThanOrEqual(15);
      }
      sum += item.route.totalCost ?? 0;
    }
    expect(acq.totalRubles).toBe(sum); // totals = sum of parts

    // craft schedule rows reference scheduled craft items, ordered by raid
    const raids = acq.craftSchedule.map((s) => Number(/raid (\d+)/.exec(s.startBy)?.[1]));
    expect([...raids].sort((a, b) => a! - b!)).toEqual(raids);
  });
});
