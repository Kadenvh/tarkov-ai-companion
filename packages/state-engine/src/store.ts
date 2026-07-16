import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { GameMode } from "@tac/shared";
import { REPO_ROOT } from "@tac/data-core";
import { openDatabase } from "./db.js";
import { EngineEmitter, type RaidOutcome } from "./events.js";
import type { RaidDraft } from "./logs/raids.js";

/**
 * ProfileStore — the per-profile player model (SPEC M2.1), TarkovTracker-shaped
 * so the mirror sync (M2.7) is near-identity. One SQLite file per profileKey
 * (`<accountLabel>-<gameMode>`, e.g. `main-regular`) under `data/local/profiles/`.
 *
 * All mutations emit `state.changed`; domain events (raid.*, quest.changed,
 * flea.sale, …) are emitted by the watcher/appliers through `store.events`
 * (CONTRACTS §3).
 */

export type EventSource = "live" | "backfill";

export interface OpenProfileOptions {
  /** directory for the sqlite file (default `<repo>/data/local/profiles`) */
  dir?: string;
  /** in-memory database (tests) */
  memory?: boolean;
}

export interface TaskStateRow {
  taskId: string;
  complete: boolean;
  failed: boolean;
  ts: string | null;
}

export interface ObjectiveStateRow {
  objectiveId: string;
  count: number;
  complete: boolean;
  ts: string | null;
}

export interface TraderStateRow {
  traderId: string;
  level: number;
  rep: number;
  ts: string | null;
}

/** A `connector_reading` insert (CONTRACTS §4). `data` is any JSON-serializable payload. */
export interface ConnectorReadingInput {
  connectorId: string;
  capability: string;
  capturedAt: string;
  gameVersion?: string | null;
  settingsHash?: string | null;
  raidId?: number | null;
  data: unknown;
  /** Provenance: a live connector read vs. a manual capture. */
  source?: "connector" | "manual";
}

/** A `connector_reading` row read back (data re-parsed from JSON). */
export interface ConnectorReadingRow {
  id: number;
  connectorId: string;
  capability: string;
  capturedAt: string;
  gameVersion: string | null;
  settingsHash: string | null;
  raidId: number | null;
  data: unknown;
  source: string;
}

/** Filters for {@link ProfileStore.listConnectorReadings}. */
export interface ConnectorReadingQuery {
  capability?: string;
  /** ISO-8601 lower bound on `captured_at` (inclusive). */
  sinceIso?: string;
  limit?: number;
}

/** The remaining external-API budget persisted for one source (CONTRACTS §4). */
export interface SourceQuotaRow {
  sourceId: string;
  readsRemaining: number | null;
  writesRemaining: number | null;
  resetsAt: string | null;
  updatedAt: string;
}

/** A `source_quota` upsert patch — fields left `undefined` preserve the stored value. */
export interface SourceQuotaPatch {
  readsRemaining?: number;
  writesRemaining?: number;
  resetsAt?: string;
}

/** Structurally satisfies @tac/planner's PlayerState input (planner is not a dependency). */
export interface PlayerStateShape {
  gameMode: GameMode;
  level: number;
  faction?: "USEC" | "BEAR";
  prestige: number;
  completedTasks: string[];
  failedTasks: string[];
  traderRep: Record<string, number>;
}

// ---------------------------------------------------------------------------
// TarkovTracker GET /progress schema (research/02 §1/§3) — tolerant, passthrough.

const TrackerTaskProgress = z
  .object({
    id: z.string(),
    complete: z.boolean().optional(),
    failed: z.boolean().optional(),
    invalid: z.boolean().optional(),
  })
  .passthrough();

const TrackerObjectiveProgress = z
  .object({
    id: z.string(),
    complete: z.boolean().optional(),
    count: z.number().optional(),
    invalid: z.boolean().optional(),
  })
  .passthrough();

const TrackerModuleProgress = z
  .object({ id: z.string(), complete: z.boolean().optional() })
  .passthrough();

export const TarkovTrackerProgress = z
  .object({
    tasksProgress: z.array(TrackerTaskProgress).default([]),
    taskObjectivesProgress: z.array(TrackerObjectiveProgress).default([]),
    hideoutModulesProgress: z.array(TrackerModuleProgress).default([]),
    hideoutPartsProgress: z.array(TrackerObjectiveProgress).default([]),
    playerLevel: z.number().optional(),
    gameEdition: z.union([z.string(), z.number()]).optional(),
    pmcFaction: z.string().optional(),
    displayName: z.string().optional(),
    userId: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();
export type TarkovTrackerProgress = z.infer<typeof TarkovTrackerProgress>;

/** hideout module ids in the 1.0.6 snapshot are `<stationId>-<level>` */
const MODULE_ID = /^([0-9a-f]{24})-(\d+)$/;

function nowIso(): string {
  return new Date().toISOString();
}

export class ProfileStore {
  readonly events = new EngineEmitter();

  constructor(
    readonly profileKey: string,
    readonly db: DatabaseSync,
  ) {}

  close(): void {
    this.db.close();
  }

  // -- meta -----------------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string | null, reason = `meta.${key}`): void {
    if (value === null) this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    else
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, value);
    this.changed(reason);
  }

  private metaNumber(key: string, fallback: number): number {
    const raw = this.getMeta(key);
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  private metaJson<T>(key: string): T | null {
    const raw = this.getMeta(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  get gameMode(): GameMode {
    const raw = this.getMeta("gameMode");
    const parsed = GameMode.safeParse(raw);
    if (parsed.success) return parsed.data;
    return this.profileKey.endsWith("-pve") ? "pve" : "regular";
  }

  get level(): number {
    return this.metaNumber("level", 1);
  }
  setLevel(level: number): void {
    this.setMeta("level", String(level), "level");
  }

  get xpOffset(): number {
    return this.metaNumber("xpOffset", 0);
  }
  setXpOffset(xp: number): void {
    this.setMeta("xpOffset", String(xp), "xpOffset");
  }

  get prestige(): number {
    return this.metaNumber("prestige", 0);
  }
  setPrestige(p: number): void {
    this.setMeta("prestige", String(p), "prestige");
  }

  get faction(): "USEC" | "BEAR" | null {
    const raw = this.getMeta("faction");
    return raw === "USEC" || raw === "BEAR" ? raw : null;
  }
  setFaction(f: "USEC" | "BEAR"): void {
    this.setMeta("faction", f, "faction");
  }

  get progressEpoch(): number {
    return this.metaNumber("progressEpoch", 0);
  }
  bumpProgressEpoch(): number {
    const next = this.progressEpoch + 1;
    this.setMeta("progressEpoch", String(next), "progressEpoch");
    return next;
  }

  get profileId(): string | null {
    return this.getMeta("profileId");
  }

  getGoals<T = unknown>(): T | null {
    return this.metaJson<T>("goals");
  }
  setGoals(goals: unknown): void {
    this.setMeta("goals", JSON.stringify(goals), "goals");
  }

  getWeights<T = unknown>(): T | null {
    return this.metaJson<T>("weights");
  }
  setWeights(weights: unknown): void {
    this.setMeta("weights", JSON.stringify(weights), "weights");
  }

  getLogCursor<T = unknown>(): T | null {
    return this.metaJson<T>("lastLogCursor");
  }
  setLogCursor(cursor: unknown): void {
    // cursor updates are bookkeeping, not player-state changes — no event
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES ('lastLogCursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(cursor));
  }

  // -- tasks ----------------------------------------------------------------

  getTask(taskId: string): TaskStateRow | null {
    const row = this.db
      .prepare("SELECT task_id, complete, failed, ts FROM task_state WHERE task_id = ?")
      .get(taskId) as { task_id: string; complete: number; failed: number; ts: string | null } | undefined;
    return row ? { taskId: row.task_id, complete: !!row.complete, failed: !!row.failed, ts: row.ts } : null;
  }

  getTasks(): TaskStateRow[] {
    const rows = this.db.prepare("SELECT task_id, complete, failed, ts FROM task_state").all() as {
      task_id: string;
      complete: number;
      failed: number;
      ts: string | null;
    }[];
    return rows.map((r) => ({ taskId: r.task_id, complete: !!r.complete, failed: !!r.failed, ts: r.ts }));
  }

  setTaskState(
    taskId: string,
    state: { complete?: boolean; failed?: boolean; ts?: string | null },
    reason = "task",
  ): void {
    const existing = this.getTask(taskId);
    const complete = state.complete ?? existing?.complete ?? false;
    const failed = state.failed ?? existing?.failed ?? false;
    const ts = state.ts !== undefined ? state.ts : (existing?.ts ?? nowIso());
    this.db
      .prepare(
        `INSERT INTO task_state (task_id, complete, failed, ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET complete = excluded.complete, failed = excluded.failed, ts = excluded.ts`,
      )
      .run(taskId, complete ? 1 : 0, failed ? 1 : 0, ts);
    this.changed(reason);
  }

  // -- objectives -----------------------------------------------------------

  setObjectiveState(
    objectiveId: string,
    state: { count?: number; complete?: boolean; ts?: string | null },
    reason = "objective",
  ): void {
    const existing = this.db
      .prepare("SELECT count, complete FROM objective_state WHERE objective_id = ?")
      .get(objectiveId) as { count: number; complete: number } | undefined;
    const count = state.count ?? existing?.count ?? 0;
    const complete = state.complete ?? !!existing?.complete;
    const ts = state.ts !== undefined ? state.ts : nowIso();
    this.db
      .prepare(
        `INSERT INTO objective_state (objective_id, count, complete, ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(objective_id) DO UPDATE SET count = excluded.count, complete = excluded.complete, ts = excluded.ts`,
      )
      .run(objectiveId, count, complete ? 1 : 0, ts);
    this.changed(reason);
  }

  getObjectives(): ObjectiveStateRow[] {
    const rows = this.db
      .prepare("SELECT objective_id, count, complete, ts FROM objective_state")
      .all() as { objective_id: string; count: number; complete: number; ts: string | null }[];
    return rows.map((r) => ({ objectiveId: r.objective_id, count: r.count, complete: !!r.complete, ts: r.ts }));
  }

  // -- hideout / traders ------------------------------------------------------

  setHideoutLevel(stationId: string, level: number, ts: string | null = null): void {
    this.db
      .prepare(
        `INSERT INTO hideout_state (station_id, level, ts) VALUES (?, ?, ?)
         ON CONFLICT(station_id) DO UPDATE SET level = excluded.level, ts = excluded.ts`,
      )
      .run(stationId, level, ts ?? nowIso());
    this.changed("hideout");
  }

  getHideout(): { stationId: string; level: number; ts: string | null }[] {
    const rows = this.db.prepare("SELECT station_id, level, ts FROM hideout_state").all() as {
      station_id: string;
      level: number;
      ts: string | null;
    }[];
    return rows.map((r) => ({ stationId: r.station_id, level: r.level, ts: r.ts }));
  }

  setTraderState(traderId: string, state: { level?: number; rep?: number }, ts: string | null = null): void {
    const existing = this.db
      .prepare("SELECT level, rep FROM trader_state WHERE trader_id = ?")
      .get(traderId) as { level: number; rep: number } | undefined;
    const level = state.level ?? existing?.level ?? 1;
    const rep = state.rep ?? existing?.rep ?? 0;
    this.db
      .prepare(
        `INSERT INTO trader_state (trader_id, level, rep, ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(trader_id) DO UPDATE SET level = excluded.level, rep = excluded.rep, ts = excluded.ts`,
      )
      .run(traderId, level, rep, ts ?? nowIso());
    this.changed("trader");
  }

  getTraders(): TraderStateRow[] {
    const rows = this.db.prepare("SELECT trader_id, level, rep, ts FROM trader_state").all() as {
      trader_id: string;
      level: number;
      rep: number;
      ts: string | null;
    }[];
    return rows.map((r) => ({ traderId: r.trader_id, level: r.level, rep: r.rep, ts: r.ts }));
  }

  // -- event application (watcher / backfill) --------------------------------

  /**
   * Apply a quest transition (log types 10/11/12). Idempotent: an identical
   * (task, status, ts, source) event is ignored, so backfill re-runs are safe.
   * Returns true when the event was new.
   */
  applyQuestEvent(
    ev: { taskId: string; status: "started" | "completed" | "failed"; ts: string },
    source: EventSource = "live",
    emit = true,
  ): boolean {
    const dupe = this.db
      .prepare("SELECT 1 FROM quest_events WHERE task_id = ? AND status = ? AND ts = ?")
      .get(ev.taskId, ev.status, ev.ts);
    if (dupe) return false;
    this.db
      .prepare("INSERT INTO quest_events (task_id, status, ts, source) VALUES (?, ?, ?, ?)")
      .run(ev.taskId, ev.status, ev.ts, source);

    if (ev.status === "completed") this.setTaskState(ev.taskId, { complete: true, failed: false, ts: ev.ts }, "quest");
    else if (ev.status === "failed") this.setTaskState(ev.taskId, { complete: false, failed: true, ts: ev.ts }, "quest");
    else if (!this.getTask(ev.taskId)) this.setTaskState(ev.taskId, { complete: false, failed: false, ts: ev.ts }, "quest");
    else this.changed("quest");

    if (emit) this.events.emit("quest.changed", { taskId: ev.taskId, status: ev.status, ts: ev.ts });
    return true;
  }

  /**
   * Journal a finished raid (M2.8). Dedupes on sid (or map+started_at when the
   * sid never arrived) so live-tail + backfill never double-write.
   * Returns the row id, or null when it was already journaled.
   */
  recordRaid(draft: RaidDraft, source: EventSource = "live", version: string | null = null): number | null {
    const dupe = draft.sid
      ? this.db.prepare("SELECT id FROM raids WHERE sid = ?").get(draft.sid)
      : this.db
          .prepare("SELECT id FROM raids WHERE sid IS NULL AND map IS ? AND started_at IS ?")
          .get(draft.map, draft.startedAt);
    if (dupe) return null;
    const res = this.db
      .prepare(
        `INSERT INTO raids (sid, map, mode, queued_at, started_at, ended_at, queue_sec, duration_sec, outcome, source, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draft.sid,
        draft.map,
        draft.mode,
        draft.queuedAt,
        draft.startedAt,
        draft.endedAt,
        draft.queueSec,
        draft.durationSec,
        draft.outcome,
        source,
        version,
      );
    this.changed("raid");
    return Number(res.lastInsertRowid);
  }

  /** Record a flea sale (log ChatMessageReceived type 4). Idempotent on (item, amount, ts). */
  recordFleaSale(ev: { itemId: string; amount: number; ts: string }, emit = true): boolean {
    const dupe = this.db
      .prepare("SELECT 1 FROM flea_sales WHERE item_name = ? AND amount = ? AND ts = ?")
      .get(ev.itemId, ev.amount, ev.ts);
    if (dupe) return false;
    this.db
      .prepare("INSERT INTO flea_sales (item_name, amount, ts) VALUES (?, ?, ?)")
      .run(ev.itemId, ev.amount, ev.ts);
    this.changed("flea");
    if (emit) this.events.emit("flea.sale", { itemName: ev.itemId, amount: ev.amount, ts: ev.ts });
    return true;
  }

  recordPosition(pos: { map: string | null; x: number; y: number; z: number; filename: string; ts: string }): void {
    this.db
      .prepare("INSERT INTO positions (raid_id, map, x, y, z, filename, ts) VALUES (NULL, ?, ?, ?, ?, ?, ?)")
      .run(pos.map, pos.x, pos.y, pos.z, pos.filename, pos.ts);
    this.changed("position");
    this.events.emit("position", pos);
  }

  // -- TarkovTracker import/export (M2.1 / M2.7) ------------------------------

  /**
   * Seed the store from a TarkovTracker `GET /progress` payload (either the
   * bare progress object or the `{ data: ... }` wrapper). Lossless: fields the
   * local schema has no table for (hideout parts, edition, display name, raw
   * module list) are kept in meta so `exportTarkovTracker()` round-trips.
   */
  importTarkovTracker(progressJson: unknown): TarkovTrackerProgress {
    const wrapped = progressJson as { data?: unknown } | null;
    const body = wrapped && typeof wrapped === "object" && "data" in wrapped ? wrapped.data : progressJson;
    const progress = TarkovTrackerProgress.parse(body);

    for (const t of progress.tasksProgress) {
      if (t.invalid) continue;
      this.setTaskState(t.id, { complete: t.complete ?? false, failed: t.failed ?? false, ts: null }, "import");
    }
    for (const o of progress.taskObjectivesProgress) {
      if (o.invalid) continue;
      this.setObjectiveState(o.id, { count: o.count ?? 0, complete: o.complete ?? false, ts: null }, "import");
    }

    // hideout module ids are `<stationId>-<level>` in current tarkov.dev data
    const stationLevels = new Map<string, number>();
    for (const m of progress.hideoutModulesProgress) {
      if (!m.complete) continue;
      const match = MODULE_ID.exec(m.id);
      if (!match) continue;
      const [, stationId, levelRaw] = match;
      const level = Number(levelRaw);
      if (stationId && level > (stationLevels.get(stationId) ?? 0)) stationLevels.set(stationId, level);
    }
    for (const [stationId, level] of stationLevels) this.setHideoutLevel(stationId, level, null);

    if (progress.playerLevel !== undefined) this.setLevel(progress.playerLevel);
    if (progress.pmcFaction === "USEC" || progress.pmcFaction === "BEAR") this.setFaction(progress.pmcFaction);

    this.setMeta("trackerHideoutModules", JSON.stringify(progress.hideoutModulesProgress), "import");
    this.setMeta("trackerHideoutParts", JSON.stringify(progress.hideoutPartsProgress), "import");
    if (progress.gameEdition !== undefined) this.setMeta("gameEdition", String(progress.gameEdition), "import");
    if (progress.displayName !== undefined) this.setMeta("displayName", progress.displayName, "import");

    this.changed("tarkovtracker.import");
    return progress;
  }

  /** Rebuild a TarkovTracker-progress-shaped object from local state (round-trip counterpart). */
  exportTarkovTracker(): TarkovTrackerProgress {
    const out: TarkovTrackerProgress = {
      tasksProgress: this.getTasks()
        .map((t) => ({ id: t.taskId, complete: t.complete, failed: t.failed }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      taskObjectivesProgress: this.getObjectives()
        .map((o) => ({ id: o.objectiveId, complete: o.complete, count: o.count }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      hideoutModulesProgress: this.metaJson<{ id: string; complete?: boolean }[]>("trackerHideoutModules") ?? [],
      hideoutPartsProgress: this.metaJson<{ id: string; complete?: boolean; count?: number }[]>("trackerHideoutParts") ?? [],
      playerLevel: this.level,
    };
    const faction = this.faction;
    if (faction) out.pmcFaction = faction;
    const edition = this.getMeta("gameEdition");
    if (edition !== null) out.gameEdition = edition;
    const displayName = this.getMeta("displayName");
    if (displayName !== null) out.displayName = displayName;
    return out;
  }

  // -- planner handoff --------------------------------------------------------

  toPlayerState(): PlayerStateShape {
    const tasks = this.getTasks();
    const traderRep: Record<string, number> = {};
    for (const t of this.getTraders()) traderRep[t.traderId] = t.rep;
    const state: PlayerStateShape = {
      gameMode: this.gameMode,
      level: this.level,
      prestige: this.prestige,
      completedTasks: tasks.filter((t) => t.complete).map((t) => t.taskId).sort(),
      failedTasks: tasks.filter((t) => t.failed && !t.complete).map((t) => t.taskId).sort(),
      traderRep,
    };
    const faction = this.faction;
    if (faction) state.faction = faction;
    return state;
  }

  // -- connector readings (M9 provenance store, M10 persistence) --------------

  /**
   * Persist a provenance-tagged connector/manual reading (CONTRACTS §4). `data`
   * is stored as JSON. Returns the row id. Bookkeeping (the service already
   * broadcasts `connector.reading` on the wire), so no `state.changed` emit.
   */
  insertConnectorReading(r: ConnectorReadingInput): number {
    const res = this.db
      .prepare(
        `INSERT INTO connector_reading
           (connector_id, capability, captured_at, game_version, settings_hash, raid_id, data, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.connectorId,
        r.capability,
        r.capturedAt,
        r.gameVersion ?? null,
        r.settingsHash ?? null,
        r.raidId ?? null,
        JSON.stringify(r.data ?? null),
        r.source ?? "connector",
      );
    return Number(res.lastInsertRowid);
  }

  /** Read connector readings back, most-recent first, with optional filters. */
  listConnectorReadings(query: ConnectorReadingQuery = {}): ConnectorReadingRow[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (query.capability !== undefined) {
      clauses.push("capability = ?");
      params.push(query.capability);
    }
    if (query.sinceIso !== undefined) {
      clauses.push("captured_at >= ?");
      params.push(query.sinceIso);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit =
      query.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(query.limit))}` : "";
    const rows = this.db
      .prepare(
        `SELECT id, connector_id, capability, captured_at, game_version, settings_hash, raid_id, data, source
         FROM connector_reading ${where} ORDER BY captured_at DESC, id DESC${limit}`,
      )
      .all(...params) as {
      id: number;
      connector_id: string;
      capability: string;
      captured_at: string;
      game_version: string | null;
      settings_hash: string | null;
      raid_id: number | null;
      data: string;
      source: string;
    }[];
    return rows.map((row) => {
      let data: unknown = null;
      try {
        data = JSON.parse(row.data);
      } catch {
        data = row.data;
      }
      return {
        id: row.id,
        connectorId: row.connector_id,
        capability: row.capability,
        capturedAt: row.captured_at,
        gameVersion: row.game_version,
        settingsHash: row.settings_hash,
        raidId: row.raid_id,
        data,
        source: row.source,
      };
    });
  }

  // -- source quota (M10 shared external-API budget, restore-across-restarts) --

  /**
   * Fold a source's remaining budget into the persisted ledger (CONTRACTS §4).
   * Merge semantics: fields absent from `patch` keep their stored value, so a
   * fold that only reports reads never clobbers a known write budget. Pure
   * bookkeeping shared with the user's other tools → no `state.changed` emit.
   */
  upsertSourceQuota(sourceId: string, patch: SourceQuotaPatch): void {
    const existing = this.getSourceQuota(sourceId);
    const readsRemaining =
      patch.readsRemaining !== undefined ? patch.readsRemaining : (existing?.readsRemaining ?? null);
    const writesRemaining =
      patch.writesRemaining !== undefined ? patch.writesRemaining : (existing?.writesRemaining ?? null);
    const resetsAt = patch.resetsAt !== undefined ? patch.resetsAt : (existing?.resetsAt ?? null);
    this.db
      .prepare(
        `INSERT INTO source_quota (source_id, reads_remaining, writes_remaining, resets_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           reads_remaining = excluded.reads_remaining,
           writes_remaining = excluded.writes_remaining,
           resets_at = excluded.resets_at,
           updated_at = excluded.updated_at`,
      )
      .run(sourceId, readsRemaining, writesRemaining, resetsAt, nowIso());
  }

  /** The persisted quota for one source, or `null` if none recorded yet. */
  getSourceQuota(sourceId: string): SourceQuotaRow | null {
    const row = this.db
      .prepare(
        "SELECT source_id, reads_remaining, writes_remaining, resets_at, updated_at FROM source_quota WHERE source_id = ?",
      )
      .get(sourceId) as
      | {
          source_id: string;
          reads_remaining: number | null;
          writes_remaining: number | null;
          resets_at: string | null;
          updated_at: string;
        }
      | undefined;
    return row
      ? {
          sourceId: row.source_id,
          readsRemaining: row.reads_remaining,
          writesRemaining: row.writes_remaining,
          resetsAt: row.resets_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  /** Every persisted source quota row (for restore-on-startup seeding). */
  getAllSourceQuota(): SourceQuotaRow[] {
    const rows = this.db
      .prepare(
        "SELECT source_id, reads_remaining, writes_remaining, resets_at, updated_at FROM source_quota",
      )
      .all() as {
      source_id: string;
      reads_remaining: number | null;
      writes_remaining: number | null;
      resets_at: string | null;
      updated_at: string;
    }[];
    return rows.map((row) => ({
      sourceId: row.source_id,
      readsRemaining: row.reads_remaining,
      writesRemaining: row.writes_remaining,
      resetsAt: row.resets_at,
      updatedAt: row.updated_at,
    }));
  }

  // -- internals --------------------------------------------------------------

  private changed(reason: string): void {
    this.events.emit("state.changed", { reason, ts: nowIso() });
  }
}

/** Default on-disk location for profile databases (CONTRACTS §2). */
export function defaultProfileDir(): string {
  return join(REPO_ROOT, "data", "local", "profiles");
}

/**
 * Open (creating if needed) the per-profile store.
 * `profileKey` = `<accountLabel>-<gameMode>`, e.g. `main-regular`, `main-pve`.
 */
export function openProfile(profileKey: string, opts: OpenProfileOptions = {}): ProfileStore {
  if (!/^[\w.-]+$/.test(profileKey)) throw new Error(`invalid profileKey: ${profileKey}`);
  const location = opts.memory ? ":memory:" : join(opts.dir ?? defaultProfileDir(), `${profileKey}.sqlite`);
  const store = new ProfileStore(profileKey, openDatabase(location));
  const mode: GameMode = profileKey.endsWith("-pve") ? "pve" : "regular";
  if (store.getMeta("gameMode") === null) store.setMeta("gameMode", mode, "init");
  return store;
}
