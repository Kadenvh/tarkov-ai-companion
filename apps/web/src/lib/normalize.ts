/**
 * Tolerant readers for service responses whose exact JSON shape is service-
 * defined (CONTRACTS pins the semantics, not the field names, for /api/state,
 * /api/graph/summary, /api/environment/settings, /api/insights/*).
 *
 * Every reader degrades to a well-formed empty result — shape drift between
 * parallel-built apps must show an empty state, never a crash. The exact
 * shapes assumed here are documented in docs/spec/SPEC-7.md for the
 * integration wave.
 */

import type {
  AttributionFinding,
  AttributionReport,
  ConnectorHealth,
  ConnectorInfo,
  FleaIncome,
  ForesightWarning,
  GoalProjection,
  HighlightMarker,
  NetWorthEstimate,
  NetWorthGoalReport,
  PerfMapRow,
  Plan,
  PlanResponse,
  PositionPayload,
  QueueStat,
  RaidHighlights,
  SessionRhythm,
  SettingDiff,
  SourceQuota,
  SourceStatusRow,
  StoryResponse,
  SurvivalByDurationRow,
  SurvivalByHourRow,
  SurvivalByMapRow,
  TelemetrySample,
} from "../api/types";

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

function pick(source: Rec, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in source && source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

// ---------- /api/state ----------

export interface NormalizedPlayerState {
  level: number;
  faction?: "USEC" | "BEAR";
  prestige: number;
  gameMode?: string;
  progressEpoch?: number;
  completedTasks: number;
  failedTasks: number;
  xp?: { value?: number; low?: number; high?: number };
  positions: PositionPayload[];
  /** true when the profile looks untouched (level<=1, nothing completed) — onboarding trigger */
  empty: boolean;
}

function countTasks(tasks: unknown): { completed: number; failed: number } {
  let completed = 0;
  let failed = 0;
  const list = arr(tasks);
  if (list) {
    // array of rows: { taskId, complete, failed }
    for (const row of list) {
      const r = rec(row);
      if (!r) continue;
      if (r["complete"] === true) completed++;
      if (r["failed"] === true) failed++;
    }
    return { completed, failed };
  }
  const record = rec(tasks);
  if (record) {
    // record: taskId -> { complete, failed }
    for (const value of Object.values(record)) {
      const r = rec(value);
      if (!r) continue;
      if (r["complete"] === true) completed++;
      if (r["failed"] === true) failed++;
    }
  }
  return { completed, failed };
}

function readPositions(raw: unknown): PositionPayload[] {
  const list = arr(raw);
  if (!list) return [];
  const out: PositionPayload[] = [];
  for (const row of list) {
    const r = rec(row);
    if (!r) continue;
    const x = num(r["x"]);
    const y = num(r["y"]);
    const z = num(r["z"]);
    const ts = str(r["ts"]);
    if (x === undefined || y === undefined || z === undefined || !ts) continue;
    const pos: PositionPayload = { x, y, z, ts };
    const map = str(r["map"]);
    if (map !== undefined) pos.map = map;
    const filename = str(r["filename"]);
    if (filename !== undefined) pos.filename = filename;
    out.push(pos);
  }
  return out;
}

// ---------- GET /api/plan ----------

/**
 * The service returns a nested PlanBundle ({hash, builtAt, plan:{raids…},
 * foresight:[{raidIndex, warnings}], mapNames}) while the WS plan.updated
 * frame carries a flattened summary. Accept both: flatten the bundle into the
 * PlanResponse shape the views consume; pass an already-flat payload through.
 * Anything without raids is null (the view shows its empty state).
 */
export function normalizePlanResponse(raw: unknown): PlanResponse | null {
  const root = rec(raw);
  if (!root) return null;

  const inner = rec(root["plan"]);
  if (!inner || !Array.isArray(inner["raids"])) {
    return Array.isArray(root["raids"]) ? (raw as PlanResponse) : null;
  }

  const warnings: Record<string, ForesightWarning[]> = {};
  for (const entry of arr(root["foresight"]) ?? []) {
    const e = rec(entry);
    if (!e) continue;
    const idx = num(e["raidIndex"]);
    const w = arr(e["warnings"]);
    if (idx !== undefined && w) warnings[String(idx)] = w as ForesightWarning[];
  }

  const out: PlanResponse = { ...(inner as unknown as Plan), warnings };
  const hash = str(root["hash"]);
  if (hash !== undefined) out.hash = hash;
  const builtAt = str(root["builtAt"]);
  if (builtAt !== undefined) out.generatedAt = builtAt;
  const mapNames = rec(root["mapNames"]);
  if (mapNames) {
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(mapNames)) {
      const name = str(v);
      if (name !== undefined) names[k] = name;
    }
    out.mapNames = names;
  }
  return out;
}

// ---------- GET /api/story ----------

/**
 * The service returns {dataset: {chapters, decisions, endings, …}, player:
 * {stages, decisions, endings…}}; the views consume a flattened StoryResponse.
 * Accept both (regression: the Goals view crashed on the nested envelope).
 */
export function normalizeStoryResponse(raw: unknown): StoryResponse | null {
  const root = rec(raw);
  if (!root) return null;
  if (Array.isArray(root["chapters"])) return raw as StoryResponse;

  const dataset = rec(root["dataset"]);
  if (!dataset || !Array.isArray(dataset["chapters"])) return null;
  const player = rec(root["player"]);
  const out = { ...(dataset as unknown as StoryResponse) };
  const stages = rec(player?.["stages"]);
  const decisions = rec(player?.["decisions"]);
  if (stages || decisions) {
    out.playerStatus = {
      ...(stages ? { stages: stages as Record<string, boolean> } : {}),
      ...(decisions ? { decisions: decisions as Record<string, string> } : {}),
    };
  }
  return out;
}

export function readPlayerState(raw: unknown): NormalizedPlayerState {
  const root = rec(raw) ?? {};

  // level may live at top level or under an xp/estimate object
  const xpObj = rec(pick(root, "xp", "xpEstimate", "estimate"));
  const level = num(pick(root, "level")) ?? num(xpObj?.["level"]) ?? 1;

  const factionRaw = str(pick(root, "faction", "pmcFaction"));
  const faction = factionRaw === "USEC" || factionRaw === "BEAR" ? factionRaw : undefined;

  // completed/failed: arrays of ids, task rows, or a record
  const explicitCompleted = arr(pick(root, "completedTasks"));
  const explicitFailed = arr(pick(root, "failedTasks"));
  let completedTasks: number;
  let failedTasks: number;
  if (explicitCompleted || explicitFailed) {
    completedTasks = explicitCompleted?.length ?? 0;
    failedTasks = explicitFailed?.length ?? 0;
  } else {
    const counted = countTasks(pick(root, "tasks", "taskState"));
    completedTasks = counted.completed;
    failedTasks = counted.failed;
  }

  const confidence = rec(xpObj?.["confidence"]);
  const xpValue = num(xpObj?.["xp"]) ?? num(pick(root, "xpValue"));
  const low = num(confidence?.["low"]);
  const high = num(confidence?.["high"]);
  const xp =
    xpValue !== undefined || low !== undefined || high !== undefined
      ? {
          ...(xpValue !== undefined ? { value: xpValue } : {}),
          ...(low !== undefined ? { low } : {}),
          ...(high !== undefined ? { high } : {}),
        }
      : undefined;

  const out: NormalizedPlayerState = {
    level,
    prestige: num(pick(root, "prestige")) ?? 0,
    completedTasks,
    failedTasks,
    positions: readPositions(pick(root, "positions", "positionHistory")),
    empty: level <= 1 && completedTasks === 0,
  };
  if (faction) out.faction = faction;
  const gameMode = str(pick(root, "gameMode", "mode"));
  if (gameMode) out.gameMode = gameMode;
  const epoch = num(pick(root, "progressEpoch", "epoch"));
  if (epoch !== undefined) out.progressEpoch = epoch;
  if (xp) out.xp = xp;
  return out;
}

// ---------- /api/graph/summary ----------

export interface GoalTrackSummary {
  total: number | null;
  remaining: number | null;
  /** completed = total - remaining when both known */
  done: number | null;
  pct: number | null;
}

export interface NormalizedGraphSummary {
  taskCount: number | null;
  kappa: GoalTrackSummary;
  lightkeeper: GoalTrackSummary;
}

/** SPEC.md M1.6 invariants — fallback totals when the summary omits them. */
export const KAPPA_TOTAL_FALLBACK = 257;
export const LIGHTKEEPER_TOTAL_FALLBACK = 102;

function track(root: Rec, prefix: "kappa" | "lightkeeper", fallbackTotal: number): GoalTrackSummary {
  const nested = rec(root[prefix]);
  const total =
    num(nested?.["total"]) ??
    num(pick(root, `${prefix}Total`, `${prefix}Required`)) ??
    fallbackTotal;
  const remaining =
    num(nested?.["remaining"]) ?? num(pick(root, `${prefix}Remaining`)) ?? null;
  const doneExplicit = num(nested?.["done"]) ?? num(pick(root, `${prefix}Done`, `${prefix}Complete`));
  const done = doneExplicit ?? (remaining !== null ? Math.max(0, total - remaining) : null);
  const pct = done !== null && total > 0 ? done / total : null;
  return { total, remaining, done, pct };
}

export function readGraphSummary(raw: unknown): NormalizedGraphSummary {
  const root = rec(raw) ?? {};
  return {
    taskCount: num(pick(root, "taskCount", "tasks", "totalTasks")) ?? null,
    kappa: track(root, "kappa", KAPPA_TOTAL_FALLBACK),
    lightkeeper: track(root, "lightkeeper", LIGHTKEEPER_TOTAL_FALLBACK),
  };
}

// ---------- /api/environment/settings ----------

function isDiffArray(v: unknown): v is SettingDiff[] {
  const list = arr(v);
  if (!list) return false;
  return list.every((item) => {
    const r = rec(item);
    return r !== null && typeof r["key"] === "string" && "recommended" in r;
  });
}

/**
 * Accepts either `{ profiles: { "max-fps": SettingDiff[] } }`, `{ diffs: ... }`
 * or the bare `diffAllProfiles()` record `{ "max-fps": SettingDiff[], ... }`.
 */
export function readSettingsDiffs(raw: unknown): Record<string, SettingDiff[]> {
  const root = rec(raw);
  if (!root) return {};
  for (const key of ["profiles", "diffs"]) {
    const nested = rec(root[key]);
    if (nested) {
      const out: Record<string, SettingDiff[]> = {};
      for (const [profile, diffs] of Object.entries(nested)) {
        if (isDiffArray(diffs)) out[profile] = diffs;
      }
      if (Object.keys(out).length > 0) return out;
    }
  }
  const out: Record<string, SettingDiff[]> = {};
  for (const [key, value] of Object.entries(root)) {
    if (isDiffArray(value)) out[key] = value;
  }
  return out;
}

// ---------- /api/environment/perf ----------

export function readPerfRows(raw: unknown): PerfMapRow[] {
  const list = arr(raw) ?? arr(rec(raw)?.["maps"]) ?? arr(rec(raw)?.["rows"]) ?? [];
  const out: PerfMapRow[] = [];
  for (const row of list) {
    const r = rec(row);
    if (!r) continue;
    const entry: PerfMapRow = { map: str(r["map"]) ?? null };
    const n = num(r["n"]) ?? num(r["samples"]);
    if (n !== undefined) entry.n = n;
    for (const key of ["fps_avg", "fps_p1", "frametime_p50", "frametime_p95", "frametime_p99"] as const) {
      const v = num(r[key]);
      if (v !== undefined) entry[key] = v;
    }
    const frametimes = arr(pick(r, "frametimes", "frametimeSamples"));
    if (frametimes) {
      const samples = frametimes.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
      if (samples.length > 0) entry.frametimes = samples;
    }
    const regression = rec(r["regression"]);
    if (regression && typeof regression["regressed"] === "boolean") {
      entry.regression = {
        regressed: regression["regressed"],
        reasons: (arr(regression["reasons"]) ?? []).filter((x): x is string => typeof x === "string"),
      };
      entry.regressed = regression["regressed"];
    } else if (typeof r["regressed"] === "boolean") {
      entry.regressed = r["regressed"];
    }
    out.push(entry);
  }
  return out;
}

// ---------- telemetry (GET /api/telemetry/*, WS telemetry.sample) ----------

/** Coerce a timestamp that may arrive as epoch-ms, epoch-sec, or ISO string. */
function readTs(v: unknown): number {
  const n = num(v);
  if (n !== undefined) {
    // heuristic: values below ~10^12 that still look like seconds get scaled up
    return n < 1e12 && n > 1e9 ? n * 1000 : n;
  }
  const s = str(v);
  if (s !== undefined) {
    const parsed = Date.parse(s);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

/** One telemetry sample. Null when the system block is unusable. GPU is optional. */
export function readTelemetrySample(raw: unknown): TelemetrySample | null {
  const r = rec(raw);
  if (!r) return null;
  const sys = rec(pick(r, "system", "sys")) ?? r;
  const cpuPct = num(pick(sys, "cpuPct", "cpu", "cpuUsage"));
  if (cpuPct === undefined) return null;
  const sample: TelemetrySample = {
    ts: readTs(pick(r, "ts", "time", "timestamp")),
    system: {
      cpuPct,
      memUsedMiB: num(pick(sys, "memUsedMiB", "memUsed")) ?? 0,
      memTotalMiB: num(pick(sys, "memTotalMiB", "memTotal")) ?? 0,
    },
  };
  const g = rec(pick(r, "gpu"));
  const utilPct = num(pick(g ?? {}, "utilPct", "util", "gpuUtil"));
  if (g && utilPct !== undefined) {
    sample.gpu = {
      utilPct,
      memUsedMiB: num(pick(g, "memUsedMiB", "memUsed")) ?? 0,
      memTotalMiB: num(pick(g, "memTotalMiB", "memTotal")) ?? 0,
      coreClockMhz: num(pick(g, "coreClockMhz", "coreClock", "clockMhz")) ?? 0,
      tempC: num(pick(g, "tempC", "temp", "temperature")) ?? 0,
      powerW: num(pick(g, "powerW", "power")) ?? 0,
    };
  }
  return sample;
}

export interface NormalizedTelemetryHistory {
  samples: TelemetrySample[];
  intervalMs: number;
}

/** Accepts `{ samples, intervalMs }` or a bare array of samples. */
export function readTelemetryHistory(raw: unknown): NormalizedTelemetryHistory {
  const root = rec(raw);
  const list = arr(raw) ?? arr(root?.["samples"]) ?? [];
  const samples: TelemetrySample[] = [];
  for (const row of list) {
    const s = readTelemetrySample(row);
    if (s) samples.push(s);
  }
  samples.sort((a, b) => a.ts - b.ts);
  return { samples, intervalMs: num(root?.["intervalMs"]) ?? 1000 };
}

// ---------- /api/insights/raids ----------

export interface NormalizedInsightsRaids {
  byMap: SurvivalByMapRow[];
  byHour: { rows: SurvivalByHourRow[]; excluded: number };
  byDuration: { rows: SurvivalByDurationRow[]; excluded: number };
  queueByMap: ({ map: string } & QueueStat)[];
  rhythm: SessionRhythm | null;
}

export function readInsightsRaids(raw: unknown): NormalizedInsightsRaids {
  const root = rec(raw) ?? {};
  const byMap = (arr(pick(root, "survivalByMap", "byMap")) ?? []) as SurvivalByMapRow[];

  const hourRaw = pick(root, "survivalByHour", "byHour");
  const hourRec = rec(hourRaw);
  const byHour = {
    rows: ((arr(hourRaw) ?? arr(hourRec?.["rows"])) ?? []) as SurvivalByHourRow[],
    excluded: num(hourRec?.["excluded"]) ?? 0,
  };

  const durRaw = pick(root, "survivalByDuration", "byDuration");
  const durRec = rec(durRaw);
  const byDuration = {
    rows: ((arr(durRaw) ?? arr(durRec?.["rows"])) ?? []) as SurvivalByDurationRow[],
    excluded: num(durRec?.["excluded"]) ?? 0,
  };

  const queueRaw = pick(root, "queuePatterns", "queues", "queue");
  const queueRec = rec(queueRaw);
  const queueByMap = ((arr(queueRec?.["byMap"]) ?? arr(queueRaw)) ?? []) as ({ map: string } & QueueStat)[];

  const rhythmRec = rec(pick(root, "sessionRhythm", "rhythm", "sessions"));
  const rhythm =
    rhythmRec && Array.isArray(rhythmRec["sessions"]) && rec(rhythmRec["summary"])
      ? (rhythmRec as unknown as SessionRhythm)
      : null;

  return { byMap, byHour, byDuration, queueByMap, rhythm };
}

// ---------- /api/insights/economy ----------

export interface NormalizedEconomy {
  income: FleaIncome | null;
  netWorth: NetWorthEstimate | null;
}

export function readInsightsEconomy(raw: unknown): NormalizedEconomy {
  const root = rec(raw) ?? {};
  const incomeRec = rec(pick(root, "income", "fleaIncome"));
  const income =
    incomeRec && Array.isArray(incomeRec["points"]) ? (incomeRec as unknown as FleaIncome) : null;
  const netRec = rec(pick(root, "netWorth", "netWorthEstimate"));
  const netWorth =
    netRec && Array.isArray(netRec["points"]) ? (netRec as unknown as NetWorthEstimate) : null;
  return { income, netWorth };
}

// ---------- /api/insights/networth (M7.4) ----------

export interface NormalizedNetWorthGoal {
  series: { day: string; estimatedNetWorth: number }[];
  currentEstimate: number;
  netWorth: NetWorthEstimate | null;
  goal: GoalProjection | null;
  lowConfidence: boolean;
}

export function readNetWorthGoal(raw: unknown): NormalizedNetWorthGoal {
  const root = rec(raw) ?? {};
  const seriesRaw = arr(pick(root, "series")) ?? [];
  const series: { day: string; estimatedNetWorth: number }[] = [];
  for (const row of seriesRaw) {
    const r = rec(row);
    if (!r) continue;
    const day = str(r["day"]);
    const value = num(r["estimatedNetWorth"]) ?? num(r["fleaCumulative"]);
    if (day !== undefined && value !== undefined) series.push({ day, estimatedNetWorth: value });
  }
  const netRec = rec(pick(root, "netWorth"));
  const netWorth = netRec && Array.isArray(netRec["points"]) ? (netRec as unknown as NetWorthEstimate) : null;
  const goalRec = rec(pick(root, "goal"));
  const goal =
    goalRec && typeof goalRec["kind"] === "string" ? (goalRec as unknown as GoalProjection) : null;
  return {
    series,
    currentEstimate: num(pick(root, "currentEstimate")) ?? 0,
    netWorth,
    goal,
    lowConfidence: root["lowConfidence"] === true,
  };
}

// ---------- /api/insights/attribution (M6.3) ----------

export function readAttribution(raw: unknown): AttributionReport {
  const root = rec(raw) ?? {};
  const findings: AttributionFinding[] = [];
  for (const row of arr(pick(root, "findings")) ?? []) {
    const r = rec(row);
    const metric = str(r?.["metric"]);
    const label = str(r?.["label"]);
    if (!r || (metric !== "survival" && metric !== "fps") || label === undefined) continue;
    findings.push(r as unknown as AttributionFinding);
  }
  const changesRaw = arr(pick(root, "changes")) ?? [];
  const countsRec = rec(pick(root, "counts")) ?? {};
  return {
    changes: changesRaw.filter((c): c is AttributionReport["changes"][number] => rec(c) !== null) as AttributionReport["changes"],
    findings,
    counts: {
      readings: num(countsRec["readings"]) ?? 0,
      withHash: num(countsRec["withHash"]) ?? 0,
      raids: num(countsRec["raids"]) ?? 0,
      perfSamples: num(countsRec["perfSamples"]) ?? 0,
    },
    lowConfidence: root["lowConfidence"] === true,
    note: str(pick(root, "note")) ?? "",
  };
}

// ---------- /api/insights/highlights (M7.5) ----------

function readMarker(raw: unknown): HighlightMarker | null {
  const r = rec(raw);
  const kind = str(r?.["kind"]);
  const tOffsetSec = num(r?.["tOffsetSec"]);
  const label = str(r?.["label"]);
  if (!r || kind === undefined || tOffsetSec === undefined || label === undefined) return null;
  return { kind: kind as HighlightMarker["kind"], tOffsetSec, label, clock: str(r["clock"]) ?? "" };
}

export function readRaidHighlights(raw: unknown): RaidHighlights | null {
  const r = rec(raw);
  const raidId = num(r?.["raidId"]);
  if (!r || raidId === undefined) return null;
  const markers: HighlightMarker[] = [];
  for (const m of arr(r["markers"]) ?? []) {
    const marker = readMarker(m);
    if (marker) markers.push(marker);
  }
  const outcomeRaw = str(r["outcome"]);
  const outcome =
    outcomeRaw === "survived" || outcomeRaw === "died" ? outcomeRaw : "unknown";
  return {
    raidId,
    sid: str(r["sid"]) ?? null,
    map: str(r["map"]) ?? null,
    startedAt: str(r["startedAt"]) ?? "",
    endedAt: str(r["endedAt"]) ?? null,
    durationSec: num(r["durationSec"]) ?? null,
    outcome,
    markers,
  };
}

/** Accepts `{ raids: [...] }`, a bare array, or `{ raid }` (single). */
export function readHighlights(raw: unknown): RaidHighlights[] {
  const root = rec(raw);
  const single = root ? readRaidHighlights(root["raid"]) : null;
  if (single) return [single];
  const list = arr(raw) ?? arr(root?.["raids"]) ?? [];
  const out: RaidHighlights[] = [];
  for (const row of list) {
    const h = readRaidHighlights(row);
    if (h) out.push(h);
  }
  return out;
}

// ---------- /api/sources/status (§5.7) ----------

function readQuota(raw: unknown): SourceQuota | undefined {
  const q = rec(raw);
  if (!q) return undefined;
  const quota: SourceQuota = {};
  const reads = num(q["readsRemaining"]);
  if (reads !== undefined) quota.readsRemaining = reads;
  const writes = num(q["writesRemaining"]);
  if (writes !== undefined) quota.writesRemaining = writes;
  const resetsAt = str(q["resetsAt"]);
  if (resetsAt !== undefined) quota.resetsAt = resetsAt;
  return Object.keys(quota).length > 0 ? quota : undefined;
}

/** One status row (also used for the live WS `source.status` frame). Null when unusable. */
export function readSourceStatusRow(raw: unknown): SourceStatusRow | null {
  const r = rec(raw);
  const id = str(r?.["id"]);
  if (!r || !id) return null;
  const entry: SourceStatusRow = { id, up: r["up"] === true };
  const apiVersion = str(r["apiVersion"]);
  if (apiVersion !== undefined) entry.apiVersion = apiVersion;
  const lastFetch = str(r["lastFetch"]);
  if (lastFetch !== undefined) entry.lastFetch = lastFetch;
  const cacheAgeSec = num(r["cacheAgeSec"]);
  if (cacheAgeSec !== undefined) entry.cacheAgeSec = cacheAgeSec;
  const lastError = str(r["lastError"]);
  if (lastError !== undefined) entry.lastError = lastError;
  const quota = readQuota(r["quota"]);
  if (quota !== undefined) entry.quota = quota;
  return entry;
}

/** Accepts a bare array or `{ sources: [...] }`; drops rows without an id. */
export function readSourceStatuses(raw: unknown): SourceStatusRow[] {
  const list = arr(raw) ?? arr(rec(raw)?.["sources"]) ?? [];
  const out: SourceStatusRow[] = [];
  for (const row of list) {
    const entry = readSourceStatusRow(row);
    if (entry) out.push(entry);
  }
  return out;
}

// ---------- /api/connectors (§5.6) ----------

function readHealth(raw: unknown): ConnectorHealth {
  return raw === "connected" || raw === "stale" || raw === "missing" ? raw : "error";
}

/** Accepts a bare array or `{ connectors: [...] }`; drops rows without an id. */
export function readConnectors(raw: unknown): ConnectorInfo[] {
  const list = arr(raw) ?? arr(rec(raw)?.["connectors"]) ?? [];
  const out: ConnectorInfo[] = [];
  for (const row of list) {
    const r = rec(row);
    const id = str(r?.["id"]);
    if (!r || !id) continue;
    const capabilities = (arr(r["capabilities"]) ?? []).filter((x): x is string => typeof x === "string");
    out.push({
      id,
      vendor: str(r["vendor"]) ?? "",
      capabilities,
      riskTier: str(r["riskTier"]) ?? "",
      health: readHealth(r["health"]),
    });
  }
  return out;
}
