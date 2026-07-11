import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyProfile, restoreBackup, listBackups, GameRunningError } from "../src/apply.js";
import { getProfile } from "../src/profiles.js";
import { loadEftSettings, getSetting } from "../src/eft-settings.js";

const FIXTURE_DIR = resolve(fileURLToPath(import.meta.url), "../fixtures/settings");

// All apply/restore tests run against a throwaway temp copy — NEVER the real install.
let root: string;
let settingsDir: string;
let backupDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tac-env-apply-"));
  settingsDir = join(root, "Settings");
  backupDir = join(root, "backups");
  cpSync(FIXTURE_DIR, settingsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const gameClosed = () => false;
const gameRunning = () => true;

describe("applyProfile safety gate", () => {
  it("refuses with GameRunningError when the process check says the game is up", async () => {
    await expect(
      applyProfile(getProfile("max-fps"), { settingsDir, backupDir, isGameRunning: gameRunning }),
    ).rejects.toBeInstanceOf(GameRunningError);
    // And nothing was written or backed up.
    expect(listBackups(backupDir)).toEqual([]);
    expect(getSetting(loadEftSettings(settingsDir), "Graphics.GrassShadow")).toBe(true);
  });

  it("GameRunningError carries the typed code the service maps to HTTP 409", async () => {
    const err = await applyProfile(getProfile("max-fps"), {
      settingsDir,
      backupDir,
      isGameRunning: gameRunning,
    }).catch((e: unknown) => e);
    expect((err as GameRunningError).code).toBe("GAME_RUNNING");
  });
});

describe("applyProfile writes", () => {
  it("applies only differing keys, backs up first, preserves everything else verbatim", async () => {
    const before = loadEftSettings(settingsDir);
    const result = await applyProfile(getProfile("max-fps"), {
      settingsDir,
      backupDir,
      isGameRunning: gameClosed,
    });
    expect(result.backupId).toBeTruthy();
    expect(result.applied.length).toBeGreaterThan(0);

    const after = loadEftSettings(settingsDir);
    // Recommended values landed.
    expect(getSetting(after, "Graphics.GrassShadow")).toBe(false);
    expect(getSetting(after, "Graphics.SSR")).toBe("Off");
    expect(getSetting(after, "PostFx.EnablePostFx")).toBe(false);
    // Untouched keys survive read-modify-write, including nested non-scalar blocks.
    expect(after.raw.Graphics?.["DisplaySettings"]).toEqual(before.raw.Graphics?.["DisplaySettings"]);
    expect(after.raw.Graphics?.["GameFramerate"]).toBe(120);
    expect(after.raw.Game?.["Language"]).toBe("en");

    // Backup contains byte-identical copies of each touched file.
    const backups = listBackups(backupDir);
    expect(backups).toHaveLength(1);
    expect(backups[0]!.id).toBe(result.backupId);
    for (const file of backups[0]!.files) {
      expect(readFileSync(join(backupDir, result.backupId!, file), "utf8")).toBe(
        readFileSync(join(FIXTURE_DIR, file), "utf8"),
      );
    }
  });

  it("is a no-op (no backup) when the profile already matches", async () => {
    await applyProfile(getProfile("max-fps"), { settingsDir, backupDir, isGameRunning: gameClosed });
    const second = await applyProfile(getProfile("max-fps"), {
      settingsDir,
      backupDir,
      isGameRunning: gameClosed,
    });
    expect(second.backupId).toBeNull();
    expect(second.applied).toEqual([]);
    expect(listBackups(backupDir)).toHaveLength(1); // still just the first one
  });
});

describe("restoreBackup", () => {
  it("round-trips: apply -> restore leaves the settings byte-identical to the originals", async () => {
    const originals = new Map(
      ["Graphics.ini", "Game.ini", "PostFx.ini"].map((f) => [f, readFileSync(join(settingsDir, f), "utf8")]),
    );
    const { backupId } = await applyProfile(getProfile("balanced"), {
      settingsDir,
      backupDir,
      isGameRunning: gameClosed,
    });
    const manifest = await restoreBackup(backupId!, { settingsDir, backupDir, isGameRunning: gameClosed });
    expect(manifest.profileKey).toBe("balanced");
    for (const file of manifest.files) {
      expect(readFileSync(join(settingsDir, file), "utf8")).toBe(originals.get(file));
    }
  });

  it("refuses to restore while the game is running", async () => {
    const { backupId } = await applyProfile(getProfile("balanced"), {
      settingsDir,
      backupDir,
      isGameRunning: gameClosed,
    });
    await expect(
      restoreBackup(backupId!, { settingsDir, backupDir, isGameRunning: gameRunning }),
    ).rejects.toBeInstanceOf(GameRunningError);
  });

  it("rejects unknown and path-traversal backup ids", async () => {
    await expect(restoreBackup("nope-123", { settingsDir, backupDir, isGameRunning: gameClosed })).rejects.toThrow(
      /Backup not found/,
    );
    await expect(
      restoreBackup("../escape", { settingsDir, backupDir, isGameRunning: gameClosed }),
    ).rejects.toThrow(/Invalid backup id/);
  });
});
