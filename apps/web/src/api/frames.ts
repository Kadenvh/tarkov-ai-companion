/**
 * WS frame parsing + routing (CONTRACTS §3 event vocabulary, §5.3 wire format).
 * Pure — the React hook in ws.ts delegates here so this is testable in node.
 */

import type {
  NoticePayload,
  PositionPayload,
  QuestChangedPayload,
  RaidEventPayload,
  WsFrame,
} from "./types";

/** Parse a raw WS message into a frame; null when malformed. */
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

export type RaidLifecycle = "created" | "confirmed" | "started" | "ended";

export interface FrameHandlers {
  onHello?(payload: { profileKey?: string }): void;
  onPlanUpdated?(frame: WsFrame): void;
  onRaid?(kind: RaidLifecycle, payload: RaidEventPayload): void;
  onQuestChanged?(payload: QuestChangedPayload): void;
  onFleaSale?(payload: { itemName?: string; amount?: number; ts?: string }): void;
  onPosition?(payload: PositionPayload): void;
  onProfileDetected?(payload: { profileId?: string; mode?: string }): void;
  onPatchDetected?(payload: { version?: string }): void;
  onStateChanged?(payload: { reason?: string; ts?: string }): void;
  onNotice?(payload: NoticePayload): void;
  /** §5.7 source.status — a remote source's status row changed. */
  onSourceStatus?(payload: Record<string, unknown>): void;
  onUnknown?(frame: WsFrame): void;
}

const RAID_EVENTS: Record<string, RaidLifecycle> = {
  "raid.created": "created",
  "raid.confirmed": "confirmed",
  "raid.started": "started",
  "raid.ended": "ended",
};

/** Route one frame to its handler. Returns true when a specific handler matched. */
export function routeFrame(frame: WsFrame, handlers: FrameHandlers): boolean {
  const payload = (frame.payload ?? {}) as Record<string, unknown>;
  const raidKind = RAID_EVENTS[frame.type];
  if (raidKind) {
    handlers.onRaid?.(raidKind, payload as RaidEventPayload);
    return true;
  }
  switch (frame.type) {
    case "hello":
      handlers.onHello?.(payload as { profileKey?: string });
      return true;
    case "plan.updated":
      handlers.onPlanUpdated?.(frame);
      return true;
    case "quest.changed":
      handlers.onQuestChanged?.(payload as unknown as QuestChangedPayload);
      return true;
    case "flea.sale":
      handlers.onFleaSale?.(payload as { itemName?: string; amount?: number; ts?: string });
      return true;
    case "position":
      handlers.onPosition?.(payload as unknown as PositionPayload);
      return true;
    case "profile.detected":
      handlers.onProfileDetected?.(payload as { profileId?: string; mode?: string });
      return true;
    case "patch.detected":
      handlers.onPatchDetected?.(payload as { version?: string });
      return true;
    case "state.changed":
      handlers.onStateChanged?.(payload as { reason?: string; ts?: string });
      return true;
    case "notice":
      handlers.onNotice?.(noticePayload(frame.payload));
      return true;
    case "source.status":
      handlers.onSourceStatus?.(payload);
      return true;
    default:
      handlers.onUnknown?.(frame);
      return false;
  }
}

/** Notices may arrive as a bare string or an object — normalize to a payload. */
export function noticePayload(raw: unknown): NoticePayload {
  if (typeof raw === "string") return { message: raw };
  if (raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    const message =
      typeof rec["message"] === "string"
        ? rec["message"]
        : typeof rec["text"] === "string"
          ? rec["text"]
          : undefined;
    const out: NoticePayload = {};
    if (message !== undefined) out.message = message;
    if (typeof rec["title"] === "string") out.title = rec["title"];
    if (rec["level"] === "info" || rec["level"] === "warning" || rec["level"] === "error") {
      out.level = rec["level"];
    }
    return out;
  }
  return {};
}
