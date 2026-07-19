import { describe, expect, it } from "vitest";
import { sortFindings, adsMatchCopy } from "./audit";
import { readAudit } from "./normalize";
import type { AuditFinding, SensitivityReadout } from "../api/types";

const finding = (key: string, severity: AuditFinding["severity"]): AuditFinding => ({
  key,
  current: 1,
  recommended: 0,
  why: "because",
  severity,
});

describe("sortFindings", () => {
  it("orders high → medium → low", () => {
    const sorted = sortFindings([
      finding("a", "low"),
      finding("b", "high"),
      finding("c", "medium"),
      finding("d", "high"),
    ]);
    expect(sorted.map((f) => f.severity)).toEqual(["high", "high", "medium", "low"]);
  });

  it("does not mutate the input", () => {
    const input = [finding("a", "low"), finding("b", "high")];
    sortFindings(input);
    expect(input.map((f) => f.severity)).toEqual(["low", "high"]);
  });
});

describe("adsMatchCopy", () => {
  it("produces the 1:1 ✓ readout when matched", () => {
    const s: SensitivityReadout = {
      hipfire: 0.192,
      ads: 0.27,
      oneToOneTarget: 0.2715,
      matchesOneToOne: true,
    };
    const copy = adsMatchCopy(s);
    expect(copy).not.toBeNull();
    expect(copy!.matched).toBe(true);
    expect(copy!.text).toBe("Your ADS 0.27 ≈ hipfire 0.192 × 1.42 → 1:1 ✓");
  });

  it("flags a mismatch against the rounded target", () => {
    const s: SensitivityReadout = {
      hipfire: 0.5,
      ads: 0.5,
      oneToOneTarget: 0.7071,
      matchesOneToOne: false,
    };
    const copy = adsMatchCopy(s);
    expect(copy!.matched).toBe(false);
    expect(copy!.text).toContain("≠ 1:1 target 0.71");
  });

  it("returns null when sensitivity is unavailable", () => {
    expect(adsMatchCopy({ matchesOneToOne: false })).toBeNull();
  });
});

describe("readAudit normalizer", () => {
  it("reads findings/confirmations/sensitivity from the full settings response", () => {
    const res = readAudit({
      dir: "x",
      audit: {
        findings: [
          { key: "Graphics.SSR", current: "Ultra", recommended: "Off", why: "cost", severity: "high" },
          { key: "PostFx.Brightness", current: 82, recommended: 0, why: "washes out", severity: "bogus" },
        ],
        confirmations: [{ key: "Graphics.VSync", label: "VSync Off", current: false, why: "latency" }],
        sensitivity: { hipfire: 0.192, ads: 0.27, oneToOneTarget: 0.2715, matchesOneToOne: true },
      },
    });
    expect(res.findings).toHaveLength(2);
    expect(res.findings[0]).toMatchObject({ key: "Graphics.SSR", severity: "high" });
    expect(res.findings[1]!.severity).toBe("low"); // unknown severity coerced
    expect(res.confirmations[0]).toMatchObject({ key: "Graphics.VSync", current: false });
    expect(res.sensitivity.matchesOneToOne).toBe(true);
    expect(res.sensitivity.hipfire).toBe(0.192);
  });

  it("degrades to empty for garbage / missing payloads", () => {
    const empty = readAudit(null);
    expect(empty.findings).toEqual([]);
    expect(empty.confirmations).toEqual([]);
    expect(empty.sensitivity.matchesOneToOne).toBe(false);
  });
});
