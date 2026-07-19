import type { GameMode } from "@tac/shared";

/**
 * Monitor domain types (shared across engine, server, and the window page).
 * The monitor is a pure consumer of the service's CONTRACTS §3 event stream —
 * it holds no game state of its own beyond live timers and session tallies.
 * @tier T0
 */

/** Every alert the monitor can raise. Each maps to a voice line + a chime. */
export type AlertId =
  | "match-created" // queue entered
  | "match-found" // raid confirmed (map assigned)
  | "raid-start" // in-raid clock started
  | "runthrough-safe" // crossed the run-through time threshold
  | "raid-end" // returned to menu / raid over
  | "scav-ready" // scav cooldown elapsed
  | "flea-sale" // item sold on the flea market
  | "quest-done" // quest completed
  | "quest-failed"; // quest failed (often restartable — TarkovMonitor-style reminder)

/** Distinct chime shapes synthesized in the browser (Web Audio, no assets). */
export type ChimePattern = "up" | "down" | "double" | "success" | "warn";

/** One alert instance pushed to the window to speak + chime. */
export interface AlertCue {
  id: AlertId;
  title: string;
  /** spoken via SpeechSynthesis when voice is on */
  say: string;
  chime: ChimePattern;
  ts: string;
}

export type RaidPhase = "idle" | "queued" | "confirmed" | "in-raid";

export interface RunthroughState {
  thresholdSec: number;
  remainingSec: number;
  met: boolean;
}

export interface ScavState {
  active: boolean;
  cooldownSec: number;
  remainingSec: number;
  ready: boolean;
}

export interface RaidView {
  phase: RaidPhase;
  map: string | null; // raw location key, e.g. "bigmap"
  mapName: string | null; // display, e.g. "Customs"
  mode: GameMode | null;
  inRaidSec: number;
  queueSec: number | null;
  runthrough: RunthroughState;
}

export interface MonitorStats {
  raids: number;
  fleaSales: number;
  fleaRoubles: number;
  /** display-map-name -> raid count this session */
  byMap: Record<string, number>;
}

/** The slice of config the window is allowed to see + toggle. */
export interface PublicConfig {
  runthroughSec: number;
  scavCooldownSec: number;
  submitQueueTimes: boolean;
  submitGoons: boolean;
  hasAccountId: boolean;
  alerts: Record<AlertId, boolean>;
}

/** Full state snapshot streamed to the window on every tick / event. */
export interface MonitorState {
  connected: boolean; // upstream service WS connected
  profileKey: string | null;
  raid: RaidView;
  scav: ScavState;
  stats: MonitorStats;
  config: PublicConfig;
  ts: string;
}

/** A message on the monitor's own downstream stream (SSE) to the window. */
export type DownstreamMessage =
  | { kind: "state"; state: MonitorState }
  | { kind: "alert"; alert: AlertCue };
