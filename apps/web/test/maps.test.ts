import { describe, expect, it } from "vitest";
import { mapDeepLink, mapDisplayName, resolveMap } from "../src/lib/maps";
import { sparklinePath } from "../src/components/Sparkline";
import { fmtMinutes, fmtPct, fmtRubles, timeAgo } from "../src/lib/format";

describe("map registry", () => {
  it("resolves the planner's 24-hex ids, BSG nameIds, and display names", () => {
    expect(resolveMap("56f40101d2720b2a4d8b45d6")?.name).toBe("Customs");
    expect(resolveMap("bigmap")?.name).toBe("Customs");
    expect(resolveMap("Customs")?.normalizedName).toBe("customs");
    expect(resolveMap("factory4_night")?.name).toBe("Night Factory");
  });

  it("display name handles 'any', unknown hex ids, and slugs without crashing", () => {
    expect(mapDisplayName("any")).toBe("Any map");
    expect(mapDisplayName("ffffffffffffffffffffffff")).toBe("map ffffff…");
    expect(mapDisplayName("some_new_map")).toBe("Some New Map");
    expect(mapDisplayName(null)).toBe("(unknown)");
  });

  it("builds tarkov.dev deep links from any key form", () => {
    expect(mapDeepLink("tarkovstreets")).toBe("https://tarkov.dev/map/streets-of-tarkov");
    expect(mapDeepLink("5704e4dad2720bb55b8b4567")).toBe("https://tarkov.dev/map/lighthouse");
    expect(mapDeepLink("unknown-place")).toBeNull();
  });
});

describe("sparklinePath", () => {
  it("builds a bounded path across the viewbox", () => {
    const path = sparklinePath([0, 10, 5], 100, 50, 0);
    expect(path.startsWith("M0.0,50.0")).toBe(true); // min at bottom-left
    expect(path).toContain("L50.0,0.0"); // max at top-middle
    expect(path.split(" ")).toHaveLength(3);
  });

  it("handles empty and single-point series", () => {
    expect(sparklinePath([])).toBe("");
    expect(sparklinePath([5], 100, 50, 0)).toMatch(/^M50\.0,/);
  });
});

describe("format helpers", () => {
  it("formats rubles, percents, and minutes with em-dash fallbacks", () => {
    expect(fmtRubles(123456.7)).toBe("₽123,457");
    expect(fmtRubles(null)).toBe("—");
    expect(fmtPct(0.42)).toBe("42%");
    expect(fmtPct(null)).toBe("—");
    expect(fmtMinutes(95)).toBe("1 h 35 min");
    expect(fmtMinutes(45)).toBe("45 min");
  });

  it("timeAgo buckets sensibly", () => {
    const now = 1_000_000_000_000;
    expect(timeAgo(now - 5_000, now)).toBe("just now");
    expect(timeAgo(now - 30_000, now)).toBe("30s ago");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
  });
});
