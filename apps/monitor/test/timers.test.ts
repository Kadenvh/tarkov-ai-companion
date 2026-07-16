import { describe, it, expect } from "vitest";
import {
  runthroughStatus,
  scavCooldownStatus,
  intelCenterCooldown,
  formatDuration,
  DEFAULT_RUNTHROUGH_SEC,
} from "../src/timers.js";

describe("runthroughStatus", () => {
  it("counts down and reports not-met before the threshold", () => {
    const s = runthroughStatus(100, DEFAULT_RUNTHROUGH_SEC);
    expect(s.met).toBe(false);
    expect(s.remainingSec).toBe(320);
    expect(s.thresholdSec).toBe(420);
  });

  it("is met exactly at the threshold and clamps remaining at 0", () => {
    const s = runthroughStatus(420, 420);
    expect(s.met).toBe(true);
    expect(s.remainingSec).toBe(0);
  });

  it("never reports negative remaining past the threshold", () => {
    expect(runthroughStatus(999, 420).remainingSec).toBe(0);
  });
});

describe("scavCooldownStatus", () => {
  it("counts down while on cooldown", () => {
    const s = scavCooldownStatus(300, 1500);
    expect(s.active).toBe(true);
    expect(s.ready).toBe(false);
    expect(s.remainingSec).toBe(1200);
  });

  it("is ready when elapsed reaches the cooldown", () => {
    expect(scavCooldownStatus(1500, 1500).ready).toBe(true);
  });
});

describe("intelCenterCooldown", () => {
  it("reduces the base by tier", () => {
    expect(intelCenterCooldown(1500, 0)).toBe(1500);
    expect(intelCenterCooldown(1500, 1)).toBe(975);
    expect(intelCenterCooldown(1500, 2)).toBe(750);
  });
});

describe("formatDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatDuration(42)).toBe("0:42");
    expect(formatDuration(420)).toBe("7:00");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(-5)).toBe("0:00");
  });
});
