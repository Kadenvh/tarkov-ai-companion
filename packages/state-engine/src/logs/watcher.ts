import type { ProfileStore } from "../store.js";
import { findLogsDir, detectInstallDir, listSessionFolders, sessionStreams, type SessionFolder } from "./discover.js";
import { LogEntryParser, parseEntry, type ParsedEvent } from "./parse.js";
import { RaidAssembler, type RaidSignal } from "./raids.js";
import { PollingTail } from "./tail.js";

/**
 * @tier T1 — live log watcher (SPEC M2.2 + M8.1 patch detection).
 *
 * Discovers the newest session folder under `<install>\Logs`, tails the
 * `application` and `push-notifications` streams (>= 1 s polling, byte-offset
 * resume via the store's `lastLogCursor` meta), parses events, and feeds the
 * ProfileStore + its CONTRACTS §3 emitter. Detects a NEW session folder
 * appearing mid-run (game restart) and emits `patch.detected` when the
 * folder's version suffix differs from the active data snapshot.
 */

export interface LogWatcherOptions {
  store: ProfileStore;
  /** Logs root; default = registry/known-path install detection */
  logsDir?: string;
  /** version of the active data snapshot (compare vs log-folder version); null disables patch detection */
  snapshotVersion?: string | null;
  intervalMs?: number;
  /** restore byte offsets from the store's persisted cursor (default true) */
  resume?: boolean;
}

interface StreamState {
  tail: PollingTail;
  parser: LogEntryParser;
}

interface LogCursor {
  session: string;
  offsets: Record<string, number>;
}

export class LogWatcher {
  private readonly store: ProfileStore;
  private readonly logsDir: string | null;
  private readonly snapshotVersion: string | null;
  private readonly intervalMs: number;
  private readonly resume: boolean;

  private session: SessionFolder | null = null;
  private streams = new Map<string, StreamState>();
  private assembler: RaidAssembler | null = null;
  private timer: NodeJS.Timeout | null = null;
  private patchEmittedFor: string | null = null;

  /** last map seen loading (`scene preset path`) — pairs screenshots with a map */
  currentMap: string | null = null;

  constructor(opts: LogWatcherOptions) {
    this.store = opts.store;
    this.logsDir = opts.logsDir ?? (() => {
      const install = detectInstallDir();
      return install ? findLogsDir(install) : null;
    })();
    this.snapshotVersion = opts.snapshotVersion ?? null;
    this.intervalMs = Math.max(1000, opts.intervalMs ?? 1000);
    this.resume = opts.resume ?? true;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.pumpOnce(), this.intervalMs);
    this.timer.unref();
    this.pumpOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One discovery + tail-poll cycle. Public so tests replay without timers. */
  pumpOnce(): void {
    if (!this.logsDir) return;
    const folders = listSessionFolders(this.logsDir);
    const newest = folders.at(-1);
    if (!newest) return;

    if (this.session?.name !== newest.name) this.attachSession(newest);
    this.checkPatch(newest);
    this.refreshRotation();

    const events: ParsedEvent[] = [];
    for (const { tail, parser } of this.streams.values()) {
      const chunk = tail.poll();
      if (chunk === null || chunk.length === 0) continue;
      for (const entry of parser.push(chunk)) {
        const ev = parseEntry(entry);
        if (ev) events.push(ev);
      }
    }
    events.sort((a, b) => a.ts.localeCompare(b.ts));
    for (const ev of events) this.handle(ev);
    this.persistCursor();
  }

  private attachSession(next: SessionFolder): void {
    // close out a raid left open by the previous session (game restart mid-raid)
    if (this.assembler) {
      for (const signal of this.assembler.flush()) this.applyRaidSignal(signal);
    }
    this.session = next;
    this.streams = new Map();
    this.assembler = new RaidAssembler(this.store.gameMode);
    this.currentMap = null;

    const cursor = this.resume ? this.store.getLogCursor<LogCursor>() : null;
    const resumeOffsets = cursor?.session === next.name ? cursor.offsets : {};
    const found = sessionStreams(next.dir);
    for (const file of [...found.application.slice(-1), ...found.pushNotifications.slice(-1)]) {
      this.streams.set(file, {
        tail: new PollingTail(file, { fromOffset: resumeOffsets[file] ?? 0 }),
        parser: new LogEntryParser(),
      });
    }
  }

  /** A new rotation counter (`_001`) supersedes the tailed file mid-session. */
  private refreshRotation(): void {
    if (!this.session) return;
    const found = sessionStreams(this.session.dir);
    for (const latest of [...found.application.slice(-1), ...found.pushNotifications.slice(-1)]) {
      if (!this.streams.has(latest)) {
        this.streams.set(latest, { tail: new PollingTail(latest), parser: new LogEntryParser() });
      }
    }
  }

  private checkPatch(newest: SessionFolder): void {
    if (!this.snapshotVersion || !newest.version) return;
    if (newest.version === this.snapshotVersion) return;
    if (this.patchEmittedFor === newest.version) return;
    this.patchEmittedFor = newest.version;
    this.store.events.emit("patch.detected", { version: newest.version, ts: new Date().toISOString() });
  }

  private handle(ev: ParsedEvent): void {
    const assembler = this.assembler;
    switch (ev.kind) {
      case "sessionMode":
        if (assembler) assembler.mode = ev.mode;
        return;
      case "profile":
        if (!this.store.profileId) this.store.setMeta("profileId", ev.profileId, "profile");
        this.store.events.emit("profile.detected", {
          profileId: ev.profileId,
          mode: assembler?.mode ?? this.store.gameMode,
          ts: ev.ts,
        });
        this.forwardToAssembler(ev);
        return;
      case "mapLoading":
        this.currentMap = ev.rawLocation;
        return;
      case "quest":
        this.store.applyQuestEvent({ taskId: ev.taskId, status: ev.status, ts: ev.ts }, "live");
        return;
      case "fleaSale":
        this.store.recordFleaSale({ itemId: ev.itemId, amount: ev.amount, ts: ev.ts });
        return;
      default:
        this.forwardToAssembler(ev);
    }
  }

  private forwardToAssembler(ev: ParsedEvent): void {
    if (!this.assembler) return;
    for (const signal of this.assembler.next(ev)) this.applyRaidSignal(signal);
  }

  private applyRaidSignal(signal: RaidSignal): void {
    const { draft, ts } = signal;
    switch (signal.type) {
      case "created":
        this.store.events.emit("raid.created", { sid: draft.sid, ts });
        return;
      case "confirmed":
        this.store.events.emit("raid.confirmed", { sid: draft.sid ?? "", map: draft.map ?? "", mode: draft.mode, ts });
        return;
      case "started":
        this.store.events.emit("raid.started", { sid: draft.sid, map: draft.map, mode: draft.mode, ts });
        return;
      case "ended":
        this.store.recordRaid(draft, "live", this.session?.version ?? null);
        this.store.events.emit("raid.ended", {
          sid: draft.sid,
          map: draft.map,
          mode: draft.mode,
          ts,
          durationSec: draft.durationSec,
          outcome: draft.outcome,
        });
        return;
    }
  }

  private persistCursor(): void {
    if (!this.session) return;
    const offsets: Record<string, number> = {};
    for (const [file, { tail }] of this.streams) offsets[file] = tail.offset;
    this.store.setLogCursor({ session: this.session.name, offsets } satisfies LogCursor);
  }
}
