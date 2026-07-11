import { readFileSync } from "node:fs";
import type { GameMode } from "@tac/shared";
import { listSessionFolders, sessionStreams, type SessionFolder } from "./logs/discover.js";
import { parseLogFileText, type ParsedEvent } from "./logs/parse.js";
import { RaidAssembler } from "./logs/raids.js";
import type { ProfileStore } from "./store.js";

/**
 * @tier T1 — historical backfill (SPEC M2.3): replay EVERY session folder,
 * oldest → newest, reconstructing task state, the raid journal, and flea-sale
 * history with `source='backfill'`.
 *
 * (profileId, version) breakpoints: sessions are attributed to the PMC profile
 * selected in them (`CompleteSelectedProfile`); sessions for other profiles
 * (e.g. an alt account) are skipped, and every (profileId, version) change
 * across the scan is reported so callers can reason about patch/prestige
 * boundaries. Scav raids inside a matching session carry a different
 * per-raid profileid — they are still this player's raids and are journaled.
 *
 * Idempotent: all writes dedupe (quest events on (task,status,ts); raids on
 * sid; flea sales on (item,amount,ts)) — re-running changes nothing.
 */

export interface BackfillOptions {
  logsDir: string;
  /** only replay sessions selected into this profile id; default = the profile
   * seen in the most recent session (or the store's persisted profileId) */
  profileId?: string;
  /** only replay sessions of this mode; default = the store's gameMode */
  gameMode?: GameMode;
}

export interface BackfillBreakpoint {
  profileId: string | null;
  version: string | null;
  session: string;
}

export interface BackfillResult {
  sessionsScanned: number;
  sessionsReplayed: number;
  sessionsSkipped: number;
  questEventsApplied: number;
  raidsRecorded: number;
  fleaSalesRecorded: number;
  breakpoints: BackfillBreakpoint[];
}

interface SessionScan {
  folder: SessionFolder;
  events: ParsedEvent[];
  profileId: string | null;
  mode: GameMode;
}

function scanSession(folder: SessionFolder): SessionScan {
  const streams = sessionStreams(folder.dir);
  const events: ParsedEvent[] = [];
  for (const file of [...streams.application, ...streams.pushNotifications]) {
    try {
      events.push(...parseLogFileText(readFileSync(file, "utf8")));
    } catch {
      // unreadable stream (partial copy, locked) — skip the file, keep the session
    }
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  let profileId: string | null = null;
  let mode: GameMode = "regular";
  for (const ev of events) {
    if (ev.kind === "profile" && profileId === null) profileId = ev.profileId;
    if (ev.kind === "sessionMode") mode = ev.mode;
  }
  return { folder, events, profileId, mode };
}

/** Replay all historical sessions into the store. Safe to re-run (idempotent). */
export function backfillHistory(store: ProfileStore, opts: BackfillOptions): BackfillResult {
  const result: BackfillResult = {
    sessionsScanned: 0,
    sessionsReplayed: 0,
    sessionsSkipped: 0,
    questEventsApplied: 0,
    raidsRecorded: 0,
    fleaSalesRecorded: 0,
    breakpoints: [],
  };

  const scans = listSessionFolders(opts.logsDir).map(scanSession);
  result.sessionsScanned = scans.length;

  const targetMode = opts.gameMode ?? store.gameMode;
  const targetProfile =
    opts.profileId ??
    store.profileId ??
    [...scans].reverse().find((s) => s.profileId !== null && s.mode === targetMode)?.profileId ??
    null;

  let lastKey: string | null = null;
  for (const scan of scans) {
    const key = `${scan.profileId ?? "?"}@${scan.folder.version ?? "?"}`;
    if (key !== lastKey) {
      result.breakpoints.push({
        profileId: scan.profileId,
        version: scan.folder.version,
        session: scan.folder.name,
      });
      lastKey = key;
    }

    if (scan.mode !== targetMode || (targetProfile !== null && scan.profileId !== null && scan.profileId !== targetProfile)) {
      result.sessionsSkipped++;
      continue;
    }

    const assembler = new RaidAssembler(scan.mode);
    for (const ev of scan.events) {
      switch (ev.kind) {
        case "quest":
          if (store.applyQuestEvent({ taskId: ev.taskId, status: ev.status, ts: ev.ts }, "backfill", false))
            result.questEventsApplied++;
          break;
        case "fleaSale":
          if (store.recordFleaSale({ itemId: ev.itemId, amount: ev.amount, ts: ev.ts }, false))
            result.fleaSalesRecorded++;
          break;
        default:
          for (const signal of assembler.next(ev)) {
            if (signal.type === "ended" && store.recordRaid(signal.draft, "backfill", scan.folder.version) !== null)
              result.raidsRecorded++;
          }
      }
    }
    for (const signal of assembler.flush()) {
      if (signal.type === "ended" && store.recordRaid(signal.draft, "backfill", scan.folder.version) !== null)
        result.raidsRecorded++;
    }

    if (targetProfile !== null && !store.profileId && scan.profileId === targetProfile)
      store.setMeta("profileId", targetProfile, "backfill");
    result.sessionsReplayed++;
  }

  store.events.emit("state.changed", { reason: "backfill", ts: new Date().toISOString() });
  return result;
}
