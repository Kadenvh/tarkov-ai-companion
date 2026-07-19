/**
 * Pure presentational helpers for the Coach Config Audit + ADS 1:1 panel.
 * No React, no fetching — just ordering + copy generation, so they're unit-
 * testable without a DOM.
 */
import type { AuditFinding, AuditSeverity, SensitivityReadout } from "../api/types";

export const SEVERITY_RANK: Record<AuditSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Prioritized order: high → medium → low (stable within a tier). */
export function sortFindings(findings: AuditFinding[]): AuditFinding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** The community rounding of √2 that guides quote in-copy (≈1.42). */
export const ONE_TO_ONE_DISPLAY = 1.42;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface AdsMatchCopy {
  matched: boolean;
  text: string;
}

/**
 * The one-line readout, e.g. "Your ADS 0.27 ≈ hipfire 0.192 × 1.42 → 1:1 ✓".
 * Null when hipfire/ADS aren't both known (panel shows an empty state instead).
 */
export function adsMatchCopy(s: SensitivityReadout): AdsMatchCopy | null {
  if (s.hipfire === undefined || s.ads === undefined || s.oneToOneTarget === undefined) return null;
  if (s.matchesOneToOne) {
    return {
      matched: true,
      text: `Your ADS ${s.ads} ≈ hipfire ${s.hipfire} × ${ONE_TO_ONE_DISPLAY} → 1:1 ✓`,
    };
  }
  return {
    matched: false,
    text: `Your ADS ${s.ads} ≠ 1:1 target ${round2(s.oneToOneTarget)} (hipfire ${s.hipfire} × ${ONE_TO_ONE_DISPLAY})`,
  };
}
