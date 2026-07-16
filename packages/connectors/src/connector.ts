/**
 * @tier T0 (types + a pure provenance-stamping helper; no I/O, no process contact).
 *
 * The connector contract (SPEC-8 §"Connector interface"). This is the plugin
 * seam: every adapter — first-party (EFT Settings) or vendor (Wootility) —
 * implements `Connector`. Account-safe by construction: the risk model admits
 * only T0/T1 here, and the registry (registry.ts) rejects anything higher, so
 * no connector may ever touch the game process, memory, input, or packets.
 */
import { createHash } from "node:crypto";
import type { Capability } from "./capabilities.js";

/**
 * Registration ceiling. Connectors read on-disk config, vendor-local files, and
 * OS telemetry — never the game process. T2+ (memory/injection/input) is
 * refused at `ConnectorRegistry.register`.
 */
export type RiskTier = "T0" | "T1";

/** How live a connector's data source is right now. */
export type HealthStatus = "connected" | "stale" | "missing" | "error";

/** Result of a connector probing for its backing tool/config. */
export interface DetectResult {
  installed: boolean;
  configPath?: string;
  version?: string;
}

/**
 * Provenance envelope around every read (SPEC-8 principle 5). `capturedAt`,
 * `gameVersion`, and `settingsHash` are the join keys the M6.3 attribution
 * engine uses to correlate environment ↔ outcome.
 */
export interface ConnectorReading<T = unknown> {
  connectorId: string;
  capability: Capability;
  /** ISO-8601 timestamp (stamped by `makeReading`, injectable clock in tests). */
  capturedAt: string;
  gameVersion?: string;
  /** Stable content hash of the source payload (see `hashData`). */
  settingsHash?: string;
  data: T;
}

/**
 * Result of an opt-in `write`/orchestrate. Defined for the interface so M9.5 can
 * land without a contract change; no connector in this slice implements `write`.
 * Every real write must back up prior state first and expose a `revert`.
 */
export interface WriteResult {
  applied: boolean;
  /** Id of the backup taken before applying (for one-click revert). */
  backupId?: string;
  /** Restores byte-identical prior state. */
  revert?: () => Promise<void>;
}

/** The pluggable adapter contract. Exactly the shape in SPEC-8. */
export interface Connector {
  /** Stable id, e.g. "eft-config", "wootility", "manual-capture". */
  id: string;
  vendor: string;
  /** Capabilities this connector can satisfy. */
  capabilities: Capability[];
  /** Registration ceiling; registry rejects anything outside T0/T1. */
  riskTier: RiskTier;
  /** Installed? config path found? version? */
  detect(): Promise<DetectResult>;
  /** Provenance-tagged read for one of this connector's capabilities. */
  read(cap: Capability): Promise<ConnectorReading>;
  /** Opt-in, reversible write (M9.5). Absent on read-only connectors. */
  write?(cap: Capability, patch: unknown): Promise<WriteResult>;
  /**
   * True only when this connector both implements `write` AND has been
   * constructed with writes explicitly enabled (M9.5 opt-in). The registry
   * checks this flag before dispatching a write; a `write` that is present but
   * gated will throw when called directly. Absent/false ⇒ read-only.
   */
  writesEnabled?: boolean;
  /** Live health of the backing source. */
  health(): Promise<HealthStatus>;
}

/** Clock abstraction so tests can stamp `capturedAt` deterministically. */
export type Clock = () => string;

/** Default wall-clock. */
export const systemClock: Clock = () => new Date().toISOString();

/**
 * Stable content hash of a read payload for the `settingsHash` field. Sorted
 * keys → order-independent; sha256 truncated to 16 hex chars (collision-safe
 * enough for an attribution join key, compact enough for a DB column).
 */
export function hashData(data: unknown): string {
  const json = JSON.stringify(data, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      return Object.keys(obj)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = obj[k];
          return acc;
        }, {});
    }
    return value;
  });
  return createHash("sha256").update(json ?? "null").digest("hex").slice(0, 16);
}

/**
 * Stamp a provenance envelope. `clock` defaults to wall-clock; inject a fixed
 * clock in tests so `capturedAt` is deterministic. Optional fields are omitted
 * (not set to `undefined`) to satisfy `exactOptionalPropertyTypes`.
 */
export function makeReading<T>(
  input: {
    connectorId: string;
    capability: Capability;
    data: T;
    gameVersion?: string;
    settingsHash?: string;
  },
  clock: Clock = systemClock,
): ConnectorReading<T> {
  return {
    connectorId: input.connectorId,
    capability: input.capability,
    capturedAt: clock(),
    data: input.data,
    ...(input.gameVersion !== undefined ? { gameVersion: input.gameVersion } : {}),
    ...(input.settingsHash !== undefined ? { settingsHash: input.settingsHash } : {}),
  };
}
