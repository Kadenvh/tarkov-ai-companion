import type { RunthroughState, ScavState } from "./types.js";

/**
 * Pure timer math. No wall-clock reads here — callers pass elapsed seconds so
 * everything is deterministic and unit-testable.
 *
 * Run-through: EFT marks an exit "Run Through" (reduced rewards/rep) unless you
 * earn >= ~200 in-raid EXP OR stay in raid past a time threshold (~7 min). We
 * can't read EXP from logs, so the monitor tracks the time criterion only and
 * says so in the UI.
 *
 * Scav cooldown: the exact remaining time lives in the profile, which we never
 * read (T4). The monitor counts down from a calibratable base the player sets,
 * clearly labelled an estimate.
 * @tier T0
 */

/** Default run-through time threshold in seconds (7 minutes). */
export const DEFAULT_RUNTHROUGH_SEC = 420;

/** Default scav cooldown estimate in seconds (base, pre-Intel-Center). */
export const DEFAULT_SCAV_COOLDOWN_SEC = 1500;

export function runthroughStatus(elapsedSec: number, thresholdSec: number): RunthroughState {
  const remaining = Math.max(0, thresholdSec - Math.max(0, elapsedSec));
  return {
    thresholdSec,
    remainingSec: Math.ceil(remaining),
    met: elapsedSec >= thresholdSec,
  };
}

export function scavCooldownStatus(elapsedSec: number, cooldownSec: number): ScavState {
  const remaining = Math.max(0, cooldownSec - Math.max(0, elapsedSec));
  return {
    active: true,
    cooldownSec,
    remainingSec: Math.ceil(remaining),
    ready: elapsedSec >= cooldownSec,
  };
}

export const IDLE_SCAV: ScavState = {
  active: false,
  cooldownSec: DEFAULT_SCAV_COOLDOWN_SEC,
  remainingSec: 0,
  ready: false,
};

/**
 * Intelligence Center reduces the scav cooldown. Community-documented factors:
 * level 1 ≈ -35%, level 2 (with the Charisma-linked bonus) up to ≈ -50%.
 * Applied to the base only when the player opts in via config.
 */
export function intelCenterCooldown(baseSec: number, level: 0 | 1 | 2): number {
  const factor = level === 2 ? 0.5 : level === 1 ? 0.65 : 1;
  return Math.round(baseSec * factor);
}

/** Format seconds as m:ss or h:mm:ss. */
export function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
