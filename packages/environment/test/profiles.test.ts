import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEftSettings } from "../src/eft-settings.js";
import { PROFILES, getProfile, diffSettings, diffAllProfiles } from "../src/profiles.js";

const FIXTURE_DIR = resolve(fileURLToPath(import.meta.url), "../fixtures/settings");

describe("recommendation profiles", () => {
  it("ships the three curated profiles, every setting with a rationale", () => {
    expect(PROFILES.map((p) => p.key)).toEqual(["max-fps", "balanced", "max-visibility"]);
    for (const profile of PROFILES) {
      expect(profile.settings.length).toBeGreaterThan(8);
      for (const s of profile.settings) {
        expect(s.key).toMatch(/^(Graphics|Game|PostFx|Sound|Control)\.\w+$/);
        expect(s.why.length).toBeGreaterThan(10);
      }
    }
  });

  it("getProfile resolves by key and throws on unknown", () => {
    expect(getProfile("balanced").name).toBe("Balanced");
    expect(() => getProfile("turbo" as never)).toThrow(/Unknown settings profile/);
  });
});

describe("diff engine", () => {
  const current = loadEftSettings(FIXTURE_DIR);

  it("reports only differing keys, each with current/recommended/why", () => {
    const diffs = diffSettings(current, getProfile("max-fps"));
    const byKey = new Map(diffs.map((d) => [d.key, d]));
    // Fixture has GrassShadow=true, ChromaticAberrations=true, SSR="Ultra" — all differ from max-fps.
    expect(byKey.get("Graphics.GrassShadow")).toMatchObject({ current: true, recommended: false });
    expect(byKey.get("Graphics.SSR")).toMatchObject({ current: "Ultra", recommended: "Off" });
    expect(byKey.get("Graphics.ChromaticAberrations")).toMatchObject({ current: true, recommended: false });
    for (const d of diffs) {
      expect(d.current).not.toEqual(d.recommended);
      expect(d.why.length).toBeGreaterThan(0);
    }
  });

  it("omits keys that already match (fixture VSync=false, Reflex=On)", () => {
    const diffs = diffSettings(current, getProfile("max-fps"));
    const keys = diffs.map((d) => d.key);
    expect(keys).not.toContain("Graphics.VSync");
    expect(keys).not.toContain("Graphics.NVidiaReflex");
  });

  it("max-visibility matches the fixture's OverallVisibility=3000 (no diff for it)", () => {
    const diffs = diffSettings(current, getProfile("max-visibility"));
    expect(diffs.map((d) => d.key)).not.toContain("Graphics.OverallVisibility");
  });

  it("skips keys whose file is missing entirely (never invents a file)", () => {
    const noGame = { ...current, raw: { Graphics: current.raw.Graphics ?? {} } };
    const diffs = diffSettings(noGame, getProfile("balanced"));
    expect(diffs.every((d) => d.key.startsWith("Graphics."))).toBe(true);
  });

  it("diffAllProfiles returns one diff list per profile (the API payload shape)", () => {
    const all = diffAllProfiles(current);
    expect(Object.keys(all).sort()).toEqual(["balanced", "max-fps", "max-visibility"]);
    expect(all["max-fps"]!.length).toBeGreaterThan(0);
  });
});
