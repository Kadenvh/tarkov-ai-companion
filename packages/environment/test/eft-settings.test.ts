import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEftSettings, getSetting, parseSettingsJson } from "../src/eft-settings.js";
import { defaultSettingsDir } from "../src/paths.js";

const FIXTURE_DIR = resolve(fileURLToPath(import.meta.url), "../fixtures/settings");

describe("loadEftSettings (fixture copy of the real 1.0.6 files)", () => {
  it("parses Graphics/Game/PostFx and reports which files are present", () => {
    const settings = loadEftSettings(FIXTURE_DIR);
    expect(settings.dir).toBe(FIXTURE_DIR);
    expect(settings.present.sort()).toEqual(["Game", "Graphics", "PostFx"]);
    // Sound/Control absent in the fixture — tolerated, not fatal.
    expect(settings.raw.Sound).toBeUndefined();
    expect(settings.raw.Control).toBeUndefined();
  });

  it("types the perf-critical Graphics fields", () => {
    const { graphics } = loadEftSettings(FIXTURE_DIR);
    expect(graphics.VSync).toBe(false);
    expect(graphics.GameFramerate).toBe(120);
    expect(graphics.ShadowsQuality).toBe(1);
    expect(graphics.CloudsQuality).toBe("Medium");
    expect(graphics.OverallVisibility).toBe(3000);
    expect(graphics.SSR).toBe("Ultra");
    expect(graphics.NVidiaReflex).toBe("On");
    expect(graphics.GrassShadow).toBe(true);
    expect(graphics.DLSSMode).toBe("Off");
  });

  it("types Game and PostFx fields", () => {
    const settings = loadEftSettings(FIXTURE_DIR);
    expect(settings.game.FieldOfView).toBe(67);
    expect(settings.game.AutoEmptyWorkingSet).toBe(false);
    expect(settings.postfx.EnablePostFx).toBe(true);
    expect(settings.postfx.Clarity).toBe(-16);
    expect(settings.postfx.LumaSharpen).toBe(82);
  });

  it("getSetting reads flat File.Key paths and rejects non-scalars", () => {
    const settings = loadEftSettings(FIXTURE_DIR);
    expect(getSetting(settings, "Graphics.VSync")).toBe(false);
    expect(getSetting(settings, "Game.FieldOfView")).toBe(67);
    expect(getSetting(settings, "PostFx.Brightness")).toBe(87);
    expect(getSetting(settings, "Graphics.DisplaySettings")).toBeUndefined(); // nested object
    expect(getSetting(settings, "Graphics.NoSuchKey")).toBeUndefined();
    expect(getSetting(settings, "Sound.Volume")).toBeUndefined(); // file absent
    expect(getSetting(settings, "no-dot")).toBeUndefined();
  });

  it("tolerates a directory with no settings files at all", () => {
    const settings = loadEftSettings(join(FIXTURE_DIR, "..", "does-not-exist"));
    expect(settings.present).toEqual([]);
    expect(settings.graphics).toEqual({});
  });

  it("throws on malformed JSON rather than advising from a half-read config", () => {
    expect(() => parseSettingsJson("{ not json")).toThrow();
    expect(() => parseSettingsJson("[1,2,3]")).toThrow(/not a JSON object/);
  });
});

describe("real machine settings (skipped when EFT is not installed)", () => {
  const realDir = defaultSettingsDir();
  it.skipIf(!existsSync(realDir))("parses the live settings dir without throwing", () => {
    const settings = loadEftSettings(realDir);
    expect(settings.present.length).toBeGreaterThan(0);
    // Every typed field that exists must already be the right type (zod would throw otherwise).
    if (settings.graphics.GameFramerate !== undefined) {
      expect(settings.graphics.GameFramerate).toBeGreaterThan(0);
    }
  });
});
