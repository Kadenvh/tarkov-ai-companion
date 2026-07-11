import { z } from "zod";
import type { GameMode } from "@tac/shared";

/**
 * Pure parsers over EFT log streams. Zero I/O — every function takes strings
 * and returns typed events, so the same code serves the live watcher, the
 * historical backfill, and the tests.
 *
 * Grounded in first-hand inspection of real 1.0.1 → 1.0.6 logs on this machine
 * (docs/research/03-log-reading-auto-detection.md). Line format:
 *
 *   `2026-05-25 12:34:32.149|1.0.5.0.45272|Info|push-notifications|<message>`
 *   ...optionally followed by a multi-line JSON payload (push notifications).
 */

// ---------------------------------------------------------------------------
// Log entry framing

export interface LogEntry {
  /** ISO-ish local timestamp `YYYY-MM-DDTHH:mm:ss.SSS` (1.0 logs carry no tz offset) */
  ts: string;
  version: string;
  level: string;
  channel: string;
  message: string;
  /** parsed multi-line JSON payload following the header line, when present */
  json?: unknown;
}

const HEADER =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})(?: [+-]\d{2}:\d{2})?\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/;

interface PendingEntry {
  entry: LogEntry;
  extra: string[];
}

/**
 * Incremental, chunk-tolerant log-entry framer: feed arbitrary text chunks
 * (as delivered by the polling tail), receive completed entries. A trailing
 * partial line is buffered until the next chunk; a trailing JSON payload is
 * attached to its header entry on `flush()` or when the next header arrives.
 */
export class LogEntryParser {
  private lineBuffer = "";
  private pending: PendingEntry | null = null;

  push(chunk: string): LogEntry[] {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = lines.pop() ?? "";
    const out: LogEntry[] = [];
    for (const line of lines) this.pushLine(line, out);
    return out;
  }

  /** Finalize any buffered entry (end of file / end of session). */
  flush(): LogEntry[] {
    const out: LogEntry[] = [];
    if (this.lineBuffer.length > 0) {
      this.pushLine(this.lineBuffer, out);
      this.lineBuffer = "";
    }
    const last = this.finalize();
    if (last) out.push(last);
    return out;
  }

  private pushLine(line: string, out: LogEntry[]): void {
    const m = HEADER.exec(line);
    if (m) {
      const done = this.finalize();
      if (done) out.push(done);
      this.pending = {
        entry: {
          ts: `${m[1]}T${m[2]}`,
          version: m[3] ?? "",
          level: m[4] ?? "",
          channel: m[5] ?? "",
          message: m[6] ?? "",
        },
        extra: [],
      };
    } else if (this.pending && line.trim().length > 0) {
      this.pending.extra.push(line);
    }
  }

  private finalize(): LogEntry | null {
    if (!this.pending) return null;
    const { entry, extra } = this.pending;
    this.pending = null;
    if (extra.length > 0) {
      try {
        entry.json = JSON.parse(extra.join("\n"));
      } catch {
        // non-JSON continuation (settings dumps, stack traces) — ignored
      }
    }
    return entry;
  }
}

/** One-shot convenience for whole files (backfill, tests). */
export function parseLogText(text: string): LogEntry[] {
  const parser = new LogEntryParser();
  return [...parser.push(text), ...parser.flush()];
}

// ---------------------------------------------------------------------------
// Semantic events

export type QuestStatus = "started" | "completed" | "failed";

export type ParsedEvent =
  | { kind: "sessionMode"; mode: GameMode; ts: string }
  | { kind: "profile"; profileId: string; accountId: string | null; ts: string }
  /** `Init: pstrGameVersion` — fires in menus (session start AND post-raid return) */
  | { kind: "menu"; version: string | null; ts: string }
  | { kind: "mapLoading"; rawLocation: string; ts: string }
  | { kind: "matchingCancelled"; ts: string }
  | { kind: "gameStarting"; ts: string }
  | { kind: "gameStarted"; ts: string }
  /** application `TRACE-NetworkGameCreate profileStatus` — server lock */
  | { kind: "matchFound"; location: string; sid: string; shortId: string | null; profileId: string | null; ts: string }
  /** push `userMatchCreated` — queue entered (no sid yet) */
  | { kind: "matchCreated"; ts: string }
  /** push `userConfirmed` — server + map assigned */
  | { kind: "matchConfirmed"; sid: string; location: string; shortId: string | null; ts: string }
  /** push `userMatchOver` — raid over */
  | { kind: "matchOver"; sid: string; location: string; shortId: string | null; ts: string }
  | { kind: "quest"; taskId: string; status: QuestStatus; ts: string }
  | { kind: "fleaSale"; itemId: string; count: number; amount: number; ts: string };

const HEX24 = /^[0-9a-f]{24}$/;

/** ChatMessageReceived `message.type` values we consume (TarkovMonitor MessageType enum). */
const MSG_TASK_STARTED = 10;
const MSG_TASK_FAILED = 11;
const MSG_TASK_FINISHED = 12;
const MSG_FLEA_MARKET = 4;
/** templateId prefix of a flea "item sold" system message (verified in real logs) */
const FLEA_SOLD_TEMPLATE = "5bdabfb886f7743e152e867e";

const MatchPayload = z
  .object({
    type: z.string(),
    sid: z.string().optional(),
    location: z.string().optional(),
    shortId: z.string().optional(),
    profileid: z.string().optional(),
  })
  .passthrough();

const ChatPayload = z
  .object({
    type: z.string(),
    message: z
      .object({
        type: z.number(),
        dt: z.number().optional(),
        templateId: z.string().optional(),
        systemData: z
          .object({ soldItem: z.string().optional(), itemCount: z.number().optional() })
          .passthrough()
          .optional(),
        items: z
          .object({
            data: z
              .array(z.object({ upd: z.object({ StackObjectsCount: z.number().optional() }).passthrough().optional() }).passthrough())
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** application `TRACE-NetworkGameCreate profileStatus: '...'` inner fields */
const PROFILE_STATUS =
  /Profileid: (?<profileId>\w+), Status: \w+,.*?Location: (?<location>[\w-]+), Sid: (?<sid>[^,']+)(?:,.*?shortId: (?<shortId>\w+))?/;

/** Classify one framed log entry into a semantic event (or null for noise). */
export function parseEntry(entry: LogEntry): ParsedEvent | null {
  const { message, ts, channel } = entry;

  if (channel === "application") {
    const mode = /^Session mode: (\w+)/.exec(message);
    if (mode) return { kind: "sessionMode", mode: normalizeMode(mode[1] ?? ""), ts };

    const profile = /(?:Complete|)Select(?:ed)?Profile ProfileId:(\w+) AccountId:(\d+)/.exec(message);
    if (profile) return { kind: "profile", profileId: profile[1] ?? "", accountId: profile[2] ?? null, ts };

    const menu = /^Init: pstrGameVersion: Escape from Tarkov ([\w.]+)/.exec(message);
    if (menu) return { kind: "menu", version: menu[1] ?? null, ts };

    const scene = /scene preset path:maps\/(\w+)_preset\.bundle/.exec(message);
    if (scene) return { kind: "mapLoading", rawLocation: (scene[1] ?? "").toLowerCase(), ts };

    if (/Network game matching (?:aborted|cancelled)/.test(message)) return { kind: "matchingCancelled", ts };
    if (/^GameStarting:/.test(message)) return { kind: "gameStarting", ts };
    if (/^GameStarted:/.test(message)) return { kind: "gameStarted", ts };

    if (message.startsWith("TRACE-NetworkGameCreate profileStatus")) {
      const m = PROFILE_STATUS.exec(message);
      if (m?.groups) {
        return {
          kind: "matchFound",
          location: m.groups["location"] ?? "",
          sid: m.groups["sid"] ?? "",
          shortId: m.groups["shortId"] ?? null,
          profileId: m.groups["profileId"] ?? null,
          ts,
        };
      }
    }
    return null;
  }

  if (channel === "push-notifications" && message.startsWith("Got notification |") && entry.json !== undefined) {
    return parseNotification(entry.json, ts);
  }
  return null;
}

function parseNotification(json: unknown, ts: string): ParsedEvent | null {
  const base = MatchPayload.safeParse(json);
  if (!base.success) return null;
  const payload = base.data;

  switch (payload.type) {
    case "userMatchCreated":
      return { kind: "matchCreated", ts };
    case "userConfirmed":
      return {
        kind: "matchConfirmed",
        sid: payload.sid ?? "",
        location: payload.location ?? "",
        shortId: payload.shortId ?? null,
        ts,
      };
    case "userMatchOver":
      return {
        kind: "matchOver",
        sid: payload.sid ?? "",
        location: payload.location ?? "",
        shortId: payload.shortId ?? null,
        ts,
      };
    case "new_message":
      return parseChatMessage(json, ts);
    default:
      return null;
  }
}

function parseChatMessage(json: unknown, ts: string): ParsedEvent | null {
  const parsed = ChatPayload.safeParse(json);
  if (!parsed.success) return null;
  const msg = parsed.data.message;
  const templateId = msg.templateId ?? "";

  if (msg.type === MSG_TASK_STARTED || msg.type === MSG_TASK_FAILED || msg.type === MSG_TASK_FINISHED) {
    const taskId = templateId.split(" ")[0] ?? "";
    if (!HEX24.test(taskId)) return null;
    const status: QuestStatus =
      msg.type === MSG_TASK_STARTED ? "started" : msg.type === MSG_TASK_FAILED ? "failed" : "completed";
    return { kind: "quest", taskId, status, ts };
  }

  if (msg.type === MSG_FLEA_MARKET && templateId.startsWith(FLEA_SOLD_TEMPLATE)) {
    const itemId = msg.systemData?.soldItem ?? "";
    if (!itemId) return null;
    const amount = (msg.items?.data ?? []).reduce(
      (sum, stack) => sum + (stack.upd?.StackObjectsCount ?? 0),
      0,
    );
    return { kind: "fleaSale", itemId, count: msg.systemData?.itemCount ?? 1, amount, ts };
  }
  return null;
}

/** `Session mode: Regular|Pve` → GameMode */
export function normalizeMode(raw: string): GameMode {
  return raw.trim().toLowerCase() === "pve" ? "pve" : "regular";
}

/**
 * Raw log location ids → display names (best-effort; unknown ids pass through
 * lowercased). Raid rows store the raw lowercase id — this map is for UIs.
 */
export const LOCATION_NAMES: Record<string, string> = {
  factory4_day: "Factory (Day)",
  factory4_night: "Factory (Night)",
  bigmap: "Customs",
  woods: "Woods",
  shoreline: "Shoreline",
  interchange: "Interchange",
  rezervbase: "Reserve",
  laboratory: "The Lab",
  lighthouse: "Lighthouse",
  tarkovstreets: "Streets of Tarkov",
  city: "Streets of Tarkov",
  sandbox: "Ground Zero",
  sandbox_high: "Ground Zero (21+)",
  labyrinth: "Labyrinth",
  terminal: "Terminal",
};

export function normalizeLocation(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Convenience: file text → semantic events (framing + classification). */
export function parseLogFileText(text: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  for (const entry of parseLogText(text)) {
    const ev = parseEntry(entry);
    if (ev) events.push(ev);
  }
  return events;
}
