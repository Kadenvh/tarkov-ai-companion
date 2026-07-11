import { describe, expect, it } from "vitest";
import { loadMarket, loyaltyLevelFor } from "../src/market.js";

/**
 * Market loaders against the REAL committed 1.0.6 snapshot — counts are
 * floors, not exact values, so a re-snapshot doesn't break the suite.
 */

const market = loadMarket("regular");

describe("loadMarket (real 1.0.6 snapshot)", () => {
  it("parses items with prices and resolves display names", () => {
    expect(Object.keys(market.items).length).toBeGreaterThan(4000);

    // Salewa first aid kit — stable BSG id
    const salewa = market.items["544fb45d4bdc2dee738b4568"];
    expect(salewa).toBeDefined();
    expect(salewa!.name.toLowerCase()).toContain("salewa");
    expect(salewa!.name).not.toMatch(/^[0-9a-f]{24}/); // resolved, not a key
    expect(salewa!.fleaLevelGate).toBeGreaterThanOrEqual(market.fleaMinPlayerLevel);

    // at least half the catalog has some flea price signal
    const priced = Object.values(market.items).filter((i) => i.fleaAvg24h != null || i.fleaLastLow != null);
    expect(priced.length).toBeGreaterThan(1000);
  });

  it("reads the global flea unlock from data (15 in 1.0.6)", () => {
    expect(market.fleaEnabled).toBe(true);
    expect(market.fleaMinPlayerLevel).toBe(15);
  });

  it("marks flea-banned items", () => {
    const banned = Object.values(market.items).filter((i) => i.fleaBanned);
    expect(banned.length).toBeGreaterThan(500); // 1236 in 1.0.6
    for (const item of banned) expect(item.types).toContain("noFlea");
  });

  it("normalizes trader cash offers to roubles", () => {
    const withOffers = Object.values(market.items).filter((i) => i.traderOffers.length > 0);
    expect(withOffers.length).toBeGreaterThan(200);
    for (const item of withOffers.slice(0, 50)) {
      for (const offer of item.traderOffers) {
        expect(offer.priceRub).toBeGreaterThan(0);
        expect(offer.minTraderLevel).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("parses hundreds of barters with inputs and outputs", () => {
    expect(market.barters.length).toBeGreaterThan(500); // 779 in 1.0.6
    for (const b of market.barters) {
      expect(b.offeredItem.item).toMatch(/^[0-9a-f]{24}$/);
      expect(b.requiredItems.length).toBeGreaterThan(0);
      expect(b.minTraderLevel).toBeGreaterThanOrEqual(1);
    }
  });

  it("parses ~200+ crafts with stations and durations", () => {
    expect(market.crafts.length).toBeGreaterThanOrEqual(200); // 211 in 1.0.6
    for (const c of market.crafts) {
      expect(market.stations[c.station]).toBeDefined();
      expect(c.durationSec).toBeGreaterThanOrEqual(0);
      expect(c.level).toBeGreaterThanOrEqual(1);
    }
  });

  it("parses traders with loyalty ladders and resolves names", () => {
    expect(Object.keys(market.traders).length).toBeGreaterThanOrEqual(8); // 16 in 1.0.6
    const prapor = market.traders["54cb50c76803fa8b248b4571"];
    expect(prapor).toBeDefined();
    expect(prapor!.name.toLowerCase()).toBe("prapor");
    expect(prapor!.levels.length).toBeGreaterThanOrEqual(4);
    // ladder is monotonic in player level
    const reqs = prapor!.levels.map((l) => l.requiredPlayerLevel);
    expect([...reqs].sort((a, b) => a - b)).toEqual(reqs);
  });

  it("parses hideout stations with item requirements + FIR flags", () => {
    expect(Object.keys(market.stations).length).toBeGreaterThanOrEqual(20); // 26 in 1.0.6
    const withReqs = Object.values(market.stations).filter((s) =>
      s.levels.some((l) => l.itemRequirements.length > 0),
    );
    expect(withReqs.length).toBeGreaterThan(10);
  });

  it("reports issues instead of throwing, and stays near-clean on real data", () => {
    expect(market.issues.length).toBeLessThan(20);
  });
});

describe("loyaltyLevelFor", () => {
  const prapor = market.traders["54cb50c76803fa8b248b4571"]!;

  it("is LL1 for a fresh account", () => {
    expect(loyaltyLevelFor(prapor, 1, 0)).toBe(1);
  });

  it("requires BOTH player level and reputation", () => {
    // level 40 but zero rep: still LL1 (LL2 needs 0.2 rep in 1.0.6)
    expect(loyaltyLevelFor(prapor, 40, 0)).toBe(1);
    // enough rep for LL2+ at level 40
    expect(loyaltyLevelFor(prapor, 40, 1)).toBeGreaterThanOrEqual(3);
  });

  it("never exceeds the ladder", () => {
    expect(loyaltyLevelFor(prapor, 79, 100)).toBeLessThanOrEqual(4);
  });
});
