import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (packages/data-core/src -> three levels up). */
export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

/**
 * Dev-default data dirs (repo layout). These are the fallbacks the resolvers
 * below use when the matching env var is unset — kept as exported constants so
 * existing dev code (and tests) that reference them keep working unchanged.
 */
export const SNAPSHOT_DIR = join(REPO_ROOT, "data", "snapshots");
export const STORY_DIR = join(REPO_ROOT, "data", "story");
export const DATA_LOCAL_DIR = join(REPO_ROOT, "data", "local");

/**
 * Data-directory resolution (env-configurable so the packaged Electron app can
 * point the sidecars at the installed layout — read-only snapshots/story ship
 * in `resources`, the writable data-local root lives under the user profile).
 * Each resolver reads its env var at call time and falls back to the dev-layout
 * constant above, so behaviour is identical when the vars are unset.
 *
 *   TAC_SNAPSHOT_DIR  snapshots root   (default <REPO_ROOT>/data/snapshots)
 *   TAC_STORY_DIR     story dataset    (default <REPO_ROOT>/data/story)
 *   TAC_DATA_DIR      writable local   (default <REPO_ROOT>/data/local)
 */

/** Snapshots root — `TAC_SNAPSHOT_DIR` override (read-only in the packaged app). */
export function snapshotDir(): string {
  return process.env["TAC_SNAPSHOT_DIR"] ?? SNAPSHOT_DIR;
}

/** Story dataset dir — `TAC_STORY_DIR` override (read-only in the packaged app). */
export function storyDir(): string {
  return process.env["TAC_STORY_DIR"] ?? STORY_DIR;
}

/** Writable data-local root (config.json + profiles/*.sqlite) — `TAC_DATA_DIR` override. */
export function dataLocalDir(): string {
  return process.env["TAC_DATA_DIR"] ?? DATA_LOCAL_DIR;
}

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
