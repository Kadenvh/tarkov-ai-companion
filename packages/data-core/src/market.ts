import { z } from "zod";
import type { GameMode } from "@tac/shared";
import { latestSnapshot, loadRaw, loadStrings, tr, type SnapshotRef } from "./snapshot.js";

/**
 * Market data loaders (feeds the Quartermaster, M3.5).
 * @tier T0 — pure parsing of committed snapshot files; never touches the game.
 *
 * Shapes verified against the real 1.0.6.0.46010 snapshot (2026-07-11):
 *  - items:   record under `items.items`, 5054 entries; flea prices as
 *             avg24hPrice/lastLowPrice/low24hPrice; per-item `minLevelForFlea`
 *             (0 = no extra gate beyond the global flea unlock); flea-banned
 *             items carry a `noFlea` type; trader economy as `buyFromTrader`
 *             / `sellToTrader` (NOT GraphQL's buyFor/sellFor) with `priceRUB`
 *             normalizing USD/EUR offers.
 *  - barters: flat array (779), {trader, minTraderLevel, taskUnlock,
 *             requiredItems[], offeredItem}.
 *  - crafts:  flat array (211), {station, level, duration(sec), taskUnlock?,
 *             requiredItems[] (attributes.tool = returned, not consumed),
 *             productItem}.
 *  - traders: record keyed by id (16), loyalty `levels[]` with
 *             requiredPlayerLevel/requiredReputation/requiredCommerce.
 *  - hideout: record keyed by station id (26), levels with constructionTime +
 *             itemRequirements (attributes.foundInRaid).
 *
 * All schemas are deliberately lenient: unknown keys are stripped, absent
 * fields tolerated, individual bad rows skipped and reported via `issues`
 * instead of failing the load.
 */

// ---------- raw (lenient) schemas ----------

const RawItemRef = z.object({
  item: z.string(),
  count: z.number().default(1),
  attributes: z.record(z.string(), z.unknown()).nullish(),
});

const RawTraderBuyOffer = z.object({
  trader: z.string(),
  price: z.number().nullish(),
  priceRUB: z.number().nullish(),
  currency: z.string().nullish(),
  minTraderLevel: z.number().nullish(),
  taskUnlock: z.string().nullish(),
  buyLimit: z.number().nullish(),
});

const RawTraderSellOffer = z.object({
  trader: z.string(),
  priceRUB: z.number().nullish(),
});

const RawItem = z.object({
  id: z.string(),
  name: z.string().nullish(),
  shortName: z.string().nullish(),
  normalizedName: z.string().nullish(),
  types: z.array(z.string()).default([]),
  basePrice: z.number().default(0),
  avg24hPrice: z.number().nullish(),
  lastLowPrice: z.number().nullish(),
  low24hPrice: z.number().nullish(),
  minLevelForFlea: z.number().nullish(),
  buyFromTrader: z.array(RawTraderBuyOffer).default([]),
  sellToTrader: z.array(RawTraderSellOffer).default([]),
});

const RawFleaMarket = z.object({
  enabled: z.boolean().default(true),
  minPlayerLevel: z.number().default(15),
  foundInRaidRequired: z.boolean().default(false),
});

const RawBarter = z.object({
  id: z.string(),
  trader: z.string(),
  taskUnlock: z.string().nullish(),
  minTraderLevel: z.number().nullish(),
  requiredItems: z.array(RawItemRef).default([]),
  offeredItem: RawItemRef,
});

const RawCraft = z.object({
  id: z.string(),
  station: z.string(),
  level: z.number().default(1),
  duration: z.number().default(0),
  taskUnlock: z.string().nullish(),
  requiredItems: z.array(RawItemRef).default([]),
  productItem: RawItemRef,
});

const RawTraderLevel = z.object({
  level: z.number(),
  requiredPlayerLevel: z.number().default(0),
  requiredReputation: z.number().default(0),
  requiredCommerce: z.number().default(0),
});

const RawTrader = z.object({
  id: z.string(),
  name: z.string().nullish(),
  normalizedName: z.string().nullish(),
  currency: z.string().nullish(),
  levels: z.array(RawTraderLevel).default([]),
});

const RawStationLevel = z.object({
  level: z.number(),
  constructionTime: z.number().default(0),
  itemRequirements: z.array(RawItemRef).default([]),
});

const RawStation = z.object({
  id: z.string(),
  name: z.string().nullish(),
  normalizedName: z.string().nullish(),
  levels: z.array(RawStationLevel).default([]),
});

// ---------- typed output ----------

export interface TraderCashOffer {
  trader: string;
  /** always in roubles (priceRUB normalizes USD/EUR traders) */
  priceRub: number;
  currency: string;
  minTraderLevel: number;
  taskUnlock: string | null;
  buyLimit: number | null;
}

export interface MarketItem {
  id: string;
  name: string;
  shortName: string;
  normalizedName?: string;
  types: string[];
  basePrice: number;
  /** carries the `noFlea` type — cannot be bought/sold on flea at all */
  fleaBanned: boolean;
  /** player level at which THIS item is flea-buyable: max(global unlock, per-item gate) */
  fleaLevelGate: number;
  fleaAvg24h: number | null;
  fleaLastLow: number | null;
  fleaLow24h: number | null;
  traderOffers: TraderCashOffer[];
  bestTraderSell: { trader: string; priceRub: number } | null;
}

export interface MarketBarter {
  id: string;
  trader: string;
  minTraderLevel: number;
  taskUnlock: string | null;
  requiredItems: { item: string; count: number }[];
  offeredItem: { item: string; count: number };
}

export interface MarketCraft {
  id: string;
  station: string;
  /** required station level */
  level: number;
  durationSec: number;
  taskUnlock: string | null;
  /** tool inputs are returned after the craft, not consumed */
  requiredItems: { item: string; count: number; tool: boolean }[];
  productItem: { item: string; count: number };
}

export interface TraderLoyaltyLevel {
  level: number;
  requiredPlayerLevel: number;
  requiredReputation: number;
  requiredCommerce: number;
}

export interface MarketTrader {
  id: string;
  name: string;
  normalizedName?: string;
  currency: string;
  levels: TraderLoyaltyLevel[];
}

export interface MarketStation {
  id: string;
  name: string;
  normalizedName?: string;
  levels: {
    level: number;
    constructionTimeSec: number;
    itemRequirements: { item: string; count: number; foundInRaid: boolean }[];
  }[];
}

export interface Market {
  ref: SnapshotRef;
  mode: GameMode;
  fleaEnabled: boolean;
  /** global flea unlock level (15 in 1.0.6 — read from data, not hardcoded) */
  fleaMinPlayerLevel: number;
  items: Record<string, MarketItem>;
  barters: MarketBarter[];
  crafts: MarketCraft[];
  traders: Record<string, MarketTrader>;
  stations: Record<string, MarketStation>;
  itemName: (id: string) => string;
  traderName: (id: string) => string;
  stationName: (id: string) => string;
  /** rows that failed lenient parsing (skipped, not fatal) */
  issues: string[];
}

/**
 * Loyalty level the player holds with a trader, derived from the data's level
 * gates (player level + reputation). `requiredCommerce` (lifetime spend) is
 * not player-observable from logs, so it is deliberately ignored — this makes
 * the derived LL an upper bound; callers may override with known LLs.
 */
export function loyaltyLevelFor(trader: MarketTrader, playerLevel: number, rep = 0): number {
  let best = 1;
  for (const lvl of trader.levels) {
    if (playerLevel >= lvl.requiredPlayerLevel && rep >= lvl.requiredReputation && lvl.level > best) {
      best = lvl.level;
    }
  }
  return best;
}

function parseArray<S extends z.ZodTypeAny>(
  raw: unknown,
  schema: S,
  label: string,
  issues: string[],
): z.output<S>[] {
  if (!Array.isArray(raw)) {
    issues.push(`${label}: expected array, got ${typeof raw}`);
    return [];
  }
  const out: z.output<S>[] = [];
  for (const row of raw) {
    const parsed = schema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
    else issues.push(`${label}: skipped row (${parsed.error.issues[0]?.message ?? "invalid"})`);
  }
  return out;
}

function parseRecord<S extends z.ZodTypeAny>(
  raw: unknown,
  schema: S,
  label: string,
  issues: string[],
): z.output<S>[] {
  if (raw === null || typeof raw !== "object") {
    issues.push(`${label}: expected record, got ${typeof raw}`);
    return [];
  }
  return parseArray(Object.values(raw), schema, label, issues);
}

/** Load the full market model (items+prices, barters, crafts, traders, hideout) for one game mode. */
export function loadMarket(mode: GameMode = "regular", ref: SnapshotRef = latestSnapshot()): Market {
  const issues: string[] = [];

  const itemStrings = loadStrings(ref, mode, "items");
  const traderStrings = loadStrings(ref, mode, "traders");
  const hideoutStrings = loadStrings(ref, mode, "hideout");

  const itemsRaw = loadRaw(ref, mode, "items") as { items?: unknown; fleaMarket?: unknown };
  const flea = RawFleaMarket.safeParse(itemsRaw.fleaMarket ?? {});
  const fleaInfo = flea.success ? flea.data : RawFleaMarket.parse({});
  if (!flea.success) issues.push("fleaMarket: failed to parse, using defaults");

  const items: Record<string, MarketItem> = {};
  for (const row of parseRecord(itemsRaw.items ?? {}, RawItem, "items", issues)) {
    const fleaBanned = row.types.includes("noFlea");
    items[row.id] = {
      id: row.id,
      name: tr(itemStrings, row.name ?? `${row.id} Name`),
      shortName: tr(itemStrings, row.shortName ?? `${row.id} ShortName`),
      ...(row.normalizedName ? { normalizedName: row.normalizedName } : {}),
      types: row.types,
      basePrice: row.basePrice,
      fleaBanned,
      fleaLevelGate: Math.max(fleaInfo.minPlayerLevel, row.minLevelForFlea ?? 0),
      fleaAvg24h: row.avg24hPrice ?? null,
      fleaLastLow: row.lastLowPrice ?? null,
      fleaLow24h: row.low24hPrice ?? null,
      traderOffers: row.buyFromTrader
        .filter((o) => (o.priceRUB ?? o.price) != null)
        .map((o) => ({
          trader: o.trader,
          priceRub: (o.priceRUB ?? o.price)!,
          currency: o.currency ?? "RUB",
          minTraderLevel: o.minTraderLevel ?? 1,
          taskUnlock: o.taskUnlock ?? null,
          buyLimit: o.buyLimit ?? null,
        })),
      bestTraderSell: row.sellToTrader.reduce<{ trader: string; priceRub: number } | null>(
        (best, o) =>
          o.priceRUB != null && (!best || o.priceRUB > best.priceRub)
            ? { trader: o.trader, priceRub: o.priceRUB }
            : best,
        null,
      ),
    };
  }

  const barters: MarketBarter[] = parseArray(loadRaw(ref, mode, "barters"), RawBarter, "barters", issues).map(
    (b) => ({
      id: b.id,
      trader: b.trader,
      minTraderLevel: b.minTraderLevel ?? 1,
      taskUnlock: b.taskUnlock ?? null,
      requiredItems: b.requiredItems.map((r) => ({ item: r.item, count: r.count })),
      offeredItem: { item: b.offeredItem.item, count: b.offeredItem.count },
    }),
  );

  const crafts: MarketCraft[] = parseArray(loadRaw(ref, mode, "crafts"), RawCraft, "crafts", issues).map((c) => ({
    id: c.id,
    station: c.station,
    level: c.level,
    durationSec: c.duration,
    taskUnlock: c.taskUnlock ?? null,
    requiredItems: c.requiredItems.map((r) => ({
      item: r.item,
      count: r.count,
      tool: Boolean(r.attributes?.["tool"]),
    })),
    productItem: { item: c.productItem.item, count: c.productItem.count },
  }));

  const traders: Record<string, MarketTrader> = {};
  for (const t of parseRecord(loadRaw(ref, mode, "traders"), RawTrader, "traders", issues)) {
    traders[t.id] = {
      id: t.id,
      name: tr(traderStrings, t.name ?? `${t.id} Nickname`),
      ...(t.normalizedName ? { normalizedName: t.normalizedName } : {}),
      currency: t.currency ?? "RUB",
      levels: t.levels,
    };
  }

  const stations: Record<string, MarketStation> = {};
  for (const s of parseRecord(loadRaw(ref, mode, "hideout"), RawStation, "hideout", issues)) {
    stations[s.id] = {
      id: s.id,
      name: tr(hideoutStrings, s.name ?? s.id),
      ...(s.normalizedName ? { normalizedName: s.normalizedName } : {}),
      levels: s.levels.map((l) => ({
        level: l.level,
        constructionTimeSec: l.constructionTime,
        itemRequirements: l.itemRequirements.map((r) => ({
          item: r.item,
          count: r.count,
          foundInRaid: Boolean(r.attributes?.["foundInRaid"]),
        })),
      })),
    };
  }

  return {
    ref,
    mode,
    fleaEnabled: fleaInfo.enabled,
    fleaMinPlayerLevel: fleaInfo.minPlayerLevel,
    items,
    barters,
    crafts,
    traders,
    stations,
    itemName: (id) => items[id]?.name ?? id,
    traderName: (id) => traders[id]?.name ?? id,
    stationName: (id) => stations[id]?.name ?? id,
    issues,
  };
}
