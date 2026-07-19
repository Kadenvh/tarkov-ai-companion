/**
 * Pure raid-clock math for the This Raid surface — the account-safe live signal
 * folded in from @tac/monitor ("monitor-in-shell"). Source of truth for the
 * timing rules is apps/monitor/src/timers.ts; this mirrors the run-through math
 * locally because the web app is deliberately decoupled (no @tac/* imports — it
 * talks to the service over HTTP/WS with locally-mirrored contract types).
 *
 * Run-through rule: EFT marks an exit "Run Through" (cut rewards + trader rep,
 * and it does NOT count as a survival) unless you earn >= ~200 in-raid EXP OR
 * stay in raid past a ~7-minute time threshold. We can't read EXP without
 * touching the game, so we track the TIME criterion only and label it as such.
 */

/** Default run-through time threshold in seconds (7 minutes). */
export const DEFAULT_RUNTHROUGH_SEC = 420;

export interface RunthroughStatus {
  thresholdSec: number;
  remainingSec: number;
  /** true once the time criterion is met (extract now counts as survived). */
  met: boolean;
  /** 0..1 progress toward the threshold, for a meter. */
  progress: number;
}

/** Deterministic: caller passes elapsed seconds, so no wall-clock read here. */
export function runthroughStatus(
  elapsedSec: number,
  thresholdSec: number = DEFAULT_RUNTHROUGH_SEC,
): RunthroughStatus {
  const elapsed = Math.max(0, elapsedSec);
  const threshold = thresholdSec > 0 ? thresholdSec : DEFAULT_RUNTHROUGH_SEC;
  const remaining = Math.max(0, threshold - elapsed);
  return {
    thresholdSec: threshold,
    remainingSec: Math.ceil(remaining),
    met: elapsed >= threshold,
    progress: Math.min(1, elapsed / threshold),
  };
}

// ---------------------------------------------------------------- scav cooldown

/**
 * Default scav cooldown estimate in seconds (base, pre-Intel-Center) — 25 min.
 * The exact remaining time lives in the profile, which this app never reads, so
 * the countdown is an opt-in estimate the player starts manually.
 */
export const DEFAULT_SCAV_COOLDOWN_SEC = 1500;

export type IntelLevel = 0 | 1 | 2;

/**
 * Intelligence Center reduces the scav cooldown. Community-documented factors
 * mirrored from apps/monitor/src/timers.ts (keep in lockstep): level 1 ≈ -35%,
 * level 2 ≈ -50%. Applied to the base only; labelled an estimate in the UI.
 */
export function intelCenterCooldown(baseSec: number, level: IntelLevel): number {
  const factor = level === 2 ? 0.5 : level === 1 ? 0.65 : 1;
  return Math.round(baseSec * factor);
}

export interface ScavStatus {
  cooldownSec: number;
  remainingSec: number;
  ready: boolean;
  progress: number;
}

/** Deterministic scav countdown — caller passes elapsed seconds. */
export function scavStatus(elapsedSec: number, cooldownSec: number): ScavStatus {
  const elapsed = Math.max(0, elapsedSec);
  const cooldown = cooldownSec > 0 ? cooldownSec : DEFAULT_SCAV_COOLDOWN_SEC;
  return {
    cooldownSec: cooldown,
    remainingSec: Math.ceil(Math.max(0, cooldown - elapsed)),
    ready: elapsed >= cooldown,
    progress: Math.min(1, elapsed / cooldown),
  };
}

/** Format seconds as m:ss (or h:mm:ss past an hour). */
export function fmtClock(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
