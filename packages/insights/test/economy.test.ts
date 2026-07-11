import { describe, expect, it, beforeAll } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openFixtureDb, seedStandardFixture, insertFleaSale } from "./fixtures/build.js";
import { fleaIncome, netWorthEstimate, NET_WORTH_CAVEATS } from "../src/economy.js";

// Fixture sales (test/fixtures/build.ts):
//   2026-07-01: 10_000 + 5_000 = 15_000 (2 sales)
//   2026-07-02: 20_000            (1 sale)
//   2026-07-08: 40_000            (1 sale)
// Total 75_000 across 4 sales. 2026-07-01 is a Wednesday, so its ISO-week
// Monday is 2026-06-29; 2026-07-08's is 2026-07-06.

let db: DatabaseSync;

beforeAll(() => {
  db = openFixtureDb();
  seedStandardFixture(db);
});

describe("fleaIncome", () => {
  it("computes daily sums and a cumulative curve (no zero-fill)", () => {
    const income = fleaIncome(db, "daily");
    expect(income.bucket).toBe("daily");
    expect(income.points).toEqual([
      { period: "2026-07-01", total: 15_000, count: 2, cumulative: 15_000 },
      { period: "2026-07-02", total: 20_000, count: 1, cumulative: 35_000 },
      { period: "2026-07-08", total: 40_000, count: 1, cumulative: 75_000 },
    ]);
    expect(income.totalIncome).toBe(75_000);
    expect(income.n).toBe(4);
    expect(income.lowConfidence).toBe(true); // 4 < 5 — small-n honesty
    expect(income.excluded).toBe(0);
  });

  it("buckets weekly on the ISO-week Monday", () => {
    const income = fleaIncome(db, "weekly");
    expect(income.points).toEqual([
      { period: "2026-06-29", total: 35_000, count: 3, cumulative: 35_000 },
      { period: "2026-07-06", total: 40_000, count: 1, cumulative: 75_000 },
    ]);
    expect(income.totalIncome).toBe(75_000);
  });

  it("defaults to daily bucketing", () => {
    expect(fleaIncome(db).bucket).toBe("daily");
  });

  it("excludes sales whose timestamp has no parseable date", () => {
    const mini = openFixtureDb();
    insertFleaSale(mini, "Bolts", 1_000, "not-a-timestamp");
    insertFleaSale(mini, "Screws", 2_000, "2026-07-03T10:00:00");
    const income = fleaIncome(mini, "daily");
    expect(income.excluded).toBe(1);
    expect(income.n).toBe(1);
    expect(income.points).toEqual([{ period: "2026-07-03", total: 2_000, count: 1, cumulative: 2_000 }]);
  });

  it("returns an empty curve for an empty ledger", () => {
    const mini = openFixtureDb();
    const income = fleaIncome(mini);
    expect(income.points).toEqual([]);
    expect(income.totalIncome).toBe(0);
    expect(income.n).toBe(0);
    expect(income.lowConfidence).toBe(true);
  });
});

describe("netWorthEstimate", () => {
  it("is always labeled an estimate and carries the documented caveats", () => {
    const est = netWorthEstimate(db);
    expect(est.isEstimate).toBe(true);
    expect(est.method).toContain("heuristic");
    expect(est.caveats).toEqual([...NET_WORTH_CAVEATS]);
    expect(est.caveats.length).toBeGreaterThanOrEqual(4);
  });

  it("with default config the curve is plain cumulative flea income, gap-filled per day", () => {
    const est = netWorthEstimate(db);
    expect(est.config).toEqual({ startingRubles: 0, dailySpendRubles: 0 });
    // one point per calendar day 07-01..07-08 inclusive
    expect(est.points.map((p) => p.day)).toEqual([
      "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04",
      "2026-07-05", "2026-07-06", "2026-07-07", "2026-07-08",
    ]);
    expect(est.points[0]).toEqual({ day: "2026-07-01", fleaCumulative: 15_000, estimatedNetWorth: 15_000 });
    expect(est.points[2]).toEqual({ day: "2026-07-03", fleaCumulative: 35_000, estimatedNetWorth: 35_000 });
    expect(est.points[7]).toEqual({ day: "2026-07-08", fleaCumulative: 75_000, estimatedNetWorth: 75_000 });
    expect(est.n).toBe(4);
    expect(est.lowConfidence).toBe(true);
  });

  it("applies startingRubles and the flat daily spend heuristic", () => {
    const est = netWorthEstimate(db, { startingRubles: 100_000, dailySpendRubles: 1_000 });
    // day 0 (07-01): 100_000 + 15_000 − 0
    expect(est.points[0]!.estimatedNetWorth).toBe(115_000);
    // day 2 (07-03): 100_000 + 35_000 − 2·1_000
    expect(est.points[2]!.estimatedNetWorth).toBe(133_000);
    // day 7 (07-08): 100_000 + 75_000 − 7·1_000
    expect(est.points[7]!.estimatedNetWorth).toBe(168_000);
  });

  it("rejects a negative spend rate at the zod boundary", () => {
    expect(() => netWorthEstimate(db, { dailySpendRubles: -5 })).toThrow();
  });

  it("returns an empty estimate for an empty ledger", () => {
    const mini = openFixtureDb();
    const est = netWorthEstimate(mini);
    expect(est.points).toEqual([]);
    expect(est.n).toBe(0);
    expect(est.isEstimate).toBe(true);
    expect(est.lowConfidence).toBe(true);
  });
});
