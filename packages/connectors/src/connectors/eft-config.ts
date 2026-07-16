/**
 * @tier T1 (read-only parse of the JSON settings files EFT itself writes under
 * %APPDATA%\...\Settings\*.ini). No game-process contact; this is the connector
 * re-expression of M6.1 (@tac/environment eft-settings), behavior unchanged.
 *
 * `game-config` connector, first-party. Wraps `loadEftSettings` in the M9.1
 * provenance envelope. Read-only in this slice — the reversible apply
 * (@tac/environment apply.ts, T1-write) becomes the `write` path in M9.5.
 */
import { existsSync } from "node:fs";
import { defaultSettingsDir, loadEftSettings, type EftSettings } from "@tac/environment";
import type { Capability } from "../capabilities.js";
import {
  hashData,
  makeReading,
  systemClock,
  type Clock,
  type Connector,
  type ConnectorReading,
  type DetectResult,
  type HealthStatus,
} from "../connector.js";

const ID = "eft-config";
const CAPABILITY: Capability = "game-config";

export interface EftConfigConnectorOptions {
  /** Override the settings dir (tests, Steam variants, other accounts/Arena). */
  settingsDir?: string;
  /** Injectable clock for deterministic `capturedAt`. */
  clock?: Clock;
}

/**
 * Build an EFT `game-config` connector. Pass `settingsDir` to point at a fixture
 * or an alternate install; defaults to the real roaming settings dir.
 */
export function createEftConfigConnector(opts: EftConfigConnectorOptions = {}): Connector {
  const clock = opts.clock ?? systemClock;
  const dir = (): string => opts.settingsDir ?? defaultSettingsDir();

  return {
    id: ID,
    vendor: "Battlestate Games (first-party adapter)",
    capabilities: [CAPABILITY],
    riskTier: "T1",

    async detect(): Promise<DetectResult> {
      const settingsDir = dir();
      return existsSync(settingsDir)
        ? { installed: true, configPath: settingsDir }
        : { installed: false };
    },

    async read(cap: Capability): Promise<ConnectorReading<EftSettings>> {
      if (cap !== CAPABILITY) {
        throw new Error(`Connector "${ID}" cannot read capability "${cap}".`);
      }
      const settings = loadEftSettings(dir());
      return makeReading(
        {
          connectorId: ID,
          capability: CAPABILITY,
          data: settings,
          settingsHash: hashData(settings.raw),
        },
        clock,
      );
    },

    async health(): Promise<HealthStatus> {
      const settingsDir = dir();
      if (!existsSync(settingsDir)) return "missing";
      try {
        const { present } = loadEftSettings(settingsDir);
        return present.length > 0 ? "connected" : "missing";
      } catch {
        return "error";
      }
    },
  };
}

/** Default instance against the real install. */
export const eftConfigConnector = createEftConfigConnector();
