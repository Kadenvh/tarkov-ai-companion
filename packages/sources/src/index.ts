// @tac/sources — M10 Sources (see docs/spec/SPEC-10.md, CONTRACTS §1/§3/§5).
// The efficient external-data monitoring layer: one registry + one client
// discipline (cache-first TTL, conditional 304s, quota budgeting, retry/backoff)
// for every remote data feed. Sibling to @tac/connectors (local tools). This
// slice ships M10.1 (registry + cache + quota + retry), M10.2 (tarkov.dev JSON
// game-data/prices + TarkovTracker progress-read, both read-only), and the M10.3
// status shape. M10.4 (wiki/story + submit) is NOT built yet. All read-only,
// network-only — no game process, no writes.
export { SOURCE_CAPABILITIES, isSourceCapability, type SourceCapability } from "./capabilities.js";
export {
  systemClock,
  systemMsClock,
  makeReading,
  hashData,
  type Clock,
  type MsClock,
  type SourceKind,
  type HealthStatus,
  type SourceRequest,
  type SourceReading,
  type QuotaState,
  type SourceStats,
  type Source,
} from "./source.js";
export { TtlCache, type CacheEntry } from "./cache.js";
export {
  QuotaLedger,
  QuotaExhaustedError,
  type QuotaKind,
  type QuotaHeaders,
} from "./quota.js";
export {
  httpGet,
  unwrapData,
  HttpError,
  DEFAULT_USER_AGENT,
  type FetchLike,
  type FetchInit,
  type HttpResponse,
  type ResponseHeadersLike,
  type HttpGetOptions,
  type HttpGetResult,
} from "./http.js";
export { SourceRegistry, DuplicateSourceError, type SourceStatus } from "./registry.js";
export {
  createTarkovDevJsonSource,
  tarkovDevJsonSource,
  PRICES_TTL_MS,
  STATIC_TTL_MS,
  type TarkovDevJsonSourceOptions,
} from "./sources/tarkov-dev-json.js";
export {
  createTarkovTrackerSource,
  TarkovTrackerProgress,
  TaskProgress,
  TaskObjectiveProgress,
  HideoutModuleProgress,
  PROGRESS_TTL_MS,
  TARKOVTRACKER_PROGRESS_REQUEST,
  type TarkovTrackerSourceOptions,
} from "./sources/tarkovtracker.js";
