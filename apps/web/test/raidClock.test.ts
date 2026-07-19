import { describe, expect, it } from "vitest";
import { runthroughStatus, fmtClock, DEFAULT_RUNTHROUGH_SEC } from "../src/lib/raidClock";

describe("raid clock — run-through status", () => {
  it("counts down toward the threshold and is not met before it", () => {
    const s = runthroughStatus(120, 420);
    expect(s.met).toBe(false);
    expect(s.remainingSec).toBe(300);
    expect(s.thresholdSec).toBe(420);
    expect(s.progress).toBeCloseTo(120 / 420, 5);
  });

  it("is met at and past the threshold, with clamped progress and zero remaining", () => {
    const at = runthroughStatus(420, 420);
    expect(at.met).toBe(true);
    expect(at.remainingSec).toBe(0);
    expect(at.progress).toBe(1);

    const past = runthroughStatus(999, 420);
    expect(past.met).toBe(true);
    expect(past.remainingSec).toBe(0);
    expect(past.progress).toBe(1); // clamped, never > 1
  });

  it("defaults to the 7-minute threshold and guards bad inputs", () => {
    expect(DEFAULT_RUNTHROUGH_SEC).toBe(420);
    expect(runthroughStatus(0).thresholdSec).toBe(420);
    // negative elapsed clamps to 0; non-positive threshold falls back to default
    expect(runthroughStatus(-50).remainingSec).toBe(420);
    expect(runthroughStatus(60, 0).thresholdSec).toBe(420);
  });

  it("ceils fractional remaining seconds so the visible clock never undershoots", () => {
    // 420 - 100.4 = 319.6 -> ceil 320
    expect(runthroughStatus(100.4, 420).remainingSec).toBe(320);
  });
});

describe("fmtClock", () => {
  it("formats m:ss under an hour and h:mm:ss past it", () => {
    expect(fmtClock(0)).toBe("0:00");
    expect(fmtClock(65)).toBe("1:05");
    expect(fmtClock(300)).toBe("5:00");
    expect(fmtClock(3661)).toBe("1:01:01");
  });

  it("floors fractional seconds and clamps negatives", () => {
    expect(fmtClock(59.9)).toBe("0:59");
    expect(fmtClock(-10)).toBe("0:00");
  });
});
