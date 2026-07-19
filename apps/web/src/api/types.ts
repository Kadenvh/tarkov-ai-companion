/**
 * Local API types for @tac/web — defined from docs/spec/CONTRACTS.md (§3 events,
 * §5 REST/WS, §7 quartermaster) plus the documented service extensions
 * (GET /api/insights/fingerprint, POST /api/state/backfill, GET /api/metrics).
 *
 * The web app builds standalone: it never imports workspace packages. Where the
 * service response shape is not pinned by CONTRACTS (e.g. /api/state dump), the
 * types here are deliberately tolerant and normalized in src/lib/normalize.ts.
 */

// ---------- §5.1 core ----------

export interface HealthResponse {
  ok: boolean;
  version: string;
  snapshotVersion: string;
  profileKey: string;
  gameMode: string;
  gameVersion?: string | null;
  patchDetected?: boolean;
  /** M2.7 TarkovTracker mirror status; null/absent = no token configured */
  trackerSync?: {
    enabled: boolean;
    disabledReason: string | null;
    queued: number;
    backoffUntil: number | null;
    lastError: string | null;
  } | null;
}

export interface ProfilesResponse {
  profiles?: { profileKey: string; gameMode?: string }[] | string[];
  active?: string;
  profileKey?: string;
}

/** Tolerant /api/state dump — normalized via readPlayerState(). */
export type StateResponse = Record<string, unknown>;

export interface ManualStateBody {
  level?: number;
  faction?: "USEC" | "BEAR";
  prestige?: number;
  hideout?: Record<string, number>;
  traders?: Record<string, { level?: number; rep?: number }>;
  tasks?: Record<string, { complete?: boolean; failed?: boolean }>;
}

/** state-engine BackfillResult (packages/state-engine/src/backfill.ts). */
export interface BackfillResult {
  sessionsScanned: number;
  sessionsReplayed: number;
  sessionsSkipped: number;
  questEventsApplied: number;
  raidsRecorded: number;
  fleaSalesRecorded: number;
  breakpoints?: { profileId: string | null; version: string | null; session: string }[];
}

// ---------- §5.2 planning ----------

export type Goal =
  | { type: "kappa" }
  | { type: "lightkeeper" }
  | { type: "level"; level: number }
  | { type: "tasks"; ids: string[] };

export interface PlannerWeights {
  task: number;
  xp: number;
  criticality: number;
  /** map id OR normalizedName -> cost multiplier (>1 aversion, <1 preference) */
  mapCost: Record<string, number>;
}

export interface GoalsResponse {
  goals: Goal[];
  weights?: PlannerWeights;
}

export interface PlannedRaidTask {
  id: string;
  name: string;
  anyMap: boolean;
  reasons: string[];
}

/** planner ExclusivityWarning / story-decision warning, attached per raid. */
export interface ForesightWarning {
  kind: string;
  completing?: { id: string; name: string };
  fails?: { id: string; name: string; kappaRequired?: boolean; lightkeeperRequired?: boolean }[];
  severity?: "info" | "warning" | "critical";
  /** free-form consequence text (story decisions) */
  consequence?: string;
  message?: string;
}

export interface PlannedRaid {
  index: number;
  /** map id, or "any" for a filler-only raid */
  map: string;
  tasks: PlannedRaidTask[];
  levelBefore: number;
  levelAfter: number;
  score: number;
  /** foresight warnings attached per raid (CONTRACTS §5.2) */
  warnings?: ForesightWarning[];
}

export interface Plan {
  raids: PlannedRaid[];
  freeTasksCompleted: { id: string; name: string }[];
  goalTaskCount: number;
  remainingGoalTasks: number;
  levelStalls: { taskId: string; name: string; requiredLevel: number }[];
  reachedLevel: number;
}

export interface PlanResponse extends Plan {
  /** plan hash (CONTRACTS §5.2) */
  hash?: string;
  generatedAt?: string;
  /** map id → display name for every planned raid (CONTRACTS §5.2) */
  mapNames?: Record<string, string>;
  /** alternative attachment point some services use: warnings beside the plan */
  warnings?: ForesightWarning[] | Record<string, ForesightWarning[]>;
}

export type ForesightResponse = ForesightWarning[] | { warnings: ForesightWarning[] };

// ---------- §7 quartermaster ----------

export type RouteKind = "flea" | "trader" | "barter" | "craft" | "find-in-raid";

export interface AcquisitionRoute {
  kind: RouteKind;
  detail: string;
  unitCost?: number;
  totalCost?: number;
  levelGate?: number;
  traderGate?: string;
  craftStation?: string;
  craftMinutes?: number;
  /** find-in-raid: which planned raid (1-based) */
  raidIndex?: number;
}

export interface AcquisitionItem {
  itemId: string;
  name: string;
  count: number;
  fir: boolean;
  forTasks: { id: string; name: string }[];
  route: AcquisitionRoute;
  alternatives: AcquisitionRoute[];
  reasons: string[];
}

export interface AcquisitionPlan {
  raids: number;
  items: AcquisitionItem[];
  totalRubles: number;
  craftSchedule: { itemId: string; station: string; startBy: string; minutes: number }[];
}

// ---------- story (/api/story) ----------

export interface StoryStageCondition {
  decision: string;
  option: string;
}

export interface StoryStage {
  id: string;
  name: string;
  hint?: string;
  maps?: string[];
  optional?: boolean;
  /** present when this stage IS a decision point */
  decision?: string;
  /** present when this stage only exists under a prior decision branch */
  condition?: StoryStageCondition;
}

export interface StoryChapter {
  id: string;
  name: string;
  wikiPage: string;
  order: number;
  addedIn?: string;
  stages: StoryStage[];
}

export interface StoryDecisionOption {
  id: string;
  label: string;
  effects: { locksEndings?: string[]; setsOnlyEnding?: string; notes?: string };
}

export interface StoryDecision {
  id: string;
  chapter: string;
  question: string;
  options: StoryDecisionOption[];
  confidence?: "seed" | "verified";
}

export interface StoryEnding {
  id: string;
  name: string;
  subtitle: string;
  description: string;
}

export interface StoryResponse {
  schemaVersion?: number;
  gameVersion?: string;
  attribution?: string;
  chapters: StoryChapter[];
  decisions: StoryDecision[];
  endings: StoryEnding[];
  /** per-chapter player status when the service provides it (merged with local) */
  playerStatus?: {
    stages?: Record<string, boolean>;
    decisions?: Record<string, string>;
  };
}

// ---------- graph summary ----------

/** Tolerant — normalized via readGraphSummary(). */
export type GraphSummaryResponse = Record<string, unknown>;

// ---------- §5.4 environment & insights ----------

export type SettingValue = string | number | boolean;

export interface SettingDiff {
  key: string;
  current?: SettingValue | undefined;
  recommended: SettingValue;
  why: string;
}

/** Tolerant — normalized via readSettingsDiffs(). */
export type EnvironmentSettingsResponse = Record<string, unknown>;

export interface ApplyResultResponse {
  backupId?: string | null;
  applied?: SettingDiff[];
  error?: string;
}

export interface NvidiaReportResponse {
  gpu: { name: string; driverVersion: string; vramMiB: number } | null;
  recommendations: {
    surface: "in-game" | "driver";
    setting: string;
    recommended: string;
    why: string;
  }[];
}

export interface PerfMapRow {
  map: string | null;
  n?: number;
  fps_avg?: number | null;
  fps_p1?: number | null;
  frametime_p50?: number | null;
  frametime_p95?: number | null;
  frametime_p99?: number | null;
  regressed?: boolean;
  regression?: { regressed: boolean; reasons: string[] };
}

export type PerfResponse = PerfMapRow[] | { maps?: PerfMapRow[]; rows?: PerfMapRow[] };

export interface AmmoEntry {
  id: string;
  name: string;
  shortName: string;
  caliber: string;
  penetration: number;
  damage: number;
  projectileCount: number;
  totalDamage: number;
  fragmentationChance: number;
  initialSpeedMps: number;
  tracer: boolean;
  fleaBanned: boolean;
  tier: "S" | "A" | "B" | "C" | "D" | "E" | "F";
}

export type AmmoResponse = AmmoEntry[] | { table?: AmmoEntry[]; ammo?: AmmoEntry[] };

// insights (@tac/insights output shapes, CONTRACTS §5.4)

export interface SurvivalStat {
  n: number;
  survived: number;
  died: number;
  unknown: number;
  survivalRate: number | null;
  lowConfidence: boolean;
}

export interface SurvivalByMapRow extends SurvivalStat {
  map: string;
}
export interface SurvivalByHourRow extends SurvivalStat {
  hour: number;
}
export interface SurvivalByDurationRow extends SurvivalStat {
  bucket: string;
}

export interface QueueStat {
  n: number;
  avgSec: number | null;
  medianSec: number | null;
  lowConfidence: boolean;
}

export interface RaidSession {
  index: number;
  startTs: string;
  endTs: string;
  startHour: number | null;
  raidCount: number;
  lengthMin: number;
  survived: number;
  died: number;
  unknown: number;
  survivalRate: number | null;
  maps?: string[];
}

export interface SessionRhythm {
  sessions: RaidSession[];
  summary: {
    sessionCount: number;
    totalRaids: number;
    gapMinutes: number;
    raidsPerSession: { mean: number | null; median: number | null };
    sessionLengthMin: { mean: number | null; median: number | null };
    best: { index: number; startTs: string; survivalRate: number } | null;
    worst: { index: number; startTs: string; survivalRate: number } | null;
    n: number;
    lowConfidence: boolean;
  };
}

/** Tolerant — normalized via readInsightsRaids(). */
export type InsightsRaidsResponse = Record<string, unknown>;

export interface IncomePoint {
  period: string;
  total: number;
  count: number;
  cumulative: number;
}

export interface FleaIncome {
  bucket: "daily" | "weekly";
  points: IncomePoint[];
  totalIncome: number;
  n: number;
  lowConfidence: boolean;
  excluded: number;
}

export interface NetWorthEstimate {
  isEstimate: true;
  method: string;
  caveats: string[];
  points: { day: string; fleaCumulative: number; estimatedNetWorth: number }[];
  n: number;
  lowConfidence: boolean;
}

/** Tolerant — normalized via readInsightsEconomy(). */
export type InsightsEconomyResponse = Record<string, unknown>;

export interface FingerprintResponse {
  features: Record<string, number>;
  explanations: Record<string, string>;
  sampleSizes: { raids: number; decidedRaids: number; questEvents: number; sessions: number };
  lowConfidence: boolean;
}

// ---------- §5.6 connectors & §5.7 sources ----------

export type ConnectorHealth = "connected" | "stale" | "missing" | "error";

/** GET /api/connectors row (registry.list + healthAll). */
export interface ConnectorInfo {
  id: string;
  vendor: string;
  capabilities: string[];
  riskTier: string;
  health: ConnectorHealth;
}

/** Read/write budget remaining for a quota-metered source (TarkovTracker). */
export interface SourceQuota {
  readsRemaining?: number;
  writesRemaining?: number;
  resetsAt?: string;
}

/** GET /api/sources/status row (the M10.3 status-view data). */
export interface SourceStatusRow {
  id: string;
  up: boolean;
  apiVersion?: string;
  lastFetch?: string;
  cacheAgeSec?: number;
  quota?: SourceQuota;
  lastError?: string;
}

/** GET /api/sources row (registry.list). */
export interface SourceInfo {
  id: string;
  kind: string;
  baseUrl: string;
  capabilities: string[];
}

/** Tolerant — normalized via readConnectors(). */
export type ConnectorsResponse = ConnectorInfo[] | { connectors?: ConnectorInfo[] };
/** Tolerant — normalized via readSourceStatuses(). */
export type SourceStatusResponse = SourceStatusRow[] | { sources?: SourceStatusRow[] };

// ---------- §3 / §5.3 WS events ----------

export interface WsFrame {
  type: string;
  payload?: unknown;
  ts?: string;
}

export interface RaidEventPayload {
  sid?: string;
  map?: string;
  mode?: string;
  ts?: string;
  durationSec?: number;
  outcome?: "survived" | "died" | "unknown";
}

export interface PositionPayload {
  map?: string | null;
  x: number;
  y: number;
  z: number;
  filename?: string;
  ts: string;
}

export interface QuestChangedPayload {
  taskId: string;
  status: "started" | "completed" | "failed";
  ts: string;
}

export interface NoticePayload {
  message?: string;
  text?: string;
  title?: string;
  level?: "info" | "warning" | "error";
}
