/**
 * @tier T1 read / T1-write (read-only parse of the JSON settings files EFT
 * itself writes under %APPDATA%\...\Settings\*.ini; and — only when writes are
 * explicitly opted in — the reversible, backup-first apply from
 * @tac/environment apply.ts). No game-process contact in either direction: the
 * write path refuses unless the game is provably closed and always backs up
 * prior state first, so every change is one-click reversible.
 *
 * `game-config` connector, first-party. Reads wrap `loadEftSettings` in the
 * M9.1 provenance envelope. Writes (M9.5) wrap `applyProfile` / `restoreBackup`
 * — the backup/apply/restore logic is NOT reimplemented here, only surfaced
 * behind the connector contract and the opt-in gate.
 */
import { existsSync } from "node:fs";
import {
  applyProfile,
  defaultSettingsDir,
  isEftRunning,
  loadEftSettings,
  restoreBackup,
  GameRunningError,
  type ApplyOptions,
  type BackupManifest,
  type EftSettings,
  type RecommendationProfile,
  type RestoreOptions,
  type SettingDiff,
} from "@tac/environment";
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
  type WriteResult,
} from "../connector.js";

const ID = "eft-config";
const CAPABILITY: Capability = "game-config";

/**
 * Thrown when `write`/`revert` is called on a connector that was NOT built with
 * `enableWrites: true`. Reads are always allowed; writes are opt-in per M9.5.
 */
export class WritesDisabledError extends Error {
  readonly code = "WRITES_DISABLED";
  constructor(readonly connectorId: string) {
    super(
      `Connector "${connectorId}" has writes disabled — construct it with ` +
        `{ enableWrites: true } to allow the opt-in, backup-first game-config apply.`,
    );
    this.name = "WritesDisabledError";
  }
}

/**
 * Result of a `game-config` write. Extends the generic `WriteResult` (so it is
 * assignable wherever a `WriteResult` is expected) with the concrete diff that
 * was applied. `backupId` + `revert` make the change one-click reversible; the
 * backup manifest itself is returned by `revert` (from `restoreBackup`).
 */
export interface GameConfigWriteResult extends WriteResult {
  /** The settings actually changed (empty when the profile already matched disk). */
  diff: SettingDiff[];
}

/**
 * The `game-config` connector. `write` is always present but throws
 * `WritesDisabledError` unless `enableWrites` was set; `writesEnabled` reflects
 * the gate so the registry can refuse a write without invoking it. `revert`
 * undoes a prior write by restoring its backup.
 */
export interface GameConfigConnector extends Connector {
  /** Opt-in, backup-first apply of a recommendation profile. */
  write(cap: Capability, patch: unknown): Promise<GameConfigWriteResult>;
  /** Undo a write: restore the backup by id or from a prior `WriteResult`. */
  revert(handle: string | WriteResult): Promise<BackupManifest>;
  /** True only when constructed with `enableWrites: true`. */
  readonly writesEnabled: boolean;
}

export interface EftConfigConnectorOptions {
  /** Override the settings dir (tests, Steam variants, other accounts/Arena). */
  settingsDir?: string;
  /** Injectable clock for deterministic `capturedAt`. */
  clock?: Clock;
  /**
   * Opt-in gate for writes (M9.5). Default **false** — the connector is
   * read-only unless this is explicitly `true`.
   */
  enableWrites?: boolean;
  /** Override the backup dir (tests inject a temp dir; real writes use the default). */
  backupDir?: string;
  /** Injectable apply (tests pass a fake so no real files are touched). */
  apply?: typeof applyProfile;
  /** Injectable restore (tests pass a fake so no real files are touched). */
  restore?: typeof restoreBackup;
  /** Injectable game-running probe (tests pass a fake so the real process is never queried). */
  isRunning?: typeof isEftRunning;
}

/**
 * Build an EFT `game-config` connector. Pass `settingsDir` to point at a fixture
 * or an alternate install; defaults to the real roaming settings dir. Writes are
 * OFF unless `enableWrites: true`; the `apply`/`restore`/`isRunning` overrides
 * let tests exercise the write path without touching real files or the process.
 */
export function createEftConfigConnector(
  opts: EftConfigConnectorOptions = {},
): GameConfigConnector {
  const clock = opts.clock ?? systemClock;
  const dir = (): string => opts.settingsDir ?? defaultSettingsDir();
  const enableWrites = opts.enableWrites ?? false;
  const applyFn = opts.apply ?? applyProfile;
  const restoreFn = opts.restore ?? restoreBackup;
  const isRunningFn = opts.isRunning ?? isEftRunning;

  const applyOpts = (): ApplyOptions => ({
    settingsDir: dir(),
    isGameRunning: isRunningFn,
    ...(opts.backupDir !== undefined ? { backupDir: opts.backupDir } : {}),
  });
  const restoreOpts = (): RestoreOptions => ({
    settingsDir: dir(),
    isGameRunning: isRunningFn,
    ...(opts.backupDir !== undefined ? { backupDir: opts.backupDir } : {}),
  });

  async function doRevert(handle: string | WriteResult): Promise<BackupManifest> {
    if (!enableWrites) throw new WritesDisabledError(ID);
    const backupId = typeof handle === "string" ? handle : handle.backupId;
    if (backupId === undefined) {
      throw new Error(
        `Nothing to revert: the write applied no changes (no backup was taken).`,
      );
    }
    return restoreFn(backupId, restoreOpts());
  }

  return {
    id: ID,
    vendor: "Battlestate Games (first-party adapter)",
    capabilities: [CAPABILITY],
    riskTier: "T1",
    writesEnabled: enableWrites,

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

    async write(cap: Capability, patch: unknown): Promise<GameConfigWriteResult> {
      if (!enableWrites) throw new WritesDisabledError(ID);
      if (cap !== CAPABILITY) {
        throw new Error(`Connector "${ID}" cannot write capability "${cap}".`);
      }
      // Pre-flight refusal: surface GameRunningError BEFORE any apply/backup is
      // attempted while the game is open. applyProfile re-checks internally
      // (defense in depth via the injected isGameRunning below).
      if (await isRunningFn()) throw new GameRunningError();

      const result = await applyFn(patch as RecommendationProfile, applyOpts());
      const { backupId } = result;

      return {
        applied: backupId !== null,
        diff: result.applied,
        ...(backupId !== null ? { backupId } : {}),
        ...(backupId !== null
          ? {
              revert: async (): Promise<void> => {
                await doRevert(backupId);
              },
            }
          : {}),
      };
    },

    revert(handle: string | WriteResult): Promise<BackupManifest> {
      return doRevert(handle);
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

/** Default instance against the real install — read-only (writes not enabled). */
export const eftConfigConnector = createEftConfigConnector();
