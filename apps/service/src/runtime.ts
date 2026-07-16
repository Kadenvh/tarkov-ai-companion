import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GameMode } from "@tac/shared";
import {
  loadWorld,
  loadMarket,
  parseStoryDataset,
  detectGameVersion,
  STORY_DIR,
  type LoadedWorld,
  type Market,
  type StoryDataset,
} from "@tac/data-core";
import {
  openProfile,
  LogWatcher,
  ScreenshotWatcher,
  TarkovTrackerMirror,
  findLogsDir,
  detectInstallDir,
  type ProfileStore,
  type TrackerMirrorStatus,
} from "@tac/state-engine";
import { isEftRunning, type NvidiaSmiRunner } from "@tac/environment";
import type { ConnectorRegistry } from "@tac/connectors";
import type { SourceRegistry } from "@tac/sources";
import { loadConfig, saveConfig, resolveAgentUrl, type ProfileEntry, type ServiceConfig } from "./config.js";
import { Metrics } from "./metrics.js";
import { WsHub } from "./ws.js";
import { PlanPipeline } from "./plan.js";
import { buildConnectorRegistry, buildSourceRegistry, type SourceQuotaSeed } from "./registries.js";

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
  /** M10 remote-source registry (tarkov.dev JSON / TarkovTracker progress-read). */
  readonly sources: SourceRegistry;
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
  private unbindPatch: (() => void) | null = null;
  private mirror: TarkovTrackerMirror | null = null;

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
    this.bindPatchSentinel();
    this.restartMirror();
    if (this.watch) this.startWatchers();
  }

  /**
   * (Re)start the TarkovTracker mirror (M2.7) from the configured token.
   * Local quest completions/failures push to .org debounced+batched; no token
   * → mirror stays off. Called at boot, after token import, on profile switch.
   */
  restartMirror(): void {
    this.mirror?.stop();
    this.mirror = null;
    const token = this.config.tarkovTrackerToken;
    if (!token) return;
    this.mirror = new TarkovTrackerMirror(this.store, { token, fetchImpl: this.fetchImpl });
    this.mirror.attach();
  }

  /** Mirror status for /api/health (null = no token configured). */
  mirrorStatus(): TrackerMirrorStatus | null {
    return this.mirror?.status ?? null;
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
      const file = join(STORY_DIR, "story.json");
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
    saveConfig(this.config, this.dataDir);
    if (wasWatching || this.watch) this.startWatchers();
    this.hub.broadcast("notice", { title: "Profile switched", body: `Active profile is now ${entry.label}` });
    return entry;
  }

  async close(): Promise<void> {
    await this.stopWatchers();
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
