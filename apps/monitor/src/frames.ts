/**
 * Service WS frame parsing + routing (CONTRACTS §3 vocabulary, §5.3 wire
 * format). Pure and self-contained so the engine stays testable without a
 * socket. Mirrors apps/web/src/api/frames.ts on the consuming side.
 * @tier T0
 */

export interface WsFrame {
  type: string;
  payload?: unknown;
  ts?: string;
}

export type RaidLifecycle = "created" | "confirmed" | "started" | "ended";

export interface RaidEventPayload {
  sid?: string | null;
  map?: string | null;
  mode?: string | null;
  ts?: string;
  durationSec?: number | null;
  outcome?: string;
}

export interface FrameHandlers {
  onHello?(payload: { profileKey?: string }): void;
  onRaid?(kind: RaidLifecycle, payload: RaidEventPayload): void;
  onQuestChanged?(payload: { taskId?: string; status?: string; ts?: string }): void;
  onFleaSale?(payload: { itemName?: string; amount?: number; ts?: string }): void;
  onProfileDetected?(payload: { profileId?: string; mode?: string }): void;
  onStateChanged?(payload: { reason?: string; ts?: string }): void;
}

export function parseFrame(data: unknown): WsFrame | null {
  let obj: unknown = data;
  if (typeof data === "string") {
    try {
      obj = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const record = obj as Record<string, unknown>;
  if (typeof record["type"] !== "string" || record["type"].length === 0) return null;
  const frame: WsFrame = { type: record["type"] };
  if ("payload" in record) frame.payload = record["payload"];
  if (typeof record["ts"] === "string") frame.ts = record["ts"];
  return frame;
}

const RAID_EVENTS: Record<string, RaidLifecycle> = {
  "raid.created": "created",
  "raid.confirmed": "confirmed",
  "raid.started": "started",
  "raid.ended": "ended",
};

export function routeFrame(frame: WsFrame, handlers: FrameHandlers): void {
  const payload = (frame.payload ?? {}) as Record<string, unknown>;
  const raidKind = RAID_EVENTS[frame.type];
  if (raidKind) {
    handlers.onRaid?.(raidKind, payload as RaidEventPayload);
    return;
  }
  switch (frame.type) {
    case "hello":
      handlers.onHello?.(payload as { profileKey?: string });
      return;
    case "quest.changed":
      handlers.onQuestChanged?.(payload as { taskId?: string; status?: string; ts?: string });
      return;
    case "flea.sale":
      handlers.onFleaSale?.(payload as { itemName?: string; amount?: number; ts?: string });
      return;
    case "profile.detected":
      handlers.onProfileDetected?.(payload as { profileId?: string; mode?: string });
      return;
    case "state.changed":
      handlers.onStateChanged?.(payload as { reason?: string; ts?: string });
      return;
    default:
      return;
  }
}
