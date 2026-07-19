/**
 * @tier T0 — pure, hardware-aware performance-setting advice.
 *
 * Answers the two hardware-dependent EFT settings that don't fit the fixed
 * meta-divergence audit because the "right" value depends on the machine:
 * **Only use physical cores** and **Automatic RAM cleaner**. Given detected
 * specs it returns a concrete on/off + rationale instead of "it depends".
 *
 * Detection lives in the service (`os` + a guarded core probe); this module is
 * only the decision, so it stays pure and exhaustively testable.
 */

export interface HardwareFacts {
  logicalCores: number;
  /** null when the physical-core probe was unavailable — advice falls back to a logical-thread estimate. */
  physicalCores: number | null;
  totalRamGB: number;
}

export interface PerfSettingAdvice {
  key: "OnlyUsePhysicalCores" | "AutomaticRamCleaner";
  label: string;
  recommend: "on" | "off";
  confidence: "high" | "medium";
  why: string;
}

/** ≥ this many physical cores → pinning to physical cores tends to help 1% lows. */
export const PHYSICAL_CORE_ON_THRESHOLD = 6;
/** ≥ this many GB → RAM cleaner off (headroom; avoid the purge hitch). ~32 GB rigs report ~31. */
export const RAM_CLEANER_OFF_GB = 30;
/** ≤ this many GB → RAM cleaner on (avoid OOM). 16 GB rigs. */
export const RAM_CLEANER_ON_GB = 18;

export function perfAdvice(hw: HardwareFacts): PerfSettingAdvice[] {
  const out: PerfSettingAdvice[] = [];

  // --- Only use physical cores -------------------------------------------
  const knownPhysical = hw.physicalCores != null && hw.physicalCores > 0;
  // With no probe, estimate physical ≈ logical / 2 (SMT/Hyper-Threading on).
  const physical = knownPhysical ? hw.physicalCores! : Math.max(1, Math.round(hw.logicalCores / 2));
  const coresConfidence: PerfSettingAdvice["confidence"] = knownPhysical ? "high" : "medium";
  const coresBasis = knownPhysical
    ? `${physical} physical cores`
    : `~${physical} physical cores estimated from ${hw.logicalCores} logical threads`;

  if (physical >= PHYSICAL_CORE_ON_THRESHOLD) {
    out.push({
      key: "OnlyUsePhysicalCores",
      label: "Only use physical cores",
      recommend: "on",
      confidence: coresConfidence,
      why: `${coresBasis} — pinning EFT to physical cores tends to steady frametimes and 1% lows by avoiding SMT-sibling contention. Worth an A/B: play one raid each way and compare 1% lows on the Performance tab.`,
    });
  } else {
    out.push({
      key: "OnlyUsePhysicalCores",
      label: "Only use physical cores",
      recommend: "off",
      confidence: coresConfidence,
      why: `${coresBasis} — with this few cores you want every logical thread available, so leave it off.`,
    });
  }

  // --- Automatic RAM cleaner ---------------------------------------------
  if (hw.totalRamGB >= RAM_CLEANER_OFF_GB) {
    out.push({
      key: "AutomaticRamCleaner",
      label: "Automatic RAM cleaner",
      recommend: "off",
      confidence: "high",
      why: `${hw.totalRamGB} GB RAM — plenty of headroom, so skip the cleaner: its mid-raid purge pass is a common source of stutter/hitches.`,
    });
  } else if (hw.totalRamGB <= RAM_CLEANER_ON_GB) {
    out.push({
      key: "AutomaticRamCleaner",
      label: "Automatic RAM cleaner",
      recommend: "on",
      confidence: "high",
      why: `${hw.totalRamGB} GB RAM — turn it on to avoid out-of-memory crashes on Streets/Lighthouse; accept the periodic micro-hitch as the lesser evil.`,
    });
  } else {
    out.push({
      key: "AutomaticRamCleaner",
      label: "Automatic RAM cleaner",
      recommend: "off",
      confidence: "medium",
      why: `${hw.totalRamGB} GB RAM — borderline; lean off to avoid the purge hitch, but switch it on if you hit memory-related crashes on the big maps.`,
    });
  }

  return out;
}
