import type { Market, TaskGraph } from "@tac/data-core";
import { loyaltyLevelFor } from "@tac/data-core";
import type { Plan } from "./director.js";
import type { PlayerState } from "./state.js";

/**
 * Quartermaster (M3.5) — per-item acquisition planning for the next N raids.
 * @tier T0 — pure computation over snapshot data + player state; never touches
 * the game or machine environment.
 *
 * Given a Plan (Raid Director output), collects every item the batched tasks
 * hand in / plant (giveItem, plantItem, non-duplicate findItem objectives),
 * enumerates acquisition routes per item (flea / trader cash / barter / craft /
 * find-in-raid), picks the cheapest FEASIBLE route for the current player
 * state (level, trader loyalty), and schedules crafts so outputs are ready
 * before the raid that needs them.
 *
 * Output shape is CONTRACTS.md §7 — binding.
 *
 * Grounded-in-data notes (verified against the 1.0.6.0.46010 snapshot):
 *  - Item objectives carry `items: string[]` (an any-of candidate list — e.g.
 *    "any 3 dogtags"), `count`, `foundInRaid`, `optional`.
 *  - 131 findItem objectives duplicate a giveItem in the same task ("find 3
 *    FIR, hand over 3"); counting both would double the need, so findItem is
 *    skipped when the same task has a giveItem sharing a candidate item.
 *  - Flea gate = max(global fleaMarket.minPlayerLevel, per-item
 *    minLevelForFlea) — both read from data, never hardcoded.
 *  - Purchased items are NOT found-in-raid, so FIR-required needs are never
 *    routed to flea/trader/barter. Hideout craft outputs DO count as FIR, so
 *    crafts appear as alternatives for FIR needs.
 *  - Currency needs (a few tasks hand in roubles directly) get a synthetic
 *    "trader" cash route at face value.
 */

// ---------- CONTRACTS §7 shapes ----------

export interface AcquisitionRoute {
  kind: "flea" | "trader" | "barter" | "craft" | "find-in-raid";
  detail: string;
  unitCost?: number;
  totalCost?: number;
  levelGate?: number;
  traderGate?: string;
  craftStation?: string;
  craftMinutes?: number;
  /** find-in-raid: which planned raid (1-based index into the plan) */
  raidIndex?: number;
}

export interface AcquisitionItem {
  itemId: string;
  name: string;
  count: number;
  fir: boolean;
  forTasks: { id: string; name: string }[];
  route: AcquisitionRoute;
  alternatives: AcquisitionRoute[];
  reasons: string[];
}

export interface AcquisitionPlan {
  raids: number;
  items: AcquisitionItem[];
  totalRubles: number;
  craftSchedule: { itemId: string; station: string; startBy: string; minutes: number }[];
}

// ---------- options ----------

export interface QuartermasterOptions {
  /** consider only the first N raids of the plan (default: all planned raids) */
  raids?: number;
  /**
   * station id -> built level. When provided, craft routes are gated strictly.
   * When absent, stations are assumed available (optimistic) and the item
   * carries an `assumed:hideout-built` reason so the UI/agent can flag it.
   */
  hideoutLevels?: Record<string, number>;
  /** include `optional: true` objectives (default false) */
  includeOptionalObjectives?: boolean;
  /** resolve map ids to display names in route detail strings (default: id) */
  mapName?: (id: string) => string;
  /** max barter alternatives kept per item (default 3) */
  maxBartersPerItem?: number;
}

// ---------- currency ----------

/** rouble/dollar/euro item ids (stable BSG ids) with face value in roubles. */
const CURRENCY_RUB_VALUE: Record<string, number> = {
  "5449016a4bdc2d6f028b456f": 1, // roubles
};

// ---------- internal need collection ----------

interface ItemObjectiveShape {
  type: string;
  optional?: boolean | undefined;
  items?: string[] | undefined;
  count?: number | undefined;
  foundInRaid?: boolean | undefined;
  maps?: string[] | undefined;
  zones?: { map?: string | undefined }[] | undefined;
}

interface Need {
  itemId: string;
  count: number;
  fir: boolean;
  forTasks: Map<string, string>; // id -> name
  /** earliest raid (1-based) whose batch needs this item */
  neededByRaid: number;
  /** maps where the item can be found/planted, from objective zones/maps + task map */
  hintMaps: Set<string>;
}

const NEED_OBJECTIVE_TYPES = new Set(["giveItem", "plantItem", "findItem"]);

/** Reference price used ONLY to pick a canonical candidate from an any-of list. */
function referencePrice(market: Market, itemId: string): number {
  const item = market.items[itemId];
  if (!item) return Number.MAX_SAFE_INTEGER;
  const trader = item.traderOffers.reduce<number | null>(
    (min, o) => (min === null || o.priceRub < min ? o.priceRub : min),
    null,
  );
  return item.fleaAvg24h ?? item.fleaLastLow ?? trader ?? item.basePrice;
}

function collectNeeds(
  graph: TaskGraph,
  market: Market,
  plan: Plan,
  raidCount: number,
  includeOptional: boolean,
): Map<string, Need> {
  // task id -> raid index that batches it; free tasks are needed before raid 1
  const taskRaid = new Map<string, number>();
  for (const free of plan.freeTasksCompleted) taskRaid.set(free.id, 1);
  for (const raid of plan.raids.slice(0, raidCount)) {
    for (const t of raid.tasks) taskRaid.set(t.id, raid.index);
  }

  const needs = new Map<string, Need>();
  for (const [taskId, raidIndex] of taskRaid) {
    const task = graph.tasks[taskId];
    if (!task) continue;
    const objectives = task.objectives as unknown as ItemObjectiveShape[];
    const givenItems = new Set(
      objectives.filter((o) => o.type === "giveItem").flatMap((o) => o.items ?? []),
    );

    for (const o of objectives) {
      if (!NEED_OBJECTIVE_TYPES.has(o.type)) continue;
      if (o.optional && !includeOptional) continue;
      const candidates = o.items ?? [];
      if (candidates.length === 0) continue;
      // findItem that pairs with a giveItem in the same task is the same items
      if (o.type === "findItem" && candidates.some((i) => givenItems.has(i))) continue;

      // canonical candidate: cheapest by reference price (any-of lists like dogtags)
      const itemId = [...candidates].sort((a, b) => referencePrice(market, a) - referencePrice(market, b))[0]!;
      const fir = Boolean(o.foundInRaid);
      const count = o.count ?? 1;
      const key = `${itemId}|${fir ? 1 : 0}`;

      const need =
        needs.get(key) ??
        needs
          .set(key, { itemId, count: 0, fir, forTasks: new Map(), neededByRaid: raidIndex, hintMaps: new Set() })
          .get(key)!;
      need.count += count;
      need.forTasks.set(taskId, task.name);
      need.neededByRaid = Math.min(need.neededByRaid, raidIndex);
      if (task.map) need.hintMaps.add(task.map);
      for (const m of o.maps ?? []) need.hintMaps.add(m);
      for (const z of o.zones ?? []) if (z.map) need.hintMaps.add(z.map);
    }
  }
  return needs;
}

// ---------- route enumeration ----------

interface RatedRoute {
  route: AcquisitionRoute;
  feasible: boolean;
  /** machine-readable gate tag when infeasible, e.g. "level-gate-20" */
  blockedBy?: string;
}

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

function fleaPrice(market: Market, itemId: string): number | null {
  const item = market.items[itemId];
  if (!item || item.fleaBanned || !market.fleaEnabled) return null;
  return item.fleaAvg24h ?? item.fleaLastLow ?? item.fleaLow24h;
}

/**
 * Cheapest per-unit BUY price for an input item at the current player state
 * (flea at level, trader cash at loyalty). One level of recursion only: inputs
 * are priced by direct purchase, never by their own barters/crafts.
 */
function inputUnitPrice(
  market: Market,
  state: PlayerState,
  completed: Set<string>,
  itemId: string,
): { price: number; source: "flea" | "trader" } | null {
  const item = market.items[itemId];
  if (!item) return null;
  let best: { price: number; source: "flea" | "trader" } | null = null;

  const flea = fleaPrice(market, itemId);
  if (flea != null && state.level >= item.fleaLevelGate) best = { price: flea, source: "flea" };

  for (const offer of item.traderOffers) {
    const trader = market.traders[offer.trader];
    if (!trader) continue;
    const ll = loyaltyLevelFor(trader, state.level, state.traderRep[offer.trader] ?? 0);
    if (ll < offer.minTraderLevel) continue;
    if (offer.taskUnlock && !completed.has(offer.taskUnlock)) continue;
    if (!best || offer.priceRub < best.price) best = { price: offer.priceRub, source: "trader" };
  }
  return best;
}

function enumerateRoutes(
  market: Market,
  state: PlayerState,
  completed: Set<string>,
  need: Need,
  plan: Plan,
  raidCount: number,
  opts: Required<Pick<QuartermasterOptions, "maxBartersPerItem">> & QuartermasterOptions,
): { routes: RatedRoute[]; findInRaid: RatedRoute } {
  const routes: RatedRoute[] = [];
  const item = market.items[need.itemId];
  const name = item?.name ?? need.itemId;
  const mapName = opts.mapName ?? ((id: string) => id);

  // --- currency (roubles handed in directly) ---
  const faceValue = CURRENCY_RUB_VALUE[need.itemId];
  if (faceValue != null) {
    routes.push({
      feasible: true,
      route: {
        kind: "trader",
        detail: `Cash — bring ${fmt(need.count * faceValue)} ₽`,
        unitCost: faceValue,
        totalCost: need.count * faceValue,
      },
    });
  }

  // --- flea ---
  const flea = fleaPrice(market, need.itemId);
  if (item && flea != null) {
    const gate = item.fleaLevelGate;
    const feasible = state.level >= gate;
    routes.push({
      feasible,
      ...(feasible ? {} : { blockedBy: `level-gate-${gate}` }),
      route: {
        kind: "flea",
        detail: `Flea market @ ~${fmt(flea)} ₽${feasible ? "" : ` (unlocks at level ${gate})`}`,
        unitCost: flea,
        totalCost: flea * need.count,
        levelGate: gate,
      },
    });
  }

  // --- trader cash offers (best offer per trader) ---
  if (item) {
    const bestPerTrader = new Map<string, (typeof item.traderOffers)[number]>();
    for (const o of item.traderOffers) {
      const prev = bestPerTrader.get(o.trader);
      if (!prev || o.priceRub < prev.priceRub) bestPerTrader.set(o.trader, o);
    }
    for (const offer of bestPerTrader.values()) {
      const trader = market.traders[offer.trader];
      if (!trader) continue;
      const ll = loyaltyLevelFor(trader, state.level, state.traderRep[offer.trader] ?? 0);
      const llOk = ll >= offer.minTraderLevel;
      const unlockOk = !offer.taskUnlock || completed.has(offer.taskUnlock);
      const feasible = llOk && unlockOk;
      const blockedBy = !llOk
        ? `trader-ll-gate-${trader.name}-LL${offer.minTraderLevel}`
        : !unlockOk
          ? `task-unlock-${offer.taskUnlock}`
          : undefined;
      routes.push({
        feasible,
        ...(blockedBy ? { blockedBy } : {}),
        route: {
          kind: "trader",
          detail: `${trader.name} LL${offer.minTraderLevel} @ ${fmt(offer.priceRub)} ₽${unlockOk ? "" : " (task-locked)"}`,
          unitCost: offer.priceRub,
          totalCost: offer.priceRub * need.count,
          traderGate: `${trader.name} LL${offer.minTraderLevel}`,
        },
      });
    }
  }

  // --- barters (cost = sum of input purchase prices, 1 recursion level) ---
  const barterRoutes: RatedRoute[] = [];
  for (const barter of market.barters) {
    if (barter.offeredItem.item !== need.itemId) continue;
    const trader = market.traders[barter.trader];
    if (!trader) continue;
    const ll = loyaltyLevelFor(trader, state.level, state.traderRep[barter.trader] ?? 0);
    const llOk = ll >= barter.minTraderLevel;
    const unlockOk = !barter.taskUnlock || completed.has(barter.taskUnlock);

    let inputCost = 0;
    const unbuyable: string[] = [];
    const inputBits: string[] = [];
    for (const input of barter.requiredItems) {
      const priced = inputUnitPrice(market, state, completed, input.item);
      const inputName = market.itemName(input.item);
      inputBits.push(`${input.count}× ${inputName}`);
      if (priced == null) unbuyable.push(inputName);
      else inputCost += priced.price * input.count;
    }
    const outputCount = Math.max(1, barter.offeredItem.count);
    const trades = Math.ceil(need.count / outputCount);
    const totalCost = trades * inputCost;
    const feasible = llOk && unlockOk && unbuyable.length === 0;
    const blockedBy = !llOk
      ? `trader-ll-gate-${trader.name}-LL${barter.minTraderLevel}`
      : !unlockOk
        ? `task-unlock-${barter.taskUnlock}`
        : unbuyable.length > 0
          ? `barter-input-unbuyable-${unbuyable.join(",")}`
          : undefined;
    barterRoutes.push({
      feasible,
      ...(blockedBy ? { blockedBy } : {}),
      route: {
        kind: "barter",
        detail:
          `Barter at ${trader.name} LL${barter.minTraderLevel}: ${inputBits.join(" + ")}` +
          (unbuyable.length ? ` — input${unbuyable.length > 1 ? "s" : ""} ${unbuyable.join(", ")} must be found in raid` : ""),
        unitCost: Math.round(totalCost / Math.max(1, need.count)),
        totalCost,
        traderGate: `${trader.name} LL${barter.minTraderLevel}`,
      },
    });
  }
  barterRoutes.sort((a, b) => (a.route.totalCost ?? Infinity) - (b.route.totalCost ?? Infinity));
  routes.push(...barterRoutes.slice(0, opts.maxBartersPerItem));

  // --- crafts ---
  for (const craft of market.crafts) {
    if (craft.productItem.item !== need.itemId) continue;
    const station = market.stations[craft.station];
    const stationName = station?.name ?? craft.station;
    const builtLevel = opts.hideoutLevels?.[craft.station];
    const stationOk = opts.hideoutLevels === undefined || (builtLevel ?? 0) >= craft.level;
    const unlockOk = !craft.taskUnlock || completed.has(craft.taskUnlock);

    let inputCost = 0;
    const unbuyable: string[] = [];
    for (const input of craft.requiredItems) {
      if (input.tool) continue; // tools are returned, not consumed
      const priced = inputUnitPrice(market, state, completed, input.item);
      if (priced == null) unbuyable.push(market.itemName(input.item));
      else inputCost += priced.price * input.count;
    }
    const outputCount = Math.max(1, craft.productItem.count);
    const batches = Math.ceil(need.count / outputCount);
    const totalCost = batches * inputCost;
    const minutes = Math.round((craft.durationSec * batches) / 60);
    const feasible = stationOk && unlockOk && unbuyable.length === 0;
    const blockedBy = !stationOk
      ? `craft-station-gate-${stationName}-${craft.level}`
      : !unlockOk
        ? `task-unlock-${craft.taskUnlock}`
        : unbuyable.length > 0
          ? `craft-input-unbuyable-${unbuyable.join(",")}`
          : undefined;
    routes.push({
      feasible,
      ...(blockedBy ? { blockedBy } : {}),
      route: {
        kind: "craft",
        detail: `Craft at ${stationName} lvl ${craft.level} (${minutes} min for ${batches * outputCount})`,
        unitCost: Math.round(totalCost / Math.max(1, need.count)),
        totalCost,
        craftStation: stationName,
        craftMinutes: minutes,
      },
    });
  }

  // --- find-in-raid (always constructible) ---
  const consideredRaids = plan.raids.slice(0, raidCount);
  const matched = consideredRaids.find((r) => need.hintMaps.has(r.map));
  const target = matched ?? consideredRaids[0];
  const raidIndex = target?.index ?? 1;
  const where = target ? (target.map === "any" ? "any map" : mapName(target.map)) : "next raid";
  const findInRaid: RatedRoute = {
    feasible: true,
    route: {
      kind: "find-in-raid",
      detail: `Find in raid ${raidIndex} (${where})${matched ? " — map matches a known find location" : ""}`,
      raidIndex,
    },
  };

  return { routes, findInRaid };
}

// ---------- plan assembly ----------

export function buildAcquisitionPlan(
  graph: TaskGraph,
  market: Market,
  plan: Plan,
  state: PlayerState,
  opts: QuartermasterOptions = {},
): AcquisitionPlan {
  const raidCount = Math.max(1, Math.min(opts.raids ?? plan.raids.length, plan.raids.length || 1));
  const completed = new Set(state.completedTasks);
  const fullOpts = { ...opts, maxBartersPerItem: opts.maxBartersPerItem ?? 3 };

  const needs = collectNeeds(graph, market, plan, raidCount, opts.includeOptionalObjectives ?? false);

  const items: AcquisitionItem[] = [];
  for (const need of needs.values()) {
    const { routes, findInRaid } = enumerateRoutes(market, state, completed, need, plan, raidCount, fullOpts);
    const reasons: string[] = [`needed-by:raid-${need.neededByRaid}`];

    let primary: AcquisitionRoute;
    let alternatives: AcquisitionRoute[];

    if (need.fir) {
      // Purchases are never found-in-raid; crafted outputs are.
      reasons.push("fir-required", "route:find-in-raid:fir-required");
      primary = findInRaid.route;
      alternatives = routes
        .filter((r) => r.route.kind === "craft" && r.feasible)
        .sort((a, b) => (a.route.totalCost ?? Infinity) - (b.route.totalCost ?? Infinity))
        .map((r) => r.route);
      if (alternatives.length > 0) reasons.push("alternative:craft-output-counts-as-fir");
    } else {
      const feasible = routes
        .filter((r) => r.feasible)
        .sort((a, b) => (a.route.totalCost ?? Infinity) - (b.route.totalCost ?? Infinity));
      const infeasible = routes
        .filter((r) => !r.feasible)
        .sort((a, b) => (a.route.totalCost ?? Infinity) - (b.route.totalCost ?? Infinity));

      if (feasible.length > 0) {
        primary = feasible[0]!.route;
        alternatives = [...feasible.slice(1).map((r) => r.route), ...infeasible.map((r) => r.route), findInRaid.route];
        reasons.push(`route:${primary.kind}:cheapest-feasible`);
        // explain any cheaper-but-gated route that lost
        for (const r of infeasible) {
          if ((r.route.totalCost ?? Infinity) < (primary.totalCost ?? Infinity) && r.blockedBy) {
            reasons.push(`skipped-cheaper:${r.route.kind}:${r.blockedBy}`);
          }
        }
      } else {
        primary = findInRaid.route;
        alternatives = infeasible.map((r) => r.route);
        reasons.push("route:find-in-raid:no-feasible-purchase");
        for (const r of infeasible) if (r.blockedBy) reasons.push(`blocked:${r.route.kind}:${r.blockedBy}`);
      }
      if (primary.kind === "craft" && opts.hideoutLevels === undefined) reasons.push("assumed:hideout-built");
    }

    items.push({
      itemId: need.itemId,
      name: market.itemName(need.itemId),
      count: need.count,
      fir: need.fir,
      forTasks: [...need.forTasks].map(([id, name]) => ({ id, name })),
      route: primary,
      alternatives,
      reasons,
    });
  }

  // stable, glanceable ordering: by needing raid, then cost desc, then name
  const neededBy = (it: AcquisitionItem): number =>
    Number(/needed-by:raid-(\d+)/.exec(it.reasons[0] ?? "")?.[1] ?? 1);
  items.sort(
    (a, b) =>
      neededBy(a) - neededBy(b) ||
      (b.route.totalCost ?? 0) - (a.route.totalCost ?? 0) ||
      a.name.localeCompare(b.name),
  );

  const totalRubles = items.reduce((s, it) => s + (it.route.totalCost ?? 0), 0);

  // crafts ordered so outputs are ready before the raid that needs them:
  // earlier raids first; within a raid, longest crafts start first
  const craftSchedule = items
    .filter((it) => it.route.kind === "craft")
    .map((it) => ({
      itemId: it.itemId,
      station: it.route.craftStation ?? "unknown",
      startBy: `before raid ${neededBy(it)}`,
      minutes: it.route.craftMinutes ?? 0,
      _raid: neededBy(it),
    }))
    .sort((a, b) => a._raid - b._raid || b.minutes - a.minutes)
    .map(({ _raid, ...row }) => row);

  return { raids: raidCount, items, totalRubles, craftSchedule };
}
