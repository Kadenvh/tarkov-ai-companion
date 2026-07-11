import { beforeAll, describe, expect, it } from "vitest";
import { buildAmmoTable, ammoByCaliber, classifyAmmoTier, topAmmoForBriefing, type AmmoEntry } from "../src/ammo.js";

let table: AmmoEntry[];

beforeAll(() => {
  table = buildAmmoTable("regular"); // real committed 1.0.6 snapshot
});

describe("tier classification", () => {
  it("maps penetration thresholds to tiers", () => {
    expect(classifyAmmoTier(60)).toBe("S");
    expect(classifyAmmoTier(54)).toBe("S");
    expect(classifyAmmoTier(53)).toBe("A");
    expect(classifyAmmoTier(47)).toBe("A");
    expect(classifyAmmoTier(40)).toBe("B");
    expect(classifyAmmoTier(33)).toBe("C");
    expect(classifyAmmoTier(26)).toBe("D");
    expect(classifyAmmoTier(20)).toBe("E");
    expect(classifyAmmoTier(19)).toBe("F");
    expect(classifyAmmoTier(0)).toBe("F");
  });
});

describe("ammo table from the real 1.0.6 snapshot", () => {
  it("builds a substantial table of bullets/buckshot with resolved names", () => {
    expect(table.length).toBeGreaterThan(150);
    for (const entry of table.slice(0, 20)) {
      expect(entry.id).toMatch(/^[0-9a-f]{24}$/);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.penetration).toBeGreaterThanOrEqual(0);
    }
  });

  it("spot-check: M855A1 penetrates better (and tiers higher) than M855", () => {
    const m855a1 = table.find((a) => a.shortName === "M855A1");
    const m855 = table.find((a) => a.shortName === "M855");
    expect(m855a1).toBeDefined();
    expect(m855).toBeDefined();
    expect(m855a1!.penetration).toBeGreaterThan(m855!.penetration);
    expect(m855a1!.tier < m855!.tier).toBe(true); // "B" < "D" lexicographically = better
    expect(m855a1!.caliber).toBe("Caliber556x45NATO");
  });

  it("buckshot rounds carry projectileCount > 1 and a meaningful totalDamage", () => {
    const buckshot = table.filter((a) => a.projectileCount > 1);
    expect(buckshot.length).toBeGreaterThan(0);
    for (const b of buckshot) {
      expect(b.totalDamage).toBe(b.damage * b.projectileCount);
      expect(b.totalDamage).toBeGreaterThan(b.damage);
    }
  });
});

describe("caliber filtering + briefing helper", () => {
  it("ammoByCaliber accepts loose fragments and sorts by penetration desc", () => {
    for (const query of ["556", "5.56x45", "Caliber556x45NATO"]) {
      const rounds = ammoByCaliber(table, query);
      expect(rounds.length).toBeGreaterThan(5);
      for (let i = 1; i < rounds.length; i++) {
        expect(rounds[i]!.penetration).toBeLessThanOrEqual(rounds[i - 1]!.penetration);
      }
    }
  });

  it("topAmmoForBriefing returns N entries with tier + sourcing reasons", () => {
    const top = topAmmoForBriefing(table, "762x39", 3);
    expect(top).toHaveLength(3);
    for (const { entry, reason } of top) {
      expect(reason).toContain(entry.shortName);
      expect(reason).toMatch(/tier [SABCDEF] \(pen \d+/);
      if (entry.fleaBanned) expect(reason).toContain("not on flea");
    }
  });
});
