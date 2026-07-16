import type { GameMode } from "@tac/shared";
import type { AlertCue, AlertId, MonitorState, RaidPhase, RaidView, ScavState } from "./types.js";
import { ALERT_SPECS } from "./alerts.js";
import { runthroughStatus, scavCooldownStatus, IDLE_SCAV } from "./timers.js";
import { mapDisplayName, tarkovDevMapId } from "./maps.js";
import { parseFrame, routeFrame, type RaidEventPayload } from "./frames.js";
import type { MonitorConfig } from "./config.js";
import { toPublicConfig } from "./config.js";

/**
 * MonitorEngine — the heart of @tac/monitor. It consumes the service's WS event
 * stream (CONTRACTS §3), maintains live raid/scav timers and session tallies,
 * and raises voice/chime alerts. It owns no persistent game state and never
 * reads the game — every fact originates from the service.
 *
 * Deterministic by construction: all time comes through the injected `now()`,
 * so the whole thing is unit-testable without sockets or wall-clock.
 * @tier T0
 */

/** Fire-and-forget crowdsourced submissions (opt-in; see submit.ts). */
export interface Submitter {
  queueTime(input: { mapDevId: string; queueSec: number; type: string; gameMode: GameMode }): void;
  goons(input: { mapDevId: string; accountId: string | null; gameMode: GameMode }): void;
}

export interface EngineDeps {
  config: MonitorConfig;
  submitter?: Submitter;
  now?: () => number;
  log?: (msg: string) => void;
}

export class MonitorEngine {
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private config: MonitorConfig;
  private readonly submitter: Submitter | null;

  private connected = false;
  private profileKey: string | null = null;

  private phase: RaidPhase = "idle";
  private rawMap: string | null = null;
  private mode: GameMode | null = null;
  private queuedAtMs: number | null = null;
  private startedAtMs: number | null = null;
  private queueSec: number | null = null;
  private runthroughFired = false;

  private scavStartedMs: number | null = null;
  private scavReadyFired = false;

  private stats = { raids: 0, fleaSales: 0, fleaRoubles: 0, byMap: {} as Record<string, number> };

  /** Listeners — the server wires these to the SSE downstream. */
  onAlert: ((cue: AlertCue) => void) | null = null;
  onState: ((state: MonitorState) => void) | null = null;

  constructor(deps: EngineDeps) {
    this.config = deps.config;
    this.submitter = deps.submitter ?? null;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? (() => {});
  }

  // ---- upstream connection state ------------------------------------------

  setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.pushState();
  }

  /** Feed one raw WS message from the service. */
  handleMessage(raw: string): void {
    const frame = parseFrame(raw);
    if (!frame) return;
    routeFrame(frame, {
      onHello: (p) => {
        this.profileKey = p.profileKey ?? this.profileKey;
        this.pushState();
      },
      onRaid: (kind, p) => this.onRaid(kind, p),
      onFleaSale: (p) => {
        this.stats.fleaSales += 1;
        this.stats.fleaRoubles += typeof p.amount === "number" ? p.amount : 0;
        this.emit("flea-sale", saleLine(p.itemName, p.amount));
        this.pushState();
      },
      onQuestChanged: (p) => {
        if (p.status === "completed") this.emit("quest-done", "Quest completed.");
        else if (p.status === "failed") this.emit("quest-failed", "Task failed — it may be restartable.");
      },
      onProfileDetected: () => {},
      onStateChanged: () => {},
    });
  }

  private onRaid(kind: string, p: RaidEventPayload): void {
    const rawMap = typeof p.map === "string" ? p.map : null;
    const mapName = rawMap ? mapDisplayName(rawMap) : null;
    const mode = normalizeMode(p.mode);

    switch (kind) {
      case "created":
        this.phase = "queued";
        this.queuedAtMs = tsToMs(p.ts, this.now);
        this.startedAtMs = null;
        this.queueSec = null;
        this.runthroughFired = false;
        this.emit("match-created", "Queue entered.");
        break;

      case "confirmed":
        this.phase = "confirmed";
        this.rawMap = rawMap ?? this.rawMap;
        if (mode) this.mode = mode;
        this.emit("match-found", `Match found${mapName ? ` on ${mapName}` : ""}.`);
        break;

      case "started": {
        this.phase = "in-raid";
        this.rawMap = rawMap ?? this.rawMap;
        if (mode) this.mode = mode;
        this.startedAtMs = tsToMs(p.ts, this.now);
        this.queueSec = this.queuedAtMs !== null ? Math.max(0, Math.round((this.startedAtMs - this.queuedAtMs) / 1000)) : null;
        this.runthroughFired = false;
        this.emit("raid-start", `Raid started${this.rawMap ? ` on ${mapDisplayName(this.rawMap)}` : ""}.`);
        this.maybeSubmitQueueTime();
        break;
      }

      case "ended": {
        const endName = mapName ?? (this.rawMap ? mapDisplayName(this.rawMap) : null);
        this.stats.raids += 1;
        if (endName) this.stats.byMap[endName] = (this.stats.byMap[endName] ?? 0) + 1;
        this.emit("raid-end", `Raid${endName ? ` on ${endName}` : ""} over.`);
        this.phase = "idle";
        this.startedAtMs = null;
        this.queuedAtMs = null;
        break;
      }
    }
    this.pushState();
  }

  private maybeSubmitQueueTime(): void {
    if (!this.config.submitQueueTimes || !this.submitter) return;
    const devId = tarkovDevMapId(this.rawMap);
    if (!devId || this.queueSec === null || this.mode === null) return;
    this.submitter.queueTime({ mapDevId: devId, queueSec: this.queueSec, type: "pmc", gameMode: this.mode });
    this.log(`submitted queue time: ${devId} ${this.queueSec}s`);
  }

  // ---- scav cooldown (manual — logs don't expose PMC vs Scav) --------------

  /** Start the scav cooldown countdown (player clicked "Scav out"). */
  startScav(): void {
    this.scavStartedMs = this.now();
    this.scavReadyFired = false;
    this.log(`scav cooldown started (${this.config.scavCooldownSec}s)`);
    this.pushState();
  }

  clearScav(): void {
    this.scavStartedMs = null;
    this.scavReadyFired = false;
    this.pushState();
  }

  /** Manual goons sighting report (opt-in). Uses the current or given map. */
  reportGoons(rawMap?: string): { ok: boolean; reason?: string } {
    if (!this.config.submitGoons || !this.submitter) return { ok: false, reason: "goons submission is off" };
    const devId = tarkovDevMapId(rawMap ?? this.rawMap);
    if (!devId) return { ok: false, reason: "unknown map" };
    this.submitter.goons({ mapDevId: devId, accountId: this.config.accountId, gameMode: this.mode ?? "regular" });
    this.log(`submitted goons sighting: ${devId}`);
    return { ok: true };
  }

  // ---- periodic tick: countdowns + threshold-crossing alerts ---------------

  tick(): void {
    let changed = false;
    if (this.phase === "in-raid" && this.startedAtMs !== null && !this.runthroughFired) {
      const elapsed = (this.now() - this.startedAtMs) / 1000;
      if (elapsed >= this.config.runthroughSec) {
        this.runthroughFired = true;
        this.emit("runthrough-safe", "Run-through cleared. Your exit will count as survived.");
      }
      changed = true;
    }
    if (this.scavStartedMs !== null && !this.scavReadyFired) {
      const elapsed = (this.now() - this.scavStartedMs) / 1000;
      if (elapsed >= this.config.scavCooldownSec) {
        this.scavReadyFired = true;
        this.emit("scav-ready", "Your scav is off cooldown.");
      }
      changed = true;
    }
    if (changed) this.pushState();
  }

  // ---- config --------------------------------------------------------------

  getConfig(): MonitorConfig {
    return this.config;
  }

  setConfig(config: MonitorConfig): void {
    this.config = config;
    this.pushState();
  }

  // ---- snapshot ------------------------------------------------------------

  private raidView(): RaidView {
    const inRaidSec =
      this.phase === "in-raid" && this.startedAtMs !== null ? Math.max(0, (this.now() - this.startedAtMs) / 1000) : 0;
    return {
      phase: this.phase,
      map: this.phase === "idle" ? null : this.rawMap,
      mapName: this.phase === "idle" ? null : this.rawMap ? mapDisplayName(this.rawMap) : null,
      mode: this.phase === "idle" ? null : this.mode,
      inRaidSec: Math.floor(inRaidSec),
      queueSec: this.queueSec,
      runthrough: runthroughStatus(inRaidSec, this.config.runthroughSec),
    };
  }

  private scavView(): ScavState {
    if (this.scavStartedMs === null) return { ...IDLE_SCAV, cooldownSec: this.config.scavCooldownSec };
    const elapsed = (this.now() - this.scavStartedMs) / 1000;
    return scavCooldownStatus(elapsed, this.config.scavCooldownSec);
  }

  snapshot(): MonitorState {
    return {
      connected: this.connected,
      profileKey: this.profileKey,
      raid: this.raidView(),
      scav: this.scavView(),
      stats: { raids: this.stats.raids, fleaSales: this.stats.fleaSales, fleaRoubles: this.stats.fleaRoubles, byMap: { ...this.stats.byMap } },
      config: toPublicConfig(this.config),
      ts: new Date(this.now()).toISOString(),
    };
  }

  private pushState(): void {
    this.onState?.(this.snapshot());
  }

  private emit(id: AlertId, say: string): void {
    if (!this.config.alerts[id]) return;
    const spec = ALERT_SPECS[id];
    this.onAlert?.({ id, title: spec.label, say, chime: spec.chime, ts: new Date(this.now()).toISOString() });
  }
}

function tsToMs(ts: string | undefined, now: () => number): number {
  if (ts) {
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return ms;
  }
  return now();
}

function normalizeMode(mode: string | null | undefined): GameMode | null {
  return mode === "regular" || mode === "pve" ? mode : null;
}

function saleLine(itemName: string | undefined, amount: number | undefined): string {
  const name = itemName ?? "an item";
  return amount ? `Sold ${name} for ${amount.toLocaleString("en-US")} roubles.` : `Sold ${name}.`;
}
