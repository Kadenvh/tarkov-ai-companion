/**
 * M7.5 — Highlight-index. For each recent raid we build a wall-clock timeline
 * of notable moments from the event streams already in the DB, expressed as
 * SECOND OFFSETS from the raid's start. This makes a ShadowPlay / instant-replay
 * recording trivially clippable: "14:32 quest complete, 14:45 died".
 *
 * Marker sources (present-data only, all matched to the raid window by ts):
 *   - raid-start / raid-end (+ outcome)                  from `raids`
 *   - quest-completed / quest-failed / quest-started     from `quest_events`
 *   - flea-sale                                          from `flea_sales`
 *   - position (screenshot marker)                       from `positions`
 *
 * NOTE: kill-level markers (kills, headshots, extractions) await a dedicated
 * kills log-parser and are intentionally OUT OF SCOPE for this pass — the game
 * logs we currently persist do not carry per-kill events. When that parser
 * lands it should emit `kind: "kill"` markers here with the same tOffsetSec
 * convention.
 *
 * @tier T0 — pure computation over the app-owned profile DB.
 */

import type { DatabaseSync } from "node:sqlite";
import { epochMs, round4 } from "./util.js";
import { loadRaids, raidTs, type RaidRow } from "./raids.js";

export type MarkerKind =
  | "raid-start"
  | "raid-end"
  | "quest-completed"
  | "quest-failed"
  | "quest-started"
  | "flea-sale"
  | "position";

export interface HighlightMarker {
  /** Seconds from raid start (raid-start is 0). Clamped to >= 0. */
  tOffsetSec: number;
  kind: MarkerKind;
  label: string;
  /** "MM:SS" (or "H:MM:SS") rendering of tOffsetSec, for the clip guide. */
  clock: string;
}

export interface RaidHighlights {
  raidId: number;
  sid: string | null;
  map: string | null;
  /** Wall-clock anchor = started_at ?? queued_at ?? ended_at. */
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  outcome: RaidRow["outcome"];
  markers: HighlightMarker[];
}

function clockOf(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function questKind(status: string): MarkerKind | null {
  const s = status.toLowerCase();
  if (s === "completed" || s === "complete" || s === "finished") return "quest-completed";
  if (s === "failed" || s === "fail") return "quest-failed";
  if (s === "started" || s === "start" || s === "accepted") return "quest-started";
  return null;
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Build the marker timeline for a single raid. Returns null when the raid is
 * unknown or has no parseable start timestamp (nothing to anchor offsets to).
 */
export function raidHighlights(db: DatabaseSync, raidId: number): RaidHighlights | null {
  const raid = loadRaids(db).find((r) => r.id === raidId);
  if (!raid) return null;
  return buildHighlights(db, raid);
}

function buildHighlights(db: DatabaseSync, raid: RaidRow): RaidHighlights | null {
  const startTs = raidTs(raid);
  const startMs = epochMs(startTs);
  if (startTs === null || startMs === null) return null;

  // The end anchor is the *actual* ended_at (never raidEndTs, which falls back
  // to started_at) or, failing that, start + duration_sec. Null => open raid.
  const endedAtMs = epochMs(raid.endedAt);
  const durationEndMs = raid.durationSec != null ? startMs + raid.durationSec * 1000 : null;
  const endMs = endedAtMs ?? durationEndMs;
  // Window end for matching events: the end anchor, else a generous 1h fallback.
  const windowEndMs = endMs ?? startMs + 3_600_000;

  const markers: HighlightMarker[] = [];
  const push = (atMs: number, kind: MarkerKind, label: string): void => {
    const tOffsetSec = round4(Math.max(0, (atMs - startMs) / 1000));
    markers.push({ tOffsetSec, kind, label, clock: clockOf(tOffsetSec) });
  };

  // Raid start.
  push(startMs, "raid-start", `Raid start${raid.map ? ` — ${raid.map}` : ""}`);

  // Quest events inside the window.
  const questRows = db.prepare(`SELECT task_id, status, ts FROM quest_events ORDER BY ts, id`).all() as {
    task_id: string;
    status: string;
    ts: string;
  }[];
  for (const q of questRows) {
    const ms = epochMs(q.ts);
    if (ms === null || ms < startMs || ms > windowEndMs) continue;
    const kind = questKind(q.status);
    if (!kind) continue;
    const verb = kind === "quest-completed" ? "Quest completed" : kind === "quest-failed" ? "Quest failed" : "Quest started";
    push(ms, kind, `${verb}: ${shortId(q.task_id)}`);
  }

  // Flea sales inside the window (usually menu-side, but a coach clip may still
  // want them adjacent to the raid).
  const saleRows = db.prepare(`SELECT item_name, amount, ts FROM flea_sales ORDER BY ts, id`).all() as {
    item_name: string;
    amount: number;
    ts: string;
  }[];
  for (const sale of saleRows) {
    const ms = epochMs(sale.ts);
    if (ms === null || ms < startMs || ms > windowEndMs) continue;
    push(ms, "flea-sale", `Flea sale: ${sale.item_name} (₽${Number(sale.amount).toLocaleString("en-US")})`);
  }

  // Position markers (in-raid screenshots) — matched by raid_id when present,
  // else by falling inside the window.
  const posRows = db.prepare(`SELECT raid_id, map, x, y, z, ts FROM positions ORDER BY ts, id`).all() as {
    raid_id: number | null;
    map: string | null;
    x: number;
    y: number;
    z: number;
    ts: string;
  }[];
  for (const p of posRows) {
    const ms = epochMs(p.ts);
    if (ms === null) continue;
    const belongs = p.raid_id === raid.id || (p.raid_id == null && ms >= startMs && ms <= windowEndMs);
    if (!belongs) continue;
    push(ms, "position", `Position ${Math.round(p.x)} · ${Math.round(p.y)} · ${Math.round(p.z)}`);
  }

  // Raid end (+ outcome) — the clippable "moment of death / extract".
  if (endMs !== null && endMs >= startMs) {
    const outcomeLabel =
      raid.outcome === "survived" ? "Survived" : raid.outcome === "died" ? "Died" : "Raid end";
    push(endMs, "raid-end", outcomeLabel);
  }

  // Stable order: by offset, then a fixed kind priority so ties are deterministic.
  const kindOrder: Record<MarkerKind, number> = {
    "raid-start": 0,
    "quest-started": 1,
    "quest-completed": 2,
    "quest-failed": 3,
    "flea-sale": 4,
    position: 5,
    "raid-end": 6,
  };
  markers.sort((a, b) => a.tOffsetSec - b.tOffsetSec || kindOrder[a.kind] - kindOrder[b.kind]);

  return {
    raidId: raid.id,
    sid: raid.sid,
    map: raid.map,
    startedAt: startTs,
    endedAt: raid.endedAt,
    durationSec: raid.durationSec,
    outcome: raid.outcome,
    markers,
  };
}

/** The most recent raids (by start timestamp), each with its marker timeline. */
export function recentHighlights(db: DatabaseSync, limit = 10): RaidHighlights[] {
  const timed = loadRaids(db)
    .map((r) => ({ raid: r, ms: epochMs(raidTs(r)) }))
    .filter((r): r is { raid: RaidRow; ms: number } => r.ms !== null)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, Math.max(0, Math.floor(limit)));
  const out: RaidHighlights[] = [];
  for (const { raid } of timed) {
    const h = buildHighlights(db, raid);
    if (h) out.push(h);
  }
  return out;
}
