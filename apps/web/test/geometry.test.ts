import { describe, expect, it } from "vitest";
import {
  barBand,
  buildAreaPath,
  buildLinePath,
  clamp,
  compactNum,
  extent,
  histogram,
  linScale,
  nearestIndex,
  niceDomain,
  niceTicks,
  pctDelta,
  roundedTopBar,
} from "../src/components/charts/geometry";

describe("clamp", () => {
  it("bounds a value into [lo,hi]", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe("linScale", () => {
  it("maps domain endpoints onto range endpoints", () => {
    const s = linScale(0, 100, 0, 200);
    expect(s(0)).toBe(0);
    expect(s(50)).toBe(100);
    expect(s(100)).toBe(200);
  });
  it("inverts (range->domain) when passed reversed args", () => {
    const inv = linScale(0, 200, 0, 100);
    expect(inv(100)).toBe(50);
  });
  it("never divides by zero for a degenerate domain", () => {
    const s = linScale(5, 5, 0, 10);
    expect(Number.isFinite(s(5))).toBe(true);
  });
});

describe("extent", () => {
  it("returns min/max ignoring null/NaN/undefined", () => {
    expect(extent([3, null, 1, undefined, 9, NaN])).toEqual([1, 9]);
  });
  it("returns null when nothing is finite", () => {
    expect(extent([null, undefined, NaN])).toBeNull();
    expect(extent([])).toBeNull();
  });
});

describe("niceDomain", () => {
  it("anchors to zero when baselineZero is set", () => {
    const [lo] = niceDomain(20, 80, { baselineZero: true });
    expect(lo).toBe(0);
  });
  it("pads both ends when not zero-anchored", () => {
    const [lo, hi] = niceDomain(40, 60, { baselineZero: false, padFrac: 0.1 });
    expect(lo).toBeLessThan(40);
    expect(hi).toBeGreaterThan(60);
  });
  it("opens a window around a flat series", () => {
    const [lo, hi] = niceDomain(50, 50);
    expect(hi).toBeGreaterThan(lo);
  });
});

describe("niceTicks", () => {
  it("produces evenly spaced, human-friendly ticks spanning the range", () => {
    const ticks = niceTicks(0, 100, 5);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(100);
    const step = ticks[1]! - ticks[0]!;
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]! - ticks[i - 1]!).toBeCloseTo(step, 6);
    }
  });
  it("degrades to a single tick for a flat domain", () => {
    expect(niceTicks(42, 42)).toEqual([42]);
  });
  it("handles reversed inputs", () => {
    const ticks = niceTicks(100, 0, 5);
    expect(ticks[0]).toBe(0);
  });
});

describe("buildLinePath", () => {
  const sx = linScale(0, 3, 0, 30);
  const sy = linScale(0, 10, 100, 0);
  it("builds an M…L polyline", () => {
    const d = buildLinePath([0, 1, 2, 3], [0, 5, 10, 5], sx, sy);
    expect(d.startsWith("M")).toBe(true);
    expect(d).toContain("L");
  });
  it("breaks the line into separate segments across null gaps", () => {
    const d = buildLinePath([0, 1, 2, 3], [0, null, 10, 5], sx, sy);
    // two M commands: one before the gap, one after
    expect((d.match(/M/g) ?? []).length).toBe(2);
  });
  it("returns empty for all-null input", () => {
    expect(buildLinePath([0, 1], [null, null], sx, sy)).toBe("");
  });
});

describe("buildAreaPath", () => {
  const sx = linScale(0, 2, 0, 20);
  const sy = linScale(0, 10, 100, 0);
  it("closes each contiguous run down to the baseline with Z", () => {
    const d = buildAreaPath([0, 1, 2], [1, 2, 3], sx, sy, 100);
    expect(d).toContain("Z");
    expect(d.trim().endsWith("Z")).toBe(true);
  });
  it("emits one closed run per gap-separated segment", () => {
    const d = buildAreaPath([0, 1, 2], [1, null, 3], sx, sy, 100);
    expect((d.match(/Z/g) ?? []).length).toBe(2);
  });
});

describe("barBand", () => {
  it("splits width into N bands with a gap, centered", () => {
    const { step, bandWidth, xOf } = barBand(4, 400, 2);
    expect(step).toBe(100);
    expect(bandWidth).toBe(98);
    expect(xOf(0)).toBeCloseTo(1, 6);
    expect(xOf(1)).toBeCloseTo(101, 6);
  });
  it("is safe for zero categories", () => {
    expect(barBand(0, 100).bandWidth).toBe(0);
  });
});

describe("roundedTopBar", () => {
  it("produces a closed path anchored at the bar bottom", () => {
    const d = roundedTopBar(0, 0, 20, 50, 4);
    expect(d.startsWith("M")).toBe(true);
    expect(d.trim().endsWith("Z")).toBe(true);
    expect(d).toContain("Q"); // rounded corners
  });
  it("falls back to a plain rect when height < radius", () => {
    const d = roundedTopBar(0, 0, 20, 0, 4);
    expect(d).not.toContain("Q");
  });
});

describe("histogram", () => {
  it("buckets values into equal-width bins", () => {
    const bins = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5, [0, 10]);
    expect(bins).toHaveLength(5);
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(10);
    expect(bins[0]!.count).toBe(2); // 0,1
  });
  it("places the max value in the last bin (inclusive upper edge)", () => {
    const bins = histogram([10], 5, [0, 10]);
    expect(bins[4]!.count).toBe(1);
  });
  it("returns [] for empty input", () => {
    expect(histogram([])).toEqual([]);
  });
});

describe("nearestIndex", () => {
  it("finds the closest x index", () => {
    expect(nearestIndex([0, 10, 20, 30], 12)).toBe(1);
    expect(nearestIndex([0, 10, 20, 30], 26)).toBe(3);
  });
  it("returns -1 for empty", () => {
    expect(nearestIndex([], 5)).toBe(-1);
  });
});

describe("compactNum", () => {
  it("abbreviates thousands / millions / billions", () => {
    expect(compactNum(3400)).toBe("3.4k");
    expect(compactNum(1_200_000)).toBe("1.2M");
    expect(compactNum(2_000_000_000)).toBe("2B");
    expect(compactNum(950)).toBe("950");
  });
  it("strips trailing .0", () => {
    expect(compactNum(2000)).toBe("2k");
    expect(compactNum(5_000_000)).toBe("5M");
  });
});

describe("pctDelta", () => {
  it("computes signed fractional change", () => {
    expect(pctDelta(110, 100)).toBeCloseTo(0.1, 6);
    expect(pctDelta(80, 100)).toBeCloseTo(-0.2, 6);
  });
  it("returns null when prev is 0 or values are missing", () => {
    expect(pctDelta(10, 0)).toBeNull();
    expect(pctDelta(null, 100)).toBeNull();
    expect(pctDelta(10, undefined)).toBeNull();
  });
});
