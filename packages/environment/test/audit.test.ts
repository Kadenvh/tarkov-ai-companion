import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEftSettings } from "../src/eft-settings.js";
import {
  auditConfig,
  adsOneToOne,
  adsMatchesOneToOne,
  readSensitivity,
  ADS_ONE_TO_ONE_COEFFICIENT,
} from "../src/audit.js";
import type { AuditFinding } from "../src/audit.js";

const FIXTURE_DIR = resolve(fileURLToPath(import.meta.url), "../fixtures/audit-config");
const byKey = (findings: AuditFinding[]) => new Map(findings.map((f) => [f.key, f]));

describe("Config Audit — meta divergence", () => {
  const current = loadEftSettings(FIXTURE_DIR);
  const { findings } = auditConfig(current);
  const map = byKey(findings);

  it("surfaces every confirmed outlier with current→meta and a severity", () => {
    expect(map.get("Graphics.SSR")).toMatchObject({ current: "Ultra", recommended: "Off", severity: "high" });
    expect(map.get("Graphics.ChromaticAberrations")).toMatchObject({
      current: true,
      recommended: false,
      severity: "medium",
    });
    expect(map.get("Sound.MusicVolume")).toMatchObject({ current: 4, recommended: 0, severity: "medium" });

    // Clarity: negative → positive (~+50)
    const clarity = map.get("PostFx.Clarity");
    expect(clarity).toMatchObject({ current: -34, recommended: 50, severity: "high" });
    expect(clarity!.current as number).toBeLessThan(0);

    // High-side Brightness + colour Intensity
    expect(map.get("PostFx.Brightness")).toMatchObject({ current: 82, recommended: 0, severity: "medium" });
    expect(map.get("PostFx.Intensity")).toMatchObject({ current: 100, recommended: 0, severity: "low" });
  });

  it("gives every finding a non-empty rationale and prioritizes high severity first", () => {
    for (const f of findings) expect(f.why.length).toBeGreaterThan(10);
    expect(findings[0]!.severity).toBe("high");
    // Sorted non-decreasing by severity rank (high, medium, low).
    const rank = { high: 0, medium: 1, low: 2 } as const;
    for (let i = 1; i < findings.length; i++) {
      expect(rank[findings[i]!.severity]).toBeGreaterThanOrEqual(rank[findings[i - 1]!.severity]);
    }
  });

  it("confirms the on-meta settings as green checks", () => {
    const { confirmations } = auditConfig(current);
    const keys = confirmations.map((c) => c.key);
    for (const k of [
      "Game.FieldOfView",
      "Game.HeadBobbing",
      "PostFx.Saturation",
      "Graphics.ShadowsQuality",
      "Graphics.AntiAliasing",
      "Graphics.NVidiaReflex",
      "Graphics.VSync",
      "Graphics.DLSSMode",
      "Graphics.FSR2Mode",
    ]) {
      expect(keys).toContain(k);
    }
  });
});

describe("ADS 1:1 helper", () => {
  it("adsOneToOne = hipfire × √2 and the constant is √2", () => {
    expect(ADS_ONE_TO_ONE_COEFFICIENT).toBe(Math.SQRT2);
    expect(adsOneToOne(0.192)).toBeCloseTo(0.2715, 4);
    expect(adsOneToOne(1)).toBeCloseTo(1.41421356, 6);
  });

  it("matches a real 1:1 ADS within tolerance, rejects equal-to-hipfire and way-off", () => {
    expect(adsMatchesOneToOne(0.192, 0.27)).toBe(true); // 0.192×1.414 ≈ 0.2715
    expect(adsMatchesOneToOne(0.192, 0.192)).toBe(false); // equal-to-hipfire is NOT 1:1
    expect(adsMatchesOneToOne(0.192, 0.5)).toBe(false); // way over
    expect(adsMatchesOneToOne(0, 0.27)).toBe(false); // guards non-positive
  });

  it("readSensitivity pulls hipfire/ads/optic and computes the 1:1 view", () => {
    const s = readSensitivity(loadEftSettings(FIXTURE_DIR));
    expect(s.hipfire).toBe(0.192);
    expect(s.ads).toBe(0.27);
    expect(s.optic).toBe(1.0);
    expect(s.oneToOneTarget).toBeCloseTo(0.2715, 4);
    expect(s.ratio).toBeCloseTo(0.27 / 0.192, 4);
    expect(s.matchesOneToOne).toBe(true);
  });
});

describe("audit ↔ 1:1 reconciliation", () => {
  it("does NOT flag a 1.42-correct ADS as an outlier — it's a green confirmation instead", () => {
    const { findings, confirmations } = auditConfig(loadEftSettings(FIXTURE_DIR));
    // No divergence finding ever references a mouse/Control key.
    expect(findings.every((f) => !f.key.startsWith("Control."))).toBe(true);
    // The 1:1 ADS shows up as an on-meta confirmation, not an outlier.
    expect(confirmations.some((c) => c.key === "Control.MouseAimingSensitivity")).toBe(true);
  });
});

describe("graceful degradation", () => {
  it("returns an empty, non-crashing audit when no settings files exist", () => {
    const empty = loadEftSettings(resolve(FIXTURE_DIR, "..", "does-not-exist-audit"));
    const res = auditConfig(empty);
    expect(res.findings).toEqual([]);
    expect(res.confirmations).toEqual([]);
    expect(res.sensitivity.matchesOneToOne).toBe(false);
    expect(res.sensitivity.hipfire).toBeUndefined();
  });
});
