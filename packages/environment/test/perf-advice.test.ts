import { describe, expect, it } from "vitest";
import { perfAdvice, type HardwareFacts } from "../src/perf-advice.js";

const facts = (over: Partial<HardwareFacts>): HardwareFacts => ({
  logicalCores: 16,
  physicalCores: 8,
  totalRamGB: 32,
  ...over,
});

const pick = (hw: HardwareFacts, key: string) => perfAdvice(hw).find((a) => a.key === key)!;

describe("perfAdvice — Only use physical cores", () => {
  it("recommends ON with high confidence for a known 8-core CPU", () => {
    const a = pick(facts({ physicalCores: 8 }), "OnlyUsePhysicalCores");
    expect(a.recommend).toBe("on");
    expect(a.confidence).toBe("high");
    expect(a.why).toContain("8 physical cores");
  });

  it("recommends OFF for a known 4-core CPU", () => {
    const a = pick(facts({ physicalCores: 4, logicalCores: 8 }), "OnlyUsePhysicalCores");
    expect(a.recommend).toBe("off");
    expect(a.confidence).toBe("high");
  });

  it("falls back to a logical-thread estimate (medium confidence) when physical is unknown", () => {
    const on = pick(facts({ physicalCores: null, logicalCores: 16 }), "OnlyUsePhysicalCores");
    expect(on.recommend).toBe("on"); // ~8 physical estimated
    expect(on.confidence).toBe("medium");
    expect(on.why).toContain("estimated");

    const off = pick(facts({ physicalCores: null, logicalCores: 8 }), "OnlyUsePhysicalCores");
    expect(off.recommend).toBe("off"); // ~4 physical estimated
    expect(off.confidence).toBe("medium");
  });

  it("treats exactly 6 physical cores as the ON threshold", () => {
    expect(pick(facts({ physicalCores: 6 }), "OnlyUsePhysicalCores").recommend).toBe("on");
    expect(pick(facts({ physicalCores: 5 }), "OnlyUsePhysicalCores").recommend).toBe("off");
  });
});

describe("perfAdvice — Automatic RAM cleaner", () => {
  it("OFF (high) for 32 GB, ON (high) for 16 GB", () => {
    const big = pick(facts({ totalRamGB: 32 }), "AutomaticRamCleaner");
    expect(big.recommend).toBe("off");
    expect(big.confidence).toBe("high");

    const small = pick(facts({ totalRamGB: 16 }), "AutomaticRamCleaner");
    expect(small.recommend).toBe("on");
    expect(small.confidence).toBe("high");
  });

  it("borderline 24 GB leans OFF at medium confidence", () => {
    const a = pick(facts({ totalRamGB: 24 }), "AutomaticRamCleaner");
    expect(a.recommend).toBe("off");
    expect(a.confidence).toBe("medium");
  });

  it("always returns exactly the two settings", () => {
    const keys = perfAdvice(facts({})).map((a) => a.key).sort();
    expect(keys).toEqual(["AutomaticRamCleaner", "OnlyUsePhysicalCores"]);
  });
});
