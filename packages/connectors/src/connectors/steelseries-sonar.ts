/**
 * @tier T1 (read-only parse of a SteelSeries Sonar config/export on disk; no
 * device I/O, no game contact). Pushing routing/EQ back into Sonar is the
 * opt-in `write` path deferred to M9.5.
 *
 * `audio-mix` connector for SteelSeries Sonar (part of SteelSeries GG). The
 * Coach reads virtual-device routing, per-band EQ, and the ChatMix balance to
 * reason about how the user's audio is shaped (footstep audibility, comms vs.
 * game balance).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NOTE ON FORMAT & PATH (UNCONFIRMED — refine against a real export):
 *   SteelSeries GG is file-based and undocumented. Sonar's live state is known
 *   to persist to a SQLite DB under the GG app dir
 *     %PROGRAMDATA%\SteelSeries\GG\apps\sonar\db\database.db
 *   which is NOT JSON. This connector currently expects a JSON *config/export*
 *   (the shape a "Save configuration" / profile-export would plausibly produce);
 *   the exact schema is a best guess. The zod schema is therefore deliberately
 *   loose (`.partial().passthrough()`) and every field name is provisional. The
 *   default probe path (below) and the read path are BOTH overridable — via the
 *   factory `configPath` option and the `TAC_SONAR_PATH` env var — precisely so
 *   this can be pointed at a real export once we have one.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { existsSync, readFileSync } from "node:fs";
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

const ID = "steelseries-sonar";
const CAPABILITY: Capability = "audio-mix";

/**
 * A single parametric-EQ band. `frequency` in Hz, `gain` in dB. Loose +
 * passthrough: real exports likely carry filter type, enable flags, etc.
 */
export const SonarEqBand = z
  .object({
    frequency: z.number(), // Hz
    gain: z.number(), // dB
    q: z.number(),
    type: z.string(), // "peak" | "lowshelf" | ... (provisional)
    enabled: z.boolean(),
  })
  .partial()
  .passthrough();
export type SonarEqBand = z.infer<typeof SonarEqBand>;

/**
 * One Sonar virtual channel (Game / Chat / Media / Aux / Mic). Carries volume,
 * mute, the physical device(s) it routes to, and its own EQ curve.
 */
export const SonarChannel = z
  .object({
    name: z.string(),
    volume: z.number(), // 0..1 (provisional)
    muted: z.boolean(),
    /** Physical output/input device name(s) this channel routes to. */
    devices: z.array(z.string()),
    eq: z.array(SonarEqBand),
  })
  .partial()
  .passthrough();
export type SonarChannel = z.infer<typeof SonarChannel>;

/**
 * A SteelSeries Sonar config export. Captures the per-channel routing/EQ, a
 * top-level EQ (if the export stores one globally), and the ChatMix balance.
 * Field names are best-guess pending a real export; unknown keys survive via
 * `.passthrough()`.
 */
export const SonarConfig = z
  .object({
    version: z.union([z.string(), z.number()]),
    /** ChatMix: the game↔chat balance dial. `balance` provisionally -1..1. */
    chatMix: z
      .object({ enabled: z.boolean(), balance: z.number() })
      .partial()
      .passthrough(),
    /** Per-virtual-channel routing + EQ. */
    channels: z.array(SonarChannel),
    /** Global EQ curve, if the export stores one outside `channels`. */
    eq: z.array(SonarEqBand),
    /** Selected physical devices per role, if flattened rather than per-channel. */
    routing: z.record(z.string(), z.unknown()),
  })
  .partial()
  .passthrough();
export type SonarConfig = z.infer<typeof SonarConfig>;

/**
 * Best-guess Sonar config path (UNCONFIRMED — see the header note). Overridable
 * via the `TAC_SONAR_PATH` env var, then the factory `configPath` option.
 */
export function defaultSonarConfigPath(): string {
  const override = process.env["TAC_SONAR_PATH"];
  if (override) return override;
  const programData = process.env["PROGRAMDATA"] ?? "C:\\ProgramData";
  // Provisional: a JSON export beside Sonar's real SQLite store (db/database.db).
  return join(programData, "SteelSeries", "GG", "apps", "sonar", "sonar-config.json");
}

export interface SteelSeriesSonarConnectorOptions {
  /** Path to a Sonar config/export JSON to read (defaults to `defaultSonarConfigPath`). */
  configPath?: string;
  /** Injectable clock for deterministic `capturedAt`. */
  clock?: Clock;
}

/** Build a SteelSeries Sonar `audio-mix` connector. */
export function createSteelSeriesSonarConnector(
  opts: SteelSeriesSonarConnectorOptions = {},
): Connector {
  const clock = opts.clock ?? systemClock;
  const configPath = (): string => opts.configPath ?? defaultSonarConfigPath();

  return {
    id: ID,
    vendor: "SteelSeries (Sonar / GG)",
    capabilities: [CAPABILITY],
    riskTier: "T1",

    async detect(): Promise<DetectResult> {
      const path = configPath();
      return existsSync(path) ? { installed: true, configPath: path } : { installed: false };
    },

    async read(cap: Capability): Promise<ConnectorReading<SonarConfig>> {
      if (cap !== CAPABILITY) {
        throw new Error(`Connector "${ID}" cannot read capability "${cap}".`);
      }
      const path = configPath();
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      const config = SonarConfig.parse(raw);
      return makeReading(
        {
          connectorId: ID,
          capability: CAPABILITY,
          data: config,
          settingsHash: hashData(config),
        },
        clock,
      );
    },

    async health(): Promise<HealthStatus> {
      const path = configPath();
      if (!existsSync(path)) return "missing";
      try {
        SonarConfig.parse(JSON.parse(readFileSync(path, "utf8")));
        return "connected";
      } catch {
        return "error";
      }
    },
  };
}

/** Default instance (probes the guessed config path). */
export const steelSeriesSonarConnector = createSteelSeriesSonarConnector();
