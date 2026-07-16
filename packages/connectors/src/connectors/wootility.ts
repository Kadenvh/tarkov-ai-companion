/**
 * @tier T1 (read-only parse of a Wootility/Wootling profile export on disk; no
 * device I/O, no game contact). Pushing profiles back to the keyboard is the
 * opt-in `write` path deferred to M9.5.
 *
 * `keyboard-actuation` connector for Wooting HE boards via Wootility. The Coach
 * reads actuation points, rapid-trigger config, and per-key overrides to reason
 * about how the user's inputs actually fire (relevant to peek/ADS/movement).
 *
 * NOTE ON FORMAT (unconfirmed): the real Wootility export schema and its config
 * path are NOT verified against a live export yet (SPEC-8 open question; recon
 * doc 06 §"vendor API stability" flags Wooting/SteelSeries as file-based &
 * undocumented). The zod schema below is deliberately loose
 * (`.partial().passthrough()`) and the field names are best-guess — it will be
 * refined against a real export. Everything here is overridable for that reason.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
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

const ID = "wootility";
const CAPABILITY: Capability = "keyboard-actuation";

/**
 * A single per-key override. Actuation is in millimetres of key travel.
 * Loose + passthrough: real exports carry many more fields (RGB, macros…) we
 * pass through untouched and only *type* the actuation-relevant ones.
 */
export const WootilityKeyOverride = z
  .object({
    key: z.union([z.string(), z.number()]),
    actuationPoint: z.number(), // mm
    rapidTrigger: z.boolean(),
    rapidTriggerSensitivity: z.number(), // mm
  })
  .partial()
  .passthrough();
export type WootilityKeyOverride = z.infer<typeof WootilityKeyOverride>;

/**
 * A Wootility profile export. Captures global actuation, rapid-trigger,
 * per-key overrides, and any layer/Fn info. Field names are best-guess pending
 * a real export; unknown keys are preserved via `.passthrough()`.
 */
export const WootilityProfile = z
  .object({
    name: z.string(),
    globalActuationPoint: z.number(), // mm
    rapidTrigger: z.boolean(),
    rapidTriggerSensitivity: z.number(), // mm
    keys: z.array(WootilityKeyOverride),
    /** Layer definitions if the profile uses digital/Fn layers. */
    layers: z.array(z.unknown()),
    /** Fn-layer / secondary-layer marker if present. */
    fnLayer: z.unknown(),
  })
  .partial()
  .passthrough();
export type WootilityProfile = z.infer<typeof WootilityProfile>;

/**
 * Best-guess Wootility config dir (UNCONFIRMED). Wootility is an Electron app;
 * Electron apps persist under %APPDATA%\<app-name>\ on Windows, and the Lekker
 * build ships as "wootility-lekker". Overridable via TAC_WOOTILITY_PATH.
 */
export function defaultWootilityConfigDir(): string {
  const override = process.env["TAC_WOOTILITY_PATH"];
  if (override) return override;
  const appData = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "wootility-lekker");
}

export interface WootilityConnectorOptions {
  /** Path to a profile-export JSON to read (`read` throws if unset). */
  profilePath?: string;
  /** Override the config dir probed by `detect`/`health`. */
  configDir?: string;
  /** Injectable clock for deterministic `capturedAt`. */
  clock?: Clock;
}

/** Build a Wootility `keyboard-actuation` connector. */
export function createWootilityConnector(opts: WootilityConnectorOptions = {}): Connector {
  const clock = opts.clock ?? systemClock;
  const configDir = (): string => opts.configDir ?? defaultWootilityConfigDir();

  return {
    id: ID,
    vendor: "Wooting (Wootility)",
    capabilities: [CAPABILITY],
    riskTier: "T1",

    async detect(): Promise<DetectResult> {
      const dir = configDir();
      return existsSync(dir) ? { installed: true, configPath: dir } : { installed: false };
    },

    async read(cap: Capability): Promise<ConnectorReading<WootilityProfile>> {
      if (cap !== CAPABILITY) {
        throw new Error(`Connector "${ID}" cannot read capability "${cap}".`);
      }
      if (opts.profilePath === undefined) {
        throw new Error(
          `Connector "${ID}" has no profile path configured; ` +
            `construct it with { profilePath } pointing at a Wootility export.`,
        );
      }
      const raw: unknown = JSON.parse(readFileSync(opts.profilePath, "utf8"));
      const profile = WootilityProfile.parse(raw);
      return makeReading(
        {
          connectorId: ID,
          capability: CAPABILITY,
          data: profile,
          settingsHash: hashData(profile),
        },
        clock,
      );
    },

    async health(): Promise<HealthStatus> {
      if (opts.profilePath !== undefined && existsSync(opts.profilePath)) return "connected";
      // Installed but no profile export wired up yet → stale, not missing.
      if (existsSync(configDir())) return "stale";
      return "missing";
    },
  };
}

/** Default instance (probes the guessed config dir; no profile wired up). */
export const wootilityConnector = createWootilityConnector();
