import { describe, expect, it } from "vitest";
import { selectPort, selectPorts, type PortProbe } from "../src/lib/ports.js";

/** Build a probe where the listed ports are occupied (not free). */
function occupied(...taken: number[]): PortProbe {
  const set = new Set(taken);
  return async (port) => !set.has(port);
}

describe("selectPort", () => {
  it("returns the preferred port when it is free", async () => {
    expect(await selectPort(3141, occupied())).toBe(3141);
  });

  it("walks upward to the next free port when the preferred one is taken", async () => {
    expect(await selectPort(3141, occupied(3141))).toBe(3142);
  });

  it("skips a contiguous run of occupied ports", async () => {
    expect(await selectPort(3141, occupied(3141, 3142, 3143))).toBe(3144);
  });

  it("respects maxProbes and throws when no free port is found in budget", async () => {
    const allTaken: PortProbe = async () => false;
    await expect(selectPort(3141, allTaken, { maxProbes: 4 })).rejects.toThrow(/no free port/);
  });

  it("rejects an out-of-range preferred port", async () => {
    await expect(selectPort(0, occupied())).rejects.toThrow(RangeError);
    await expect(selectPort(70000, occupied())).rejects.toThrow(RangeError);
  });
});

describe("selectPorts", () => {
  it("never hands back a duplicate even when two requests share a preferred value", async () => {
    const [a, b] = await selectPorts([3141, 3141], occupied());
    expect(a).toBe(3141);
    expect(b).toBe(3142);
  });

  it("picks the defaults when both are free", async () => {
    expect(await selectPorts([3141, 3142], occupied())).toEqual([3141, 3142]);
  });

  it("routes both around an occupied default pair", async () => {
    expect(await selectPorts([3141, 3142], occupied(3141, 3142))).toEqual([3143, 3144]);
  });
});
