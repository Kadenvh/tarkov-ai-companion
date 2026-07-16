import {
  ConnectorRegistry,
  eftConfigConnector,
  wootilityConnector,
  manualCaptureConnector,
  nvidiaConnector,
  steelSeriesSonarConnector,
} from "@tac/connectors";
import {
  SourceRegistry,
  QuotaLedger,
  createTarkovDevJsonSource,
  createTarkovTrackerSource,
  createEftWikiSource,
  createTarkovDevManagerSource,
  type FetchLike,
} from "@tac/sources";

/**
 * Registry construction (M9 connectors + M10 sources → live in the service).
 *
 * Connectors: the five account-safe adapters (EFT game-config, Wootility
 * keyboard-actuation, manual-capture fallback, NVIDIA gpu-3d-profile/perf-
 * telemetry, SteelSeries Sonar audio-mix). The registry itself refuses anything
 * above T1, so these are all it will accept. All read-only here — the EFT
 * game-config connector's write path stays gated (enableWrites default off).
 *
 * Sources: the tarkov.dev JSON feed (public game-data/prices), TarkovTracker
 * (the user's own progress-read), the EFT-wiki `story` source (read-only
 * MediaWiki — the one source with a real UA that gets past Fandom's bot-block),
 * and the tarkov.dev-manager `submit` source. TarkovTracker is ALWAYS registered
 * — when no token is configured it is constructed with an empty token, so its
 * `health()` reports `missing` (surfaced as unconfigured/`up:false` in the status
 * view) rather than crashing or blocking startup.
 *
 * The manager submit source is registered but LEFT DISABLED (opt-in, off by
 * default per SPEC-10 M10.4): it appears in `/api/sources` and the status view,
 * but `submit()` throws until explicitly enabled and NO submit route is exposed —
 * this pass performs no writes. `fetchImpl` is injectable so tests drive the
 * sources from fixtures and never touch the network.
 */

export function buildConnectorRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(eftConfigConnector);
  registry.register(wootilityConnector);
  registry.register(manualCaptureConnector);
  registry.register(nvidiaConnector);
  registry.register(steelSeriesSonarConnector);
  return registry;
}

/** A persisted per-source budget to restore across restarts (M10, CONTRACTS §4). */
export interface SourceQuotaSeed {
  readsRemaining?: number;
  writesRemaining?: number;
  resetsAt?: string;
}

export interface SourceRegistryOptions {
  /** TarkovTracker API token (from data/local/config.json). Absent → TT registered but `missing`. */
  token?: string;
  /** Injectable transport (fixtures in tests); defaults to the global fetch inside each source. */
  fetchImpl?: FetchLike;
  /**
   * Persisted `source_quota` rows (keyed by source id) restored on startup so the
   * shared external-API budget (esp. TarkovTracker's 1000/100-per-day, shared with
   * the user's other tools) survives a service restart. Only quota-metered sources
   * (TarkovTracker) consume this; injectable for tests.
   */
  quotaSeeds?: Record<string, SourceQuotaSeed>;
}

export function buildSourceRegistry(opts: SourceRegistryOptions = {}): SourceRegistry {
  const registry = new SourceRegistry();
  registry.register(
    createTarkovDevJsonSource(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  );

  // Restore TarkovTracker's shared read/write budget from the persisted ledger,
  // so a restart doesn't optimistically re-open a budget the user already spent
  // via this tool or TarkovMonitor.
  const ttSeed = opts.quotaSeeds?.["tarkovtracker"];
  let ttQuota: QuotaLedger | undefined;
  if (ttSeed && (ttSeed.readsRemaining !== undefined || ttSeed.writesRemaining !== undefined)) {
    ttQuota = new QuotaLedger();
    ttQuota.seed({
      ...(ttSeed.readsRemaining !== undefined ? { readsRemaining: ttSeed.readsRemaining } : {}),
      ...(ttSeed.writesRemaining !== undefined ? { writesRemaining: ttSeed.writesRemaining } : {}),
    });
  }
  registry.register(
    createTarkovTrackerSource({
      token: opts.token ?? "",
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      ...(ttQuota !== undefined ? { quota: ttQuota } : {}),
    }),
  );
  registry.register(
    createEftWikiSource(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  );
  // Opt-in, OFF by default (SPEC-10 M10.4): registered for visibility/status only,
  // enabled:false → submit() throws, and no submit route is wired in this pass.
  registry.register(
    createTarkovDevManagerSource({
      enabled: false,
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    }),
  );
  return registry;
}
