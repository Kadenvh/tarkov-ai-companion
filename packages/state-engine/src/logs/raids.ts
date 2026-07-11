import type { GameMode } from "@tac/shared";
import type { RaidOutcome } from "../events.js";
import { normalizeLocation, type ParsedEvent } from "./parse.js";

/**
 * Raid lifecycle assembly — turns the flat semantic event stream (application +
 * push-notifications, merged in timestamp order) into raid records and
 * CONTRACTS §3 lifecycle emissions.
 *
 * Ground truth (verified in real logs):
 *  - `userMatchCreated` (push)  → queue entered, no sid yet
 *  - `userConfirmed` (push)     → sid + location assigned; `matchFound`
 *    (application TRACE-NetworkGameCreate) is the same fact and fills gaps
 *  - `GameStarted` (application) → raid clock starts
 *  - `userMatchOver` (push)     → clean raid end (often missing — the game
 *    frequently rotates the websocket); fall back to the post-raid menu
 *    return (`Init: pstrGameVersion`) as an inferred end
 *  - a repeated shortId on confirm = reconnect into the same raid, not a new one
 *
 * Outcome: the logs contain no survived/died/extract signal (research/03 §2 —
 * grep-verified). Every log-derived raid is `unknown`; manual/OCR sources can
 * upgrade it later via `setRaidOutcome`.
 */

export interface RaidDraft {
  sid: string | null;
  map: string | null;
  mode: GameMode;
  shortId: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  queueSec: number | null;
  durationSec: number | null;
  outcome: RaidOutcome;
  /** true when the end was inferred from the menu return rather than userMatchOver */
  endInferred: boolean;
}

export type RaidSignal =
  | { type: "created"; ts: string; draft: RaidDraft }
  | { type: "confirmed"; ts: string; draft: RaidDraft }
  | { type: "started"; ts: string; draft: RaidDraft }
  | { type: "ended"; ts: string; draft: RaidDraft };

function secondsBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Number.isFinite(ms) ? Math.round(ms / 100) / 10 : null;
}

export class RaidAssembler {
  private draft: RaidDraft | null = null;
  private lastShortId: string | null = null;
  mode: GameMode;

  constructor(mode: GameMode = "regular") {
    this.mode = mode;
  }

  /** Feed one semantic event; returns raid lifecycle signals to act on. */
  next(ev: ParsedEvent): RaidSignal[] {
    switch (ev.kind) {
      case "sessionMode":
        this.mode = ev.mode;
        return [];

      case "matchCreated": {
        // queue (re-)entered; a fresh created while an unstarted draft exists replaces it
        if (this.draft && this.draft.startedAt) return []; // in-raid noise
        this.draft = this.newDraft(ev.ts);
        return [{ type: "created", ts: ev.ts, draft: this.draft }];
      }

      case "matchConfirmed":
      case "matchFound": {
        const sid = ev.sid || null;
        const shortId = ev.shortId ?? null;
        const location = normalizeLocation(ev.location);
        // reconnect: same shortId as the raid we already track (or just closed)
        if (shortId && this.draft?.shortId === shortId) {
          this.draft.sid ??= sid;
          this.draft.map ??= location || null;
          return [];
        }
        if (shortId && !this.draft && shortId === this.lastShortId) return [];
        if (!this.draft || this.draft.startedAt) {
          // confirm without a created (application-only stream, or push loss)
          this.draft = this.newDraft(null);
        }
        const already = this.draft.sid !== null;
        this.draft.sid = sid ?? this.draft.sid;
        this.draft.map = location || this.draft.map;
        this.draft.shortId = shortId ?? this.draft.shortId;
        if (already || ev.kind === "matchFound") return []; // matchFound duplicates userConfirmed
        return [{ type: "confirmed", ts: ev.ts, draft: this.draft }];
      }

      case "gameStarted": {
        if (!this.draft) this.draft = this.newDraft(null);
        if (this.draft.startedAt) return []; // duplicate
        this.draft.startedAt = ev.ts;
        this.draft.queueSec = secondsBetween(this.draft.queuedAt, ev.ts);
        return [{ type: "started", ts: ev.ts, draft: this.draft }];
      }

      case "matchOver": {
        const draft = this.draft;
        if (!draft) return [];
        draft.endedAt = ev.ts;
        draft.durationSec = secondsBetween(draft.startedAt, ev.ts);
        draft.map ??= normalizeLocation(ev.location) || null;
        draft.sid ??= ev.sid || null;
        return this.finish(ev.ts);
      }

      case "menu": {
        // post-raid menu return = inferred raid end (userMatchOver often absent)
        if (this.draft?.startedAt) {
          this.draft.endedAt = ev.ts;
          this.draft.durationSec = secondsBetween(this.draft.startedAt, ev.ts);
          this.draft.endInferred = true;
          return this.finish(ev.ts);
        }
        return [];
      }

      case "matchingCancelled": {
        if (this.draft && !this.draft.startedAt) this.draft = null;
        return [];
      }

      default:
        return [];
    }
  }

  /** End of stream/session: close out a raid that never saw an end marker. */
  flush(ts: string | null = null): RaidSignal[] {
    if (this.draft?.startedAt) {
      this.draft.endInferred = true;
      if (ts) {
        this.draft.endedAt = ts;
        this.draft.durationSec = secondsBetween(this.draft.startedAt, ts);
      }
      return this.finish(ts ?? this.draft.startedAt);
    }
    this.draft = null;
    return [];
  }

  private finish(ts: string): RaidSignal[] {
    const draft = this.draft;
    this.draft = null;
    if (!draft) return [];
    this.lastShortId = draft.shortId;
    return [{ type: "ended", ts, draft }];
  }

  private newDraft(queuedAt: string | null): RaidDraft {
    return {
      sid: null,
      map: null,
      mode: this.mode,
      shortId: null,
      queuedAt,
      startedAt: null,
      endedAt: null,
      queueSec: null,
      durationSec: null,
      outcome: "unknown",
      endInferred: false,
    };
  }
}
