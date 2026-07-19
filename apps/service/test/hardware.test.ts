import { describe, expect, it } from "vitest";
import { detectHardware, detectPhysicalCores, type ExecFileFn } from "../src/hardware.js";

/** Fake execFile that returns a fixed stdout (or an error) synchronously. */
function fakeExec(stdout: string, error: Error | null = null): ExecFileFn {
  return (_cmd, _args, _opts, cb) => cb(error, stdout);
}

describe("detectPhysicalCores (injected probe)", () => {
  it("parses the summed NumberOfCores from the probe output", async () => {
    expect(await detectPhysicalCores(fakeExec("8\r\n"))).toBe(8);
    expect(await detectPhysicalCores(fakeExec("  6 "))).toBe(6);
  });

  it("returns null on a probe error, empty, or non-numeric output", async () => {
    expect(await detectPhysicalCores(fakeExec("", new Error("boom")))).toBeNull();
    expect(await detectPhysicalCores(fakeExec(""))).toBeNull();
    expect(await detectPhysicalCores(fakeExec("garbage"))).toBeNull();
    expect(await detectPhysicalCores(fakeExec("0"))).toBeNull();
  });
});

describe("detectHardware", () => {
  it("always reports logical cores + RAM, plus the injected physical count", async () => {
    const hw = await detectHardware(fakeExec("12"));
    expect(hw.logicalCores).toBeGreaterThanOrEqual(1);
    expect(hw.totalRamGB).toBeGreaterThan(0);
    expect(hw.physicalCores).toBe(12);
  });
});
