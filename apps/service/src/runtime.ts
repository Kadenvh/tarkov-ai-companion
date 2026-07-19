import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GameMode } from "@tac/shared";
import {
  loadWorld,
  loadMarket,
  parseStoryDataset,
  detectGameVersion,
  storyDir,
  checkInvariants,
  diffSnapshots,
  snapshotExists,
  type LoadedWorld,
  type Market,
  type StoryDataset,
  type InvariantReport,
  type SnapshotDiff,
} from "@tac/data-core";
import {
  openProfile,
  LogWatcher,
  ScreenshotWatcher,
  TarkovTrackerMirror,
  findLogsDir,
  detectInstallDir,
  type PumpSummary,
  type ProfileStore,
  type TrackerMirrorStatus,
  type TarkovTrackerApplyCounts,
  type TarkovTrackerProgress,
} from "@tac/state-engine";
import { isEftRunning, type NvidiaSmiRunner } from "@tac/environment";
import type { ConnectorRegistry } from "@tac/connectors";
import {
  QuotaExhaustedError,
  HttpError,
  TARKOVTRACKER_PROGRESS_REQUEST,
  type SourceRegistry,
  type QuotaState,
} from "@tac/sources";
import { loadConfig, saveConfig, resolveAgentUrl, type ProfileEntry, type ServiceConfig } from "./config.js";
import { Metrics } from "./metrics.js";
import { WsHub } from "./ws.js";
import { PlanPipeline } from "./plan.js";
import { TrackerSyncScheduler } from "./tracker-sync.js";
import { TelemetryScheduler, TelemetrySampler } from "./telemetry.js";
import { buildConnectorRegistry, buildSourceRegistry, type SourceQuotaSeed } from "./registries.js";

/** Default minutes between scheduled TarkovTracker read syncs (config override wins). */
export const DEFAULT_TRACKER_SYNC_MINUTES = 10;

/**
 * Scheduled syncs skip when the shared read budget is at/under this floor, so
 * the poller never eats into headroom the user's other tools (TarkovMonitor,
 * tarkov.dev, RatScanner) need. An EXPLICIT sync via the route ignores the floor
 * and only stops at a hard 0 (QuotaExhaustedError).
 */
export const TRACKER_SYNC_QUOTA_FLOOR = 50;

/** Outcome of a best-effort TarkovTracker read sync — never a thrown error. */
export interface TarkovTrackerSyncResult {
  ok: boolean;
  applied?: TarkovTrackerApplyCounts;
  changed?: boolean;
  progress?: TarkovTrackerProgress;
  fromCache?: boolean;
  quota?: QuotaState;
  reason?: "no-token" | "no-source" | "quota-low" | "quota-exhausted" | "unauthorized" | "unreachable";
  error?: string;
}

/**
 * M8.2 patch-drift readiness report exposed at `GET /api/patch/status`. When the
 * installed game version differs from the loaded data snapshot, `drift` carries
 * whether a snapshot for the new version exists locally and — if it does — the
 * structural diff. The operator, not the service, decides to pull a new snapshot
 * (that is a network fetch); this only surfaces the readiness state.
 */
export interface PatchStatus {
  snapshotVersion: string;
  detectedVersion?: string;
  drift?: {
    /** is there a committed snapshot on disk for the detected version? */
    snapshotAvailable: boolean;
    /** structural diff snapshot->detected (only when the detected snapshot exists) */
    diff?: SnapshotDiff;
    /** human-readable readiness note */
    note: string;
  };
  invariants: InvariantReport;
  lastChecked: string;
}

/**
 * Fold the persisted `source_quota` rows into the `quotaSeeds` record
 * `buildSourceRegistry` consumes on startup (nulls dropped so absent columns
 * stay unknown rather than seeding `null`).
 */
function sourceQuotaSeeds(store: ProfileStore): Record<string, SourceQuotaSeed> {
  const seeds: Record<string, SourceQuotaSeed> = {};
  for (const row of store.getAllSourceQuota()) {
    const seed: SourceQuotaSeed = {};
    if (row.readsRemaining !== null) seed.readsRemaining = row.readsRemaining;
    if (row.writesRemaining !== null) seed.writesRemaining = row.writesRemaining;
    if (row.resetsAt !== null) seed.resetsAt = row.resetsAt;
    seeds[row.sourceId] = seed;
  }
  return seeds;
}

/**
 * ServiceRuntime — everything the routes share: config, the active
 * ProfileStore, lazily-loaded world/market per game mode, the story dataset,
 * WS hub, plan pipeline, metrics, watchers, and the M8.2 patch sentinel.
 * All environment touchpoints (process check, nvidia-smi, agent fetch, log /
 * screenshot / settings dirs) are injectable for tests.
 */

export interface RuntimeOptions {
  dataDir: string;
  config?: ServiceConfig;
  world?: LoadedWorld;
  market?: Market;
  story?: StoryDataset | null;
  loadWorldFn?: (mode: GameMode) => LoadedWorld;
  loadMarketFn?: (mode: GameMode) => Market;
  isGameRunning?: () => Promise<boolean> | boolean;
  nvidiaRunner?: NvidiaSmiRunner;
  agentUrl?: string;
  fetchImpl?: typeof fetch;
  watch?: boolean;
  memoryDb?: boolean;
  logsDir?: string;
  screenshotsDir?: string;
  settingsDir?: string;
  backupDir?: string;
  planDebounceMs?: number;
  detectGameVersionFn?: () => string | null;
  version?: string;
  /** M9 connectors registry (defaults to the three account-safe adapters). */
  connectors?: ConnectorRegistry;
  /** M10 sources registry (defaults to tarkov.dev-JSON + TarkovTracker). */
  sources?: SourceRegistry;
  /**
   * Override the scheduled TarkovTracker sync period (ms). `0` disables the
   * scheduler entirely (tests drive `syncTarkovTracker()` / the scheduler class
   * directly). Absent → `config.tarkovTrackerSyncMinutes` or the 10-min default.
   */
  trackerSyncIntervalMs?: number;
  /** Run a sync on startup when a token is configured (default true). */
  trackerSyncOnStart?: boolean;
  /** Override the live-telemetry poll period (ms). Absent → 2000. */
  telemetryIntervalMs?: number;
  /** Override the telemetry idle-stop delay (ms). Absent → 30000. */
  telemetryIdleTimeoutMs?: number;
}

export class ServiceRuntime {
  readonly dataDir: string;
  readonly profilesDir: string;
  readonly config: ServiceConfig;
  readonly metrics = new Metrics();
  readonly hub: WsHub;
  readonly planner: PlanPipeline;
  /** M9 capability-first connector registry (EFT config / Wootility / manual-capture). */
  readonly connectors: ConnectorRegistry;
  /**
   * Live system/GPU telemetry poller (Coach observability). Demand-gated: it
   * only samples while a WS client is subscribed or a `/api/telemetry/*` route
   * recently touched it, so nvidia-smi is never spawned in an idle background.
   */
  readonly telemetry: TelemetryScheduler;
  /**
   * M10 remote-source registry (tarkov.dev JSON / TarkovTracker progress-read).
   * Mutable: rebuilt when the TarkovTracker token changes so the read feed uses
   * the fresh token (quota is reseeded from the persisted ledger on rebuild).
   */
  sources: SourceRegistry;
  readonly agentUrl: string;
  readonly fetchImpl: typeof fetch;
  readonly isGameRunning: () => Promise<boolean> | boolean;
  readonly nvidiaRunner: NvidiaSmiRunner | undefined;
  readonly settingsDir: string | undefined;
  readonly backupDir: string;
  readonly version: string;
  readonly watch: boolean;

  store: ProfileStore;
  patchDetected: { version: string; ts: string } | null = null;
  /** Cached M8.2 report, keyed by (snapshot|detected|mode) so `lastChecked` is stable until inputs move. */
  private patchStatusCache: { key: string; status: PatchStatus } | null = null;

  private readonly memoryDb: boolean;
  private readonly loadWorldFn: (mode: GameMode) => LoadedWorld;
  private readonly loadMarketFn: (mode: GameMode) => Market;
  private readonly detectGameVersionFn: () => string | null;
  private readonly worlds = new Map<GameMode, LoadedWorld>();
  private readonly markets = new Map<GameMode, Market>();
  private storyCache: StoryDataset | null | undefined;
  private readonly logsDirOverride: string | undefined;
  private readonly screenshotsDir: string | undefined;
  private logWatcher: LogWatcher | null = null;
  private screenshotWatcher: ScreenshotWatcher | null = null;
  /** lazily-built, NEVER-started watcher used only for on-demand pull sync (Companion-on-Zoe). */
  private pullWatcher: LogWatcher | null = null;
  /** ISO timestamp of the last on-demand sync (for the UI's "last synced" readout). */
  lastSyncAt: string | null = null;
  private unbindPatch: (() => void) | null = null;
  private mirror: TarkovTrackerMirror | null = null;
  private trackerScheduler: TrackerSyncScheduler | null = null;
  private readonly trackerSyncIntervalMs: number;
  private readonly trackerSyncOnStart: boolean;

  constructor(opts: RuntimeOptions) {
    this.dataDir = opts.dataDir;
    this.profilesDir = join(opts.dataDir, "profiles");
    this.config = opts.config ?? loadConfig(opts.dataDir);
    this.memoryDb = opts.memoryDb ?? false;
    this.loadWorldFn = opts.loadWorldFn ?? ((mode) => loadWorld(mode));
    this.loadMarketFn = opts.loadMarketFn ?? ((mode) => loadMarket(mode));
    this.detectGameVersionFn = opts.detectGameVersionFn ?? detectGameVersion;
    this.isGameRunning = opts.isGameRunning ?? isEftRunning;
    this.nvidiaRunner = opts.nvidiaRunner;
    this.agentUrl = opts.agentUrl ?? resolveAgentUrl(this.config);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.settingsDir = opts.settingsDir;
    this.backupDir = opts.backupDir ?? join(opts.dataDir, "backups");
    this.logsDirOverride = opts.logsDir;
    this.screenshotsDir = opts.screenshotsDir;
    this.version = opts.version ?? "0.1.0";
    this.watch = opts.watch ?? false;
    this.trackerSyncIntervalMs =
      opts.trackerSyncIntervalMs ??
      (this.config.tarkovTrackerSyncMinutes ?? DEFAULT_TRACKER_SYNC_MINUTES) * 60_000;
    this.trackerSyncOnStart = opts.trackerSyncOnStart ?? true;
    // Open the profile store before building the source registry: the M10
    // quota restore seeds each source's ledger from the persisted `source_quota`.
    this.store = openProfile(this.config.activeProfile, this.storeOpts());
    this.connectors = opts.connectors ?? buildConnectorRegistry();
    this.sources =
      opts.sources ??
      buildSourceRegistry({
        fetchImpl: this.fetchImpl,
        quotaSeeds: sourceQuotaSeeds(this.store),
        ...(this.config.tarkovTrackerToken !== undefined
          ? { token: this.config.tarkovTrackerToken }
          : {}),
      });
    if (opts.story !== undefined) this.storyCache = opts.story;

    if (opts.world) this.worlds.set(opts.world.mode, opts.world);
    if (opts.market) this.markets.set(opts.market.mode, opts.market);

    this.hub = new WsHub(this.config.activeProfile, this.metrics);
    this.hub.bindStore(this.store);
    this.metrics.attachStore(this.store);
    this.planner = new PlanPipeline(this.world(), this.store, {
      ...(opts.planDebounceMs !== undefined ? { debounceMs: opts.planDebounceMs } : {}),
      onUpdated: (bundle) =>
        this.hub.broadcast("plan.updated", {
          hash: bundle.hash,
          builtAt: bundle.builtAt,
          horizon: bundle.horizon,
          raids: bundle.plan.raids.length,
          remainingGoalTasks: bundle.plan.remainingGoalTasks,
        }),
    });
    this.planner.bind();
    const telemetrySampler = new TelemetrySampler(
      this.nvidiaRunner ? { smiRunner: this.nvidiaRunner } : {},
    );
    this.telemetry = new TelemetryScheduler({
      sample: () => telemetrySampler.sample(),
      onSample: (sample) => this.hub.broadcast("telemetry.sample", sample),
      ...(opts.telemetryIntervalMs !== undefined ? { intervalMs: opts.telemetryIntervalMs } : {}),
      ...(opts.telemetryIdleTimeoutMs !== undefined ? { idleTimeoutMs: opts.telemetryIdleTimeoutMs } : {}),
    });
    this.bindPatchSentinel();
    this.restartMirror();
    this.restartTrackerSync();
    if (this.watch) this.startWatchers();
  }

  /**
   * (Re)start the TarkovTracker mirror (M2.7) from the configured token. No
   * token → mirror stays off. Called at boot, after token import, on profile
   * switch.
   *
   * READ-MOSTLY STANCE (SPEC-8): the outbound WRITE push (local quest
   * completions → `.org`) only attaches when `config.tarkovTrackerWrites` is
   * explicitly enabled. It is OFF by default because Kaden runs TarkovMonitor,
   * which owns the write path — pushing here too would double-spend the shared
   * 100/day write quota (research/02 §4/§6). The mirror is still constructed so
   * `/api/health` can report token/connection status; the read feed is the
   * scheduled sync, not this mirror.
   */
  restartMirror(): void {
    this.mirror?.stop();
    this.mirror = null;
    const token = this.config.tarkovTrackerToken;
    if (!token) return;
    this.mirror = new TarkovTrackerMirror(this.store, { token, fetchImpl: this.fetchImpl });
    if (this.config.tarkovTrackerWrites === true) this.mirror.attach();
  }

  /** Mirror status for /api/health (null = no token configured). */
  mirrorStatus(): TrackerMirrorStatus | null {
    return this.mirror?.status ?? null;
  }

  /**
   * Rebuild the M10 source registry from the CURRENT config token, reseeding the
   * quota ledger from the persisted `source_quota` so a token change doesn't
   * re-open a budget already spent. Called after a token import/change so the
   * read feed authenticates with the new token.
   */
  rebuildSources(): void {
    this.sources = buildSourceRegistry({
      fetchImpl: this.fetchImpl,
      quotaSeeds: sourceQuotaSeeds(this.store),
      ...(this.config.tarkovTrackerToken !== undefined ? { token: this.config.tarkovTrackerToken } : {}),
    });
  }

  /**
   * (Re)start the scheduled TarkovTracker read feed (SPEC-8). Off with no token
   * or a non-positive interval. Each tick runs a best-effort, quota-floored sync
   * through the single sync path; startup fires one immediately (unless
   * disabled). Stoppable + idempotent.
   */
  restartTrackerSync(): void {
    this.trackerScheduler?.stop();
    this.trackerScheduler = null;
    if (!this.config.tarkovTrackerToken || this.trackerSyncIntervalMs <= 0) return;
    this.trackerScheduler = new TrackerSyncScheduler({
      intervalMs: this.trackerSyncIntervalMs,
      syncOnStart: this.trackerSyncOnStart,
      sync: () => this.syncTarkovTracker({ quotaFloor: TRACKER_SYNC_QUOTA_FLOOR }),
    });
    this.trackerScheduler.start();
  }

  /** Whether the scheduled read feed is currently running (for status/tests). */
  trackerSyncRunning(): boolean {
    return this.trackerScheduler?.running ?? false;
  }

  /**
   * The SINGLE sync code path: pull `GET /progress` through the M10
   * `progress-read` source (cache-first, conditional, quota-aware) and apply it
   * to the store via the change-aware mapper. Read-only; NEVER throws — a
   * missing token, quota floor/exhaustion, 401, or an unreachable API all resolve
   * to `{ ok: false, reason }`. Folds the freshly-learned budget into
   * `source_quota` (best-effort) on every attempt.
   *
   * `quotaFloor` (scheduler) refuses proactively when the shared budget is low;
   * omit it (on-demand route) to read unless the budget is a hard 0.
   */
  async syncTarkovTracker(opts: { quotaFloor?: number } = {}): Promise<TarkovTrackerSyncResult> {
    if (!this.config.tarkovTrackerToken) return { ok: false, reason: "no-token" };
    const source = this.sources.get("tarkovtracker");
    if (!source) return { ok: false, reason: "no-source" };

    const quotaBefore = source.quota?.();
    if (
      opts.quotaFloor !== undefined &&
      quotaBefore?.readsRemaining !== undefined &&
      quotaBefore.readsRemaining <= opts.quotaFloor
    ) {
      return { ok: false, reason: "quota-low", ...(quotaBefore !== undefined ? { quota: quotaBefore } : {}) };
    }

    try {
      const reading = await source.fetch<TarkovTrackerProgress>(TARKOVTRACKER_PROGRESS_REQUEST);
      const result = this.store.importTarkovTracker(reading.data);
      const quota = source.quota?.();
      if (quota !== undefined) this.persistSourceQuota("tarkovtracker", quota);
      return {
        ok: true,
        applied: result.applied,
        changed: result.changed,
        progress: result.progress,
        fromCache: reading.fromCache,
        ...(quota !== undefined ? { quota } : {}),
      };
    } catch (err) {
      const quota = source.quota?.();
      if (quota !== undefined) this.persistSourceQuota("tarkovtracker", quota);
      const q = quota !== undefined ? { quota } : {};
      if (err instanceof QuotaExhaustedError) return { ok: false, reason: "quota-exhausted", ...q };
      if (err instanceof HttpError && err.status === 401)
        return { ok: false, reason: "unauthorized", error: err.message, ...q };
      return { ok: false, reason: "unreachable", error: err instanceof Error ? err.message : String(err), ...q };
    }
  }

  /** Fold a source's current budget into `source_quota` (best-effort; never throws). */
  private persistSourceQuota(sourceId: string, quota: QuotaState): void {
    try {
      this.store.upsertSourceQuota(sourceId, {
        ...(quota.readsRemaining !== undefined ? { readsRemaining: quota.readsRemaining } : {}),
        ...(quota.writesRemaining !== undefined ? { writesRemaining: quota.writesRemaining } : {}),
        ...(quota.resetsAt !== undefined ? { resetsAt: quota.resetsAt } : {}),
      });
    } catch {
      // best-effort: a store failure must never fail the read
    }
  }

  private storeOpts(): { dir: string } | { memory: true } {
    return this.memoryDb ? { memory: true } : { dir: this.profilesDir };
  }

  activeProfile(): ProfileEntry {
    return (
      this.config.profiles.find((p) => p.key === this.config.activeProfile) ?? this.config.profiles[0]!
    );
  }

  get gameMode(): GameMode {
    return this.activeProfile().gameMode;
  }

  /** World for the active profile's mode (lazy per mode, cached). */
  world(mode: GameMode = this.gameMode): LoadedWorld {
    let world = this.worlds.get(mode);
    if (!world) {
      world = this.loadWorldFn(mode);
      this.worlds.set(mode, world);
    }
    return world;
  }

  market(mode: GameMode = this.gameMode): Market {
    let market = this.markets.get(mode);
    if (!market) {
      market = this.loadMarketFn(mode);
      this.markets.set(mode, market);
    }
    return market;
  }

  /** Curated story dataset (null when data/story/story.json is absent). */
  story(): StoryDataset | null {
    if (this.storyCache === undefined) {
      const file = join(storyDir(), "story.json");
      this.storyCache = existsSync(file)
        ? parseStoryDataset(JSON.parse(readFileSync(file, "utf8")))
        : null;
    }
    return this.storyCache;
  }

  snapshotVersion(): string {
    return this.world().ref.version;
  }

  /** Installed game version: last patch event wins, else log-folder detection. */
  gameVersion(): string | null {
    return this.patchDetected?.version ?? this.detectGameVersionFn();
  }

  logsDir(): string | null {
    if (this.logsDirOverride) return this.logsDirOverride;
    const install = detectInstallDir();
    return install ? findLogsDir(install) : null;
  }

  // -- watchers (skipped under TAC_NO_WATCH / in tests) -----------------------

  startWatchers(): void {
    if (!this.logWatcher) {
      const logsDir = this.logsDir();
      this.logWatcher = new LogWatcher({
        store: this.store,
        snapshotVersion: this.snapshotVersion(),
        ...(logsDir ? { logsDir } : {}),
      });
      this.logWatcher.start();
    }
    if (!this.screenshotWatcher) {
      this.screenshotWatcher = new ScreenshotWatcher({
        store: this.store,
        currentMap: () => this.logWatcher?.currentMap ?? null,
        ...(this.screenshotsDir ? { dir: this.screenshotsDir } : {}),
      });
      this.screenshotWatcher.start();
    }
  }

  async stopWatchers(): Promise<void> {
    this.logWatcher?.stop();
    this.logWatcher = null;
    await this.screenshotWatcher?.stop();
    this.screenshotWatcher = null;
    this.pullWatcher = null; // rebound to the new store on the next syncOnce()
  }

  /**
   * On-demand log pull (CONTRACTS — two-PC pull model). Drives exactly ONE
   * watcher cycle and returns a summary; no interval, so nothing polls the
   * gaming PC in the background. Reuses the continuous watcher when running
   * (dev / same-PC), else a lazily-built pull-only watcher pointed at the
   * configured logs dir (e.g. hero's Tailscale-shared `Logs`). Cursor-based, so
   * repeated syncs only ingest what's new since the last one.
   */
  syncOnce(): PumpSummary {
    if (this.logWatcher) {
      const summary = this.logWatcher.pumpOnce();
      this.lastSyncAt = new Date().toISOString();
      return summary;
    }
    if (!this.pullWatcher) {
      const logsDir = this.logsDir();
      this.pullWatcher = new LogWatcher({
        store: this.store,
        snapshotVersion: this.snapshotVersion(),
        ...(logsDir ? { logsDir } : {}),
      });
    }
    const summary = this.pullWatcher.pumpOnce();
    this.lastSyncAt = new Date().toISOString();
    return summary;
  }

  // -- patch sentinel (M8.2) ---------------------------------------------------

  private bindPatchSentinel(): void {
    this.unbindPatch?.();
    const listener = (payload: { version: string; ts: string }): void => {
      this.patchDetected = payload;
      this.hub.broadcast("notice", {
        title: "Game patch detected",
        body:
          `EFT ${payload.version} differs from the active data snapshot ` +
          `${this.snapshotVersion()} — run \`pnpm snapshot\` and review the diff before trusting the plan.`,
      });
    };
    this.store.events.on("patch.detected", listener);
    this.unbindPatch = () => this.store.events.off("patch.detected", listener);
  }

  /**
   * M8.2 patch-drift readiness report. Runs the structural invariant checks on
   * the active snapshot and — when the installed game version differs and a
   * snapshot for it exists locally — the snapshot diff. Result is cached by
   * (snapshot|detected|mode) so repeated polls return a stable `lastChecked`
   * until the versions actually move.
   */
  patchStatus(): PatchStatus {
    const snapshotVersion = this.snapshotVersion();
    const detected = this.gameVersion();
    const mode = this.gameMode;
    const key = `${snapshotVersion}|${detected ?? ""}|${mode}`;
    if (this.patchStatusCache?.key === key) return this.patchStatusCache.status;

    const invariants = checkInvariants(this.world(mode));
    const status: PatchStatus = { snapshotVersion, invariants, lastChecked: new Date().toISOString() };

    if (detected && detected !== snapshotVersion) {
      status.detectedVersion = detected;
      const available = snapshotExists(detected);
      if (available) {
        try {
          const diff = diffSnapshots(snapshotVersion, detected, mode);
          status.drift = {
            snapshotAvailable: true,
            diff,
            note:
              `EFT ${detected} differs from the active snapshot ${snapshotVersion}; ` +
              `a snapshot for ${detected} is on disk — review the diff` +
              (diff.invariants.ok ? "." : " (invariants BROKEN on the new snapshot)."),
          };
        } catch (err) {
          status.drift = {
            snapshotAvailable: true,
            note: `snapshot for ${detected} exists but failed to diff: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      } else {
        status.drift = {
          snapshotAvailable: false,
          note:
            `EFT ${detected} differs from the active snapshot ${snapshotVersion}; ` +
            `no snapshot for ${detected} on disk — run \`pnpm snapshot\` to pull one, then re-check.`,
        };
      }
    }

    this.patchStatusCache = { key, status };
    return status;
  }

  // -- profile switching --------------------------------------------------------

  async selectProfile(profileKey: string): Promise<ProfileEntry> {
    const entry = this.config.profiles.find((p) => p.key === profileKey);
    if (!entry) throw new UnknownProfileError(profileKey);
    if (profileKey === this.config.activeProfile) return entry;

    const wasWatching = this.logWatcher !== null || this.screenshotWatcher !== null;
    await this.stopWatchers();
    this.hub.unbindStore();
    this.unbindPatch?.();
    this.unbindPatch = null;
    this.planner.unbindStore();

    const previous = this.store;
    this.config.activeProfile = profileKey;
    this.store = openProfile(profileKey, this.storeOpts());
    this.hub.profileKey = profileKey;
    this.hub.bindStore(this.store);
    this.metrics.attachStore(this.store); // flushes to the previous store first
    previous.close();
    this.planner.retarget(this.world(entry.gameMode), this.store);
    this.bindPatchSentinel();
    this.restartMirror();
    // Reseed the M10 quota ledger from the new profile's persisted budget, then
    // (re)start the read feed against it.
    this.rebuildSources();
    this.restartTrackerSync();
    saveConfig(this.config, this.dataDir);
    if (wasWatching || this.watch) this.startWatchers();
    this.hub.broadcast("notice", { title: "Profile switched", body: `Active profile is now ${entry.label}` });
    return entry;
  }

  async close(): Promise<void> {
    await this.stopWatchers();
    this.telemetry.stop();
    this.trackerScheduler?.stop();
    this.trackerScheduler = null;
    await this.mirror?.flush(); // drain queued tracker writes before shutdown
    this.mirror?.stop();
    this.mirror = null;
    this.planner.stop();
    this.hub.unbindStore();
    this.unbindPatch?.();
    this.unbindPatch = null;
    this.metrics.stop();
    this.store.close();
  }
}

export class UnknownProfileError extends Error {
  constructor(readonly profileKey: string) {
    super(`unknown profile: ${profileKey}`);
    this.name = "UnknownProfileError";
  }
}
