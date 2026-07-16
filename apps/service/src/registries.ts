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

export interface SourceRegistryOptions {
  /** TarkovTracker API token (from data/local/config.json). Absent → TT registered but `missing`. */
  token?: string;
  /** Injectable transport (fixtures in tests); defaults to the global fetch inside each source. */
  fetchImpl?: FetchLike;
}

export function buildSourceRegistry(opts: SourceRegistryOptions = {}): SourceRegistry {
  const registry = new SourceRegistry();
  registry.register(
    createTarkovDevJsonSource(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  );
  registry.register(
    createTarkovTrackerSource({
      token: opts.token ?? "",
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
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
