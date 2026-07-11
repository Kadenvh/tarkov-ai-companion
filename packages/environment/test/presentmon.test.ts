import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePresentMonCsv,
  percentile,
  summarizeRun,
  toPerfSampleRow,
  detectRegression,
} from "../src/presentmon.js";

const FIXTURE = resolve(fileURLToPath(import.meta.url), "../fixtures/presentmon-v1.csv");
const csv = readFileSync(FIXTURE, "utf8");

describe("parsePresentMonCsv (v1 MsBetweenPresents layout)", () => {
  it("keeps only EFT rows, drops Dropped=1 / other processes / malformed rows", () => {
    const ft = parsePresentMonCsv(csv);
    // Fixture: 20 valid EFT frames; 2 dwm.exe rows, 1 dropped row, 1 NaN row excluded.
    expect(ft).toHaveLength(20);
    expect(ft.filter((v) => v === 8)).toHaveLength(10);
    expect(Math.max(...ft)).toBe(20);
  });

  it("process=null keeps all processes", () => {
    const ft = parsePresentMonCsv(csv, { process: null });
    expect(ft).toHaveLength(22); // + the two dwm.exe 16.667 rows
  });

  it("supports the v2 FrameTime column layout", () => {
    const v2 = "Application,ProcessID,FrameTime\nEscapeFromTarkov.exe,1,4.2\nEscapeFromTarkov.exe,1,5.0\n";
    expect(parsePresentMonCsv(v2)).toEqual([4.2, 5]);
  });

  it("throws on a CSV that is not PresentMon output", () => {
    expect(() => parsePresentMonCsv("a,b,c\n1,2,3\n")).toThrow(/Not a PresentMon CSV/);
    expect(parsePresentMonCsv("")).toEqual([]);
  });
});

describe("summary stats", () => {
  it("nearest-rank percentiles", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });

  it("summarizes the fixture run to hand-computed values", () => {
    const summary = summarizeRun(parsePresentMonCsv(csv));
    // 20 frames: ten 8s, five 10s, two 12s, 14, 16, 20 -> mean 10.2 ms.
    expect(summary.frameCount).toBe(20);
    expect(summary.fps_avg).toBeCloseTo(1000 / 10.2, 3);
    expect(summary.frametime_p50).toBe(8);
    expect(summary.frametime_p95).toBe(16);
    expect(summary.frametime_p99).toBe(20);
    expect(summary.fps_p1).toBeCloseTo(50, 5); // 1000 / p99
  });

  it("empty run summarizes to zeros", () => {
    expect(summarizeRun([]).fps_avg).toBe(0);
  });

  it("toPerfSampleRow matches the perf_samples DDL columns (CONTRACTS §4)", () => {
    const row = toPerfSampleRow(summarizeRun(parsePresentMonCsv(csv)), {
      ts: "2026-07-11T20:00:00.000Z",
      map: "factory4_day",
      raidId: 7,
    });
    expect(row).toEqual({
      raid_id: 7,
      map: "factory4_day",
      ts: "2026-07-11T20:00:00.000Z",
      fps_avg: 98.04,
      fps_p1: 50,
      frametime_p50: 8,
      frametime_p95: 16,
      frametime_p99: 20,
      source: "presentmon",
    });
    const bare = toPerfSampleRow(summarizeRun([10]), { ts: "2026-07-11T20:00:00.000Z" });
    expect(bare.raid_id).toBeNull();
    expect(bare.map).toBeNull();
  });
});

describe("regression detector (10% AND 5 FPS documented threshold)", () => {
  const baseline = { fps_avg: 120, fps_p1: 80 };

  it("flags a run past both thresholds", () => {
    const result = detectRegression({ fps_avg: 100, fps_p1: 78 }, baseline);
    expect(result.regressed).toBe(true);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/fps_avg dropped 20\.0 FPS \(17%\)/);
  });

  it("catches the 'same average, new stutter' signature via fps_p1", () => {
    const result = detectRegression({ fps_avg: 119, fps_p1: 60 }, baseline);
    expect(result.regressed).toBe(true);
    expect(result.reasons[0]).toMatch(/fps_p1/);
  });

  it("ignores drops under 10% relative or under 5 FPS absolute (raid variance)", () => {
    expect(detectRegression({ fps_avg: 112, fps_p1: 76 }, baseline).regressed).toBe(false); // <10%
    expect(detectRegression({ fps_avg: 116, fps_p1: 77 }, baseline).regressed).toBe(false); // <5 fps
    expect(detectRegression({ fps_avg: 130, fps_p1: 90 }, baseline).regressed).toBe(false); // improvement
  });

  it("skips metrics with no baseline", () => {
    expect(detectRegression({ fps_avg: 50, fps_p1: 30 }, { fps_avg: 0, fps_p1: 0 }).regressed).toBe(false);
  });
});
