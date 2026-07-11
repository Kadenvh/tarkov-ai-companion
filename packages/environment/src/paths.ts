import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

/** Repo root (packages/environment/src -> three levels up). */
export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

/** Where settings backups land (gitignored, per CONTRACTS §2 data/local convention). */
export const DEFAULT_BACKUP_DIR = join(REPO_ROOT, "data", "local", "backups");

/**
 * EFT writes its settings under roaming AppData, NOT the install dir
 * (verified on this machine — docs/research/06-environment-paths.md §1):
 *   %APPDATA%\Battlestate Games\Escape from Tarkov\Settings\
 * All five files are plain JSON despite the .ini extension.
 * Override with TAC_EFT_SETTINGS_PATH (tests, Steam variants, other accounts).
 */
export function defaultSettingsDir(): string {
  const override = process.env["TAC_EFT_SETTINGS_PATH"];
  if (override) return override;
  const appData = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "Battlestate Games", "Escape from Tarkov", "Settings");
}
