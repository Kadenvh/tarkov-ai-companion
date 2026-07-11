import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (packages/data-core/src -> three levels up). */
export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
export const SNAPSHOT_DIR = join(REPO_ROOT, "data", "snapshots");
export const STORY_DIR = join(REPO_ROOT, "data", "story");

const DEFAULT_EFT_PATH = "C:\\Battlestate Games\\Escape from Tarkov";

/** EFT install dir; override with TAC_EFT_PATH for Steam/custom installs. */
export function eftInstallPath(): string {
  return process.env["TAC_EFT_PATH"] ?? DEFAULT_EFT_PATH;
}

/**
 * Detect the installed game version from the newest log session folder,
 * e.g. `log_2026.07.11_4-38-37_1.0.6.0.46010` -> `1.0.6.0.46010`.
 * Returns null when no local install/logs are present (CI, other machines).
 */
export function detectGameVersion(): string | null {
  const logs = join(eftInstallPath(), "Logs");
  if (!existsSync(logs)) return null;
  const versions = readdirSync(logs)
    .map((name) => /^log_[\d.]+_[\d-]+_(?<ver>[\d.]+)$/.exec(name)?.groups?.["ver"])
    .filter((v): v is string => Boolean(v));
  return versions.sort().at(-1) ?? null;
}
