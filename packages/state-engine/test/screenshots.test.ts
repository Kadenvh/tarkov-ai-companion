import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseScreenshotFilename, quaternionToYawDeg, ScreenshotWatcher } from "../src/screenshots.js";
import { openProfile } from "../src/store.js";
import type { EngineEventMap } from "../src/events.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("screenshot filename parsing (M2.4)", () => {
  it("parses the full 1.0-era format: date, position, quaternion, trailing fov + counter", () => {
    const pos = parseScreenshotFilename("2026-07-11[05-12]_-121.45, 2.61, -33.70_0.0, -0.4, 0.0, 0.9_12.5 (0).png");
    expect(pos).not.toBeNull();
    expect(pos).toMatchObject({ x: -121.45, y: 2.61, z: -33.7, takenAt: "2026-07-11T05:12" });
    expect(pos?.quaternion).toEqual({ x: 0, y: -0.4, z: 0, w: 0.9 });
    expect(pos?.yawDeg).toBeCloseTo(313.3, 0);
  });

  it("tolerates missing trailing segments and identity rotation", () => {
    const pos = parseScreenshotFilename("2026-05-25[21-05]_100, 2, 300_0, 0, 0, 1.png");
    expect(pos).toMatchObject({ x: 100, y: 2, z: 300, yawDeg: 0 });
  });

  it("rejects non-position filenames", () => {
    expect(parseScreenshotFilename("screenshot.png")).toBeNull();
    expect(parseScreenshotFilename("2026-07-11[05-12]_notes.png")).toBeNull();
  });

  it("derives yaw from a pure Y-rotation quaternion", () => {
    const q = (deg: number) => ({ x: 0, y: Math.sin((deg * Math.PI) / 360), z: 0, w: Math.cos((deg * Math.PI) / 360) });
    expect(quaternionToYawDeg(q(90))).toBeCloseTo(90, 5);
    expect(quaternionToYawDeg(q(180))).toBeCloseTo(180, 5);
    expect(quaternionToYawDeg(q(-90))).toBeCloseTo(270, 5);
  });
});

describe("screenshot watcher re-arm (folder may not exist yet)", () => {
  it("arms once the Screenshots folder is created and emits position events", async () => {
    const base = mkdtempSync(join(tmpdir(), "tac-shots-"));
    tmpDirs.push(base);
    const dir = join(base, "Escape From Tarkov", "Screenshots");

    const store = openProfile("shots-regular", { memory: true });
    const positions: EngineEventMap["position"][] = [];
    store.events.on("position", (e) => positions.push(e));

    const watcher = new ScreenshotWatcher({
      store,
      dir,
      currentMap: () => "factory4_day",
      armIntervalMs: 100,
    });
    watcher.start(); // folder absent → polling for creation

    mkdirSync(dir, { recursive: true });
    let attempt = 0;
    await vi.waitFor(() => {
      // watcher may still be arming — drop a fresh screenshot per attempt until one lands
      writeFileSync(join(dir, `2026-07-11[05-12]_-121.45, 2.61, -33.70_0.0, -0.4, 0.0, 0.9_12.5 (${attempt++}).png`), "png");
      expect(positions.length).toBeGreaterThan(0);
    }, { timeout: 8000, interval: 400 });

    expect(positions[0]).toMatchObject({ map: "factory4_day", x: -121.45, y: 2.61, z: -33.7 });
    const rows = store.db.prepare("SELECT map, x, filename FROM positions").all() as { map: string; x: number }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ map: "factory4_day", x: -121.45 });

    await watcher.stop();
  }, 15000);
});
