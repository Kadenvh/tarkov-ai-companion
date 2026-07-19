// @tac/connectors — M9 Connectors (see docs/spec/SPEC-8.md, CONTRACTS §1/§5.4/§9).
// Capability-first, account-safe (T0/T1 only), provenance-tagged reads. This
// slice ships M9.1 (registry + interface), M9.2 (EFT game-config), M9.3
// (Wootility keyboard-actuation), and M9.4 (manual-capture fallback). It also
// ships M9.5 opt-in reversible writes for the game-config capability only (EFT
// Settings, backup-first, game-closed-only). NVIDIA DRS and Sonar writes remain
// deferred; the out-of-tree plugin loader (M9.6) is not implemented yet.
export { CAPABILITIES, isCapability, type Capability } from "./capabilities.js";
export {
  systemClock,
  makeReading,
  hashData,
  type RiskTier,
  type HealthStatus,
  type DetectResult,
  type ConnectorReading,
  type WriteResult,
  type Connector,
  type Clock,
} from "./connector.js";
export {
  ConnectorRegistry,
  RiskTierRejectedError,
  type ResolveOptions,
} from "./registry.js";
export {
  createEftConfigConnector,
  eftConfigConnector,
  WritesDisabledError,
  type EftConfigConnectorOptions,
  type GameConfigConnector,
  type GameConfigWriteResult,
} from "./connectors/eft-config.js";
// Re-exported for callers of the game-config write/revert path (M9.5):
// `write` takes a RecommendationProfile patch; `revert` returns a BackupManifest.
export { GameRunningError, type BackupManifest, type RecommendationProfile } from "@tac/environment";
export {
  createWootilityConnector,
  wootilityConnector,
  defaultWootilityConfigDir,
  WootilityProfile,
  WootilityKeyOverride,
  type WootilityConnectorOptions,
} from "./connectors/wootility.js";
export {
  createManualCaptureConnector,
  manualCaptureConnector,
  type ManualCaptureConnectorOptions,
  type ManualCaptureData,
  type ManualCapturePrompt,
  type ManualCapturePayload,
  type ManualCaptureInputMode,
} from "./connectors/manual-capture.js";
export {
  createNvidiaConnector,
  nvidiaConnector,
  defaultDrsStorePath,
  parseTelemetryCsv,
  NVIDIA_TELEMETRY_QUERY,
  type NvidiaConnectorOptions,
  type NvidiaTelemetry,
  type NvidiaPerfTelemetry,
  type NvidiaGpu3dProfile,
} from "./connectors/nvidia.js";
export {
  createSteelSeriesSonarConnector,
  steelSeriesSonarConnector,
  defaultSonarConfigPath,
  SonarConfig,
  SonarChannel,
  SonarEqBand,
  type SteelSeriesSonarConnectorOptions,
} from "./connectors/steelseries-sonar.js";
