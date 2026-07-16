// @tac/connectors — M9 Connectors (see docs/spec/SPEC-8.md, CONTRACTS §1/§5.4/§9).
// Capability-first, account-safe (T0/T1 only), provenance-tagged reads. This
// slice ships M9.1 (registry + interface), M9.2 (EFT game-config), M9.3
// (Wootility keyboard-actuation), and M9.4 (manual-capture fallback). Writes
// (M9.5) and the out-of-tree plugin loader (M9.6) are not implemented yet.
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
  type EftConfigConnectorOptions,
} from "./connectors/eft-config.js";
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
