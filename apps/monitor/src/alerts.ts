import type { AlertId, ChimePattern } from "./types.js";

/**
 * Alert catalog. Each alert has a default enabled state, a chime shape, and a
 * label. Voice lines are built at emit time (they interpolate map/item names),
 * so they live in the engine — this file owns only the static spec.
 * @tier T0
 */

export interface AlertSpec {
  label: string;
  defaultOn: boolean;
  chime: ChimePattern;
}

export const ALERT_SPECS: Record<AlertId, AlertSpec> = {
  "match-created": { label: "Queue entered", defaultOn: false, chime: "up" },
  "match-found": { label: "Match found", defaultOn: true, chime: "double" },
  "raid-start": { label: "Raid started", defaultOn: true, chime: "up" },
  "runthrough-safe": { label: "Run-through cleared", defaultOn: true, chime: "success" },
  "raid-end": { label: "Raid ended", defaultOn: true, chime: "down" },
  "scav-ready": { label: "Scav available", defaultOn: true, chime: "success" },
  "flea-sale": { label: "Flea sale", defaultOn: false, chime: "double" },
  "quest-done": { label: "Quest completed", defaultOn: true, chime: "success" },
  "quest-failed": { label: "Task failed", defaultOn: true, chime: "warn" },
};

export const ALERT_IDS = Object.keys(ALERT_SPECS) as AlertId[];

/** Default per-alert enabled map, derived from the catalog. */
export function defaultAlertToggles(): Record<AlertId, boolean> {
  const out = {} as Record<AlertId, boolean>;
  for (const id of ALERT_IDS) out[id] = ALERT_SPECS[id].defaultOn;
  return out;
}
