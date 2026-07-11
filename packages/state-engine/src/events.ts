import { EventEmitter } from "node:events";
import type { GameMode } from "@tac/shared";

/**
 * Shared event vocabulary — CONTRACTS §3. These payloads are also the WS wire
 * format (`apps/service` §5.3), so shapes here are binding.
 */

export type RaidOutcome = "survived" | "died" | "unknown";

export interface EngineEventMap {
  /** queue entered (push `userMatchCreated` carries no sid yet — null until confirm) */
  "raid.created": { sid: string | null; ts: string };
  "raid.confirmed": { sid: string; map: string; mode: GameMode; ts: string };
  "raid.started": { sid: string | null; map: string | null; mode: GameMode; ts: string };
  "raid.ended": {
    sid: string | null;
    map: string | null;
    mode: GameMode;
    ts: string;
    durationSec: number | null;
    outcome: RaidOutcome;
  };
  /** log message types 10/11/12 */
  "quest.changed": { taskId: string; status: "started" | "completed" | "failed"; ts: string };
  /** itemName is the sold item's 24-hex item id (logs carry ids, not names) */
  "flea.sale": { itemName: string; amount: number; ts: string };
  "position": { map: string | null; x: number; y: number; z: number; filename: string; ts: string };
  "profile.detected": { profileId: string; mode: GameMode; ts: string };
  /** log-folder version differs from the active data snapshot */
  "patch.detected": { version: string; ts: string };
  /** any store mutation — UI refresh signal */
  "state.changed": { reason: string; ts: string };
}

export type EngineEventName = keyof EngineEventMap;

/** Minimal typed wrapper over node's EventEmitter for the CONTRACTS §3 vocabulary. */
export class EngineEmitter {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  on<K extends EngineEventName>(event: K, listener: (payload: EngineEventMap[K]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  once<K extends EngineEventName>(event: K, listener: (payload: EngineEventMap[K]) => void): this {
    this.emitter.once(event, listener);
    return this;
  }

  off<K extends EngineEventName>(event: K, listener: (payload: EngineEventMap[K]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  emit<K extends EngineEventName>(event: K, payload: EngineEventMap[K]): boolean {
    return this.emitter.emit(event, payload);
  }
}
