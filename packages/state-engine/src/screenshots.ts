import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { ProfileStore } from "./store.js";

/**
 * @tier T1 — screenshot-position watcher (SPEC M2.4).
 *
 * EFT writes screenshots (player's own keybind) to
 * `%USERPROFILE%\Documents\Escape From Tarkov\Screenshots\` with the player's
 * world position + rotation quaternion encoded in the filename:
 *
 *   `2026-07-11[05-12]_-121.45, 2.61, -33.70_0.0, -0.4, 0.0, 0.9_12.5 (0).png`
 *    date     [HH-MM]  x, y, z              qx, qy, qz, qw   extra (counter)
 *
 * (research/03 §3, /06 §1 — the trailing `_extra` and ` (N)` parts vary; the
 * parser tolerates their absence.) The folder does NOT exist until the first
 * in-game screenshot — the watcher polls for its creation and re-arms.
 * Read-only: never touches the folder's contents.
 */

export interface ScreenshotPosition {
  x: number;
  y: number;
  z: number;
  quaternion: { x: number; y: number; z: number; w: number };
  /** heading derived from the quaternion, degrees [0, 360) */
  yawDeg: number;
  /** local capture time from the filename (`YYYY-MM-DDTHH:mm`), when present */
  takenAt: string | null;
  filename: string;
}

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
const SCREENSHOT_NAME = new RegExp(
  String.raw`^(?:(\d{4}-\d{2}-\d{2})\[(\d{2})-(\d{2})\])?_?${NUM}, ${NUM}, ${NUM}_${NUM}, ${NUM}, ${NUM}, ${NUM}(?:_[\d.]+)?(?: \(\d+\))?\.png$`,
  "i",
);

/** Unity Y-up yaw (heading) from a rotation quaternion, degrees [0, 360). */
export function quaternionToYawDeg(q: { x: number; y: number; z: number; w: number }): number {
  const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
  const deg = (yaw * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Parse an EFT screenshot filename; null when it doesn't carry a position. */
export function parseScreenshotFilename(name: string): ScreenshotPosition | null {
  const m = SCREENSHOT_NAME.exec(basename(name));
  if (!m) return null;
  const [, date, hh, mm, x, y, z, qx, qy, qz, qw] = m;
  const quaternion = { x: Number(qx), y: Number(qy), z: Number(qz), w: Number(qw) };
  return {
    x: Number(x),
    y: Number(y),
    z: Number(z),
    quaternion,
    yawDeg: quaternionToYawDeg(quaternion),
    takenAt: date && hh && mm ? `${date}T${hh}:${mm}` : null,
    filename: basename(name),
  };
}

/** Default screenshots folder (override for OneDrive-relocated Documents). */
export function defaultScreenshotsDir(): string {
  return (
    process.env["TAC_SCREENSHOTS_DIR"] ??
    join(homedir(), "Documents", "Escape From Tarkov", "Screenshots")
  );
}

export interface ScreenshotWatcherOptions {
  store: ProfileStore;
  dir?: string;
  /** supplies the current raid map (from the log watcher) to pair with positions */
  currentMap?: () => string | null;
  /** folder-creation re-arm poll (ms); default 2000, floor 100 for tests */
  armIntervalMs?: number;
}

export class ScreenshotWatcher {
  private readonly store: ProfileStore;
  private readonly dir: string;
  private readonly currentMap: () => string | null;
  private readonly armIntervalMs: number;
  private watcher: FSWatcher | null = null;
  private armTimer: NodeJS.Timeout | null = null;

  constructor(opts: ScreenshotWatcherOptions) {
    this.store = opts.store;
    this.dir = opts.dir ?? defaultScreenshotsDir();
    this.currentMap = opts.currentMap ?? (() => null);
    this.armIntervalMs = Math.max(100, opts.armIntervalMs ?? 2000);
  }

  start(): void {
    if (this.watcher || this.armTimer) return;
    if (existsSync(this.dir)) this.arm();
    else {
      // folder may not exist until the first in-game screenshot — poll, then arm
      this.armTimer = setInterval(() => {
        if (existsSync(this.dir)) {
          if (this.armTimer) clearInterval(this.armTimer);
          this.armTimer = null;
          this.arm();
        }
      }, this.armIntervalMs);
      this.armTimer.unref();
    }
  }

  stop(): Promise<void> {
    if (this.armTimer) clearInterval(this.armTimer);
    this.armTimer = null;
    const w = this.watcher;
    this.watcher = null;
    return w ? w.close() : Promise.resolve();
  }

  private arm(): void {
    this.watcher = chokidar.watch(this.dir, { ignoreInitial: true, depth: 0 });
    this.watcher.on("add", (path) => this.onScreenshot(path));
  }

  private onScreenshot(path: string): void {
    if (!path.toLowerCase().endsWith(".png")) return;
    const pos = parseScreenshotFilename(path);
    if (!pos) return;
    this.store.recordPosition({
      map: this.currentMap(),
      x: pos.x,
      y: pos.y,
      z: pos.z,
      filename: pos.filename,
      ts: new Date().toISOString(),
    });
  }
}
