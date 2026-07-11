/**
 * @tier T1-write (writes files EFT itself owns — ONLY while the game is
 * closed, ONLY keys the in-game UI exposes, ALWAYS after a timestamped
 * backup). Policy: SPEC.md §1 + docs/research/06-environment-paths.md §3.
 *
 * Never touches the EFT process, memory, input, or window. The game-running
 * check is a `tasklist` image-name query — process *listing*, not process
 * access.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadEftSettings, parseSettingsJson, type SettingsFileName } from "./eft-settings.js";
import { diffSettings, type RecommendationProfile, type SettingDiff } from "./profiles.js";
import { DEFAULT_BACKUP_DIR, defaultSettingsDir } from "./paths.js";

const execFileAsync = promisify(execFile);

export const EFT_PROCESS_NAME = "EscapeFromTarkov.exe";

/** Typed refusal — the service maps this to HTTP 409 (CONTRACTS §5.4). */
export class GameRunningError extends Error {
  readonly code = "GAME_RUNNING";
  constructor() {
    super(`${EFT_PROCESS_NAME} is running — settings can only be applied while the game is closed`);
    this.name = "GameRunningError";
  }
}

/**
 * Is EFT running? Uses `tasklist` filtered by image name (read-only process
 * listing; zero interaction with the process itself). If the check cannot run
 * (non-Windows CI), we conservatively report "running" so apply refuses —
 * never write when we cannot prove the game is closed.
 */
export async function isEftRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "tasklist",
      ["/FI", `IMAGENAME eq ${EFT_PROCESS_NAME}`, "/FO", "CSV", "/NH"],
      { windowsHide: true },
    );
    return stdout.toLowerCase().includes(EFT_PROCESS_NAME.toLowerCase());
  } catch {
    return true; // can't verify -> refuse to write
  }
}

const BackupManifest = z.object({
  id: z.string(),
  createdAt: z.string(),
  settingsDir: z.string(),
  profileKey: z.string().optional(),
  files: z.array(z.string()),
});
export type BackupManifest = z.infer<typeof BackupManifest>;

export interface ApplyOptions {
  /** Settings dir to write (tests inject a temp copy; NEVER point tests at the real dir). */
  settingsDir?: string;
  backupDir?: string;
  /** Injectable for tests; defaults to the real tasklist check. */
  isGameRunning?: () => Promise<boolean> | boolean;
  now?: () => Date;
}

export interface ApplyResult {
  /** null when the profile matched current settings exactly (nothing written, no backup). */
  backupId: string | null;
  applied: SettingDiff[];
}

function backupIdFor(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `settings-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${Math.random().toString(16).slice(2, 6)}`
  );
}

/**
 * Apply a recommendation profile to the on-disk settings.
 * Refuses (GameRunningError) unless the game is provably closed. Backs up
 * every file it is about to modify into `<backupDir>/<backupId>/` (raw byte
 * copy + manifest.json) before writing. Only keys present in the profile —
 * all of which the in-game UI exposes — are modified; every other key in the
 * file is preserved verbatim via read-modify-write.
 */
export async function applyProfile(profile: RecommendationProfile, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const settingsDir = opts.settingsDir ?? defaultSettingsDir();
  const backupDir = opts.backupDir ?? DEFAULT_BACKUP_DIR;
  const running = await (opts.isGameRunning ?? isEftRunning)();
  if (running) throw new GameRunningError();

  const current = loadEftSettings(settingsDir);
  const diffs = diffSettings(current, profile);
  if (diffs.length === 0) return { backupId: null, applied: [] };

  // Group pending writes by file.
  const byFile = new Map<SettingsFileName, SettingDiff[]>();
  for (const diff of diffs) {
    const file = diff.key.slice(0, diff.key.indexOf(".")) as SettingsFileName;
    byFile.set(file, [...(byFile.get(file) ?? []), diff]);
  }

  // Backup (raw byte copies) before any write.
  const now = (opts.now ?? (() => new Date()))();
  const backupId = backupIdFor(now);
  const dest = join(backupDir, backupId);
  mkdirSync(dest, { recursive: true });
  const files = [...byFile.keys()].map((f) => `${f}.ini`);
  for (const file of files) copyFileSync(join(settingsDir, file), join(dest, file));
  const manifest: BackupManifest = {
    id: backupId,
    createdAt: now.toISOString(),
    settingsDir,
    profileKey: profile.key,
    files,
  };
  writeFileSync(join(dest, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Read-modify-write each touched file (2-space indent, matching how the game writes them).
  for (const [file, fileDiffs] of byFile) {
    const path = join(settingsDir, `${file}.ini`);
    const json = parseSettingsJson(readFileSync(path, "utf8"));
    for (const diff of fileDiffs) json[diff.key.slice(diff.key.indexOf(".") + 1)] = diff.recommended;
    writeFileSync(path, JSON.stringify(json, null, 2));
  }

  return { backupId, applied: diffs };
}

/** List available backups, newest first. */
export function listBackups(backupDir: string = DEFAULT_BACKUP_DIR): BackupManifest[] {
  if (!existsSync(backupDir)) return [];
  const manifests: BackupManifest[] = [];
  for (const entry of readdirSync(backupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(backupDir, entry.name, "manifest.json");
    if (!existsSync(file)) continue;
    const parsed = BackupManifest.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) manifests.push(parsed.data);
  }
  return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface RestoreOptions {
  settingsDir?: string;
  backupDir?: string;
  isGameRunning?: () => Promise<boolean> | boolean;
}

/**
 * Restore a backup by id — byte-for-byte copies of the original files back
 * into the settings dir. Same game-closed guard as apply.
 */
export async function restoreBackup(backupId: string, opts: RestoreOptions = {}): Promise<BackupManifest> {
  const settingsDir = opts.settingsDir ?? defaultSettingsDir();
  const backupDir = opts.backupDir ?? DEFAULT_BACKUP_DIR;
  const running = await (opts.isGameRunning ?? isEftRunning)();
  if (running) throw new GameRunningError();

  if (!/^[\w.-]+$/.test(backupId)) throw new Error(`Invalid backup id: ${backupId}`);
  const dir = join(backupDir, backupId);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`Backup not found: ${backupId}`);
  const manifest = BackupManifest.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  for (const file of manifest.files) copyFileSync(join(dir, file), join(settingsDir, file));
  return manifest;
}
