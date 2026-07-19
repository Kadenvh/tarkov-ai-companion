import { describe, expect, it } from "vitest";
import {
  runthroughStatus,
  scavStatus,
  intelCenterCooldown,
  fmtClock,
  DEFAULT_RUNTHROUGH_SEC,
  DEFAULT_SCAV_COOLDOWN_SEC,
} from "../src/lib/raidClock";

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

describe("scav cooldown", () => {
  it("Intel Center trims the base cooldown per the monitor's factors", () => {
    expect(DEFAULT_SCAV_COOLDOWN_SEC).toBe(1500);
    expect(intelCenterCooldown(1500, 0)).toBe(1500);
    expect(intelCenterCooldown(1500, 1)).toBe(975); // -35%
    expect(intelCenterCooldown(1500, 2)).toBe(750); // -50%
  });

  it("counts down and flips to ready at the cooldown, with clamped progress", () => {
    const mid = scavStatus(300, 1500);
    expect(mid.ready).toBe(false);
    expect(mid.remainingSec).toBe(1200);
    expect(mid.progress).toBeCloseTo(0.2, 5);

    const done = scavStatus(1500, 1500);
    expect(done.ready).toBe(true);
    expect(done.remainingSec).toBe(0);

    const over = scavStatus(9999, 1500);
    expect(over.ready).toBe(true);
    expect(over.progress).toBe(1);
  });

  it("guards non-positive cooldown by falling back to the default", () => {
    expect(scavStatus(0, 0).cooldownSec).toBe(1500);
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
