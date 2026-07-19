/**
 * @tier T0 (pure data + diffing; nothing here touches disk).
 *
 * Coach **Config Audit** + **ADS 1:1 sensitivity helper** (M-coach).
 *
 * The audit surfaces where the player's live EFT config diverges from the
 * competitive-meta reference (`META_PROFILE` in profiles.ts). It BUILDS ON the
 * existing `diffSettings` engine — every finding is "current ≠ meta target" —
 * and layers a severity + the on-meta green-check confirmations on top.
 *
 * Reconciliation with the 1:1 helper: `META_PROFILE` encodes NO mouse key, so
 * the divergence list can NEVER flag ADS. ADS is owned entirely here by the
 * 1:1 helper — an ADS ≈ hipfire × √2 is the intentional "true aim" tune and is
 * surfaced as a green confirmation, not an outlier.
 */
import type { EftSettings, SettingValue } from "./eft-settings.js";
import { getSetting } from "./eft-settings.js";
import { META_PROFILE, diffSettings } from "./profiles.js";

export type AuditSeverity = "high" | "medium" | "low";

/** Severity per meta-divergence key — drives sort order + the UI badge tone. */
const SEVERITY: Record<string, AuditSeverity> = {
  "Graphics.SSR": "high",
  "PostFx.Clarity": "high",
  "Graphics.ChromaticAberrations": "medium",
  "PostFx.Brightness": "medium",
  "Sound.MusicVolume": "medium",
  "PostFx.Intensity": "low",
};

const SEVERITY_RANK: Record<AuditSeverity, number> = { high: 0, medium: 1, low: 2 };

export interface AuditFinding {
  key: string;
  current: SettingValue | undefined;
  recommended: SettingValue;
  why: string;
  severity: AuditSeverity;
}

export interface AuditConfirmation {
  key: string;
  label: string;
  current: SettingValue;
  why: string;
}

interface ConfirmationSpec {
  key: string;
  label: string;
  why: string;
  ok: (v: SettingValue) => boolean;
}

/**
 * On-meta confirmations — settings the player already has right, shown as green
 * checks. A spec only produces a check when its key is present AND passes; a
 * missing or off-meta value simply omits the check (degrades gracefully, never
 * a false "wrong").
 */
const CONFIRMATIONS: ConfirmationSpec[] = [
  {
    key: "Game.FieldOfView",
    label: "FOV in meta range",
    why: "60–75 is the competitive sweet spot — you're inside it.",
    ok: (v) => typeof v === "number" && v >= 60 && v <= 75,
  },
  {
    key: "Game.HeadBobbing",
    label: "Head-bob low",
    why: "Low head-bob keeps your sight picture steady while moving.",
    ok: (v) => typeof v === "number" && v <= 0.3,
  },
  {
    key: "PostFx.Saturation",
    label: "Saturation neutral",
    why: "Neutral saturation stops gear/skin blending into foliage.",
    ok: (v) => v === 0,
  },
  {
    key: "Graphics.ShadowsQuality",
    label: "Shadows low",
    why: "Low shadows still render player shadows without the ultra frame cost.",
    ok: (v) => typeof v === "number" && v <= 1,
  },
  {
    key: "Graphics.AntiAliasing",
    label: "TAA",
    why: "TAA resolves foliage shimmer that hides movement — the meta standard.",
    ok: (v) => typeof v === "string" && v.startsWith("TAA"),
  },
  {
    key: "Graphics.NVidiaReflex",
    label: "Reflex On",
    why: "Reflex trims render-queue latency at no visual cost.",
    ok: (v) => v === "On",
  },
  {
    key: "Graphics.VSync",
    label: "VSync Off",
    why: "VSync off removes a frame of input latency.",
    ok: (v) => v === false,
  },
  {
    key: "Graphics.DLSSMode",
    label: "DLSS Off",
    why: "Native res avoids DLSS ghosting on fast-moving targets.",
    ok: (v) => v === "Off",
  },
  {
    key: "Graphics.FSR2Mode",
    label: "FSR Off",
    why: "Native res avoids FSR upscaling artifacts on edges.",
    ok: (v) => v === "Off",
  },
];

// ---------------------------------------------------------------- ADS 1:1

/**
 * Community "1:1 / true aim" coefficient: ADS sensitivity = hipfire × √2, so a
 * 360° hipfire flick and a 360° ADS turn cover the same mouse distance.
 *
 * IMPORTANT: this is a widely-shared rule-of-thumb, NOT authoritatively sourced.
 * The real relationship is patch-dependent (BSG has changed ADS scaling across
 * wipes) and is best verified in-game with a 360° test on a fixed reference.
 * Treat the √2 target as a starting point, not gospel.
 */
export const ADS_ONE_TO_ONE_COEFFICIENT = Math.SQRT2;

/** Default relative tolerance for calling a measured ADS value "1:1". */
export const ADS_ONE_TO_ONE_TOLERANCE = 0.05;

/** Pure 1:1 target: hipfire × √2. */
export function adsOneToOne(hipfire: number): number {
  return hipfire * ADS_ONE_TO_ONE_COEFFICIENT;
}

/** Is `ads` within `tolerance` (relative) of the 1:1 target for `hipfire`? */
export function adsMatchesOneToOne(
  hipfire: number,
  ads: number,
  tolerance: number = ADS_ONE_TO_ONE_TOLERANCE,
): boolean {
  if (!(hipfire > 0) || !(ads > 0)) return false;
  const target = adsOneToOne(hipfire);
  return Math.abs(ads - target) / target <= tolerance;
}

export interface SensitivityReadout {
  /** Control.MouseSensitivity — hipfire. */
  hipfire?: number;
  /** Control.MouseAimingSensitivity — ADS coefficient. */
  ads?: number;
  /** Control.OpticSensitivity — scoped. */
  optic?: number;
  /** hipfire × √2 — the 1:1 target, when hipfire is known. */
  oneToOneTarget?: number;
  /** ads / hipfire, when both are known. */
  ratio?: number;
  /** true when ads ≈ hipfire × √2 within tolerance. */
  matchesOneToOne: boolean;
}

function numOf(v: SettingValue | undefined): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Read the mouse sensitivity block from Control.ini and compute the 1:1 view. */
export function readSensitivity(settings: EftSettings): SensitivityReadout {
  const hipfire = numOf(getSetting(settings, "Control.MouseSensitivity"));
  const ads = numOf(getSetting(settings, "Control.MouseAimingSensitivity"));
  const optic = numOf(getSetting(settings, "Control.OpticSensitivity"));
  const out: SensitivityReadout = { matchesOneToOne: false };
  if (hipfire !== undefined) {
    out.hipfire = hipfire;
    out.oneToOneTarget = adsOneToOne(hipfire);
  }
  if (ads !== undefined) out.ads = ads;
  if (optic !== undefined) out.optic = optic;
  if (hipfire !== undefined && ads !== undefined) {
    if (hipfire > 0) out.ratio = ads / hipfire;
    out.matchesOneToOne = adsMatchesOneToOne(hipfire, ads);
  }
  return out;
}

// ---------------------------------------------------------------- audit

export interface AuditResult {
  /** Meta divergences, prioritized high → low severity. */
  findings: AuditFinding[];
  /** On-meta green checks (including a 1:1-ADS confirmation when applicable). */
  confirmations: AuditConfirmation[];
  sensitivity: SensitivityReadout;
}

/**
 * Audit the live config against the competitive-meta reference. Everything
 * degrades gracefully: `diffSettings` skips keys whose file is missing, and
 * confirmations/sensitivity simply drop absent keys — a partial read yields a
 * partial (never crashing) audit.
 */
export function auditConfig(settings: EftSettings): AuditResult {
  const findings: AuditFinding[] = diffSettings(settings, META_PROFILE)
    .map((d) => ({
      key: d.key,
      current: d.current,
      recommended: d.recommended,
      why: d.why,
      severity: SEVERITY[d.key] ?? "low",
    }))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const confirmations: AuditConfirmation[] = [];
  for (const spec of CONFIRMATIONS) {
    const v = getSetting(settings, spec.key);
    if (v !== undefined && spec.ok(v)) {
      confirmations.push({ key: spec.key, label: spec.label, current: v, why: spec.why });
    }
  }

  // ADS reconciliation: a 1.42× ADS is intentional 1:1, so it is a green check,
  // never a finding (and META_PROFILE structurally omits the mouse key anyway).
  const sensitivity = readSensitivity(settings);
  if (sensitivity.matchesOneToOne && sensitivity.ads !== undefined && sensitivity.hipfire !== undefined) {
    confirmations.push({
      key: "Control.MouseAimingSensitivity",
      label: "ADS 1:1 (√2)",
      current: sensitivity.ads,
      why: `ADS ${sensitivity.ads} ≈ hipfire ${sensitivity.hipfire} × 1.42 — intentional 1:1 / true-aim, not an outlier.`,
    });
  }

  return { findings, confirmations, sensitivity };
}
