import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * @tier T1 — read-only discovery of the EFT install and its log sessions.
 * Never writes, moves, or deletes anything under the game directory.
 *
 * Verified on this machine (docs/research/03 §1, /06 §1):
 *  - BSG launcher: `HKLM\SOFTWARE\WOW6432Node\...\Uninstall\EscapeFromTarkov`
 *    → `InstallLocation` (confirmed live: C:\Battlestate Games\Escape from Tarkov)
 *  - Steam:        `HKLM\SOFTWARE\Microsoft\...\Uninstall\Steam App 3932890`
 *    (logs nest under `<install>\build\Logs`)
 *  - Sessions: `<Logs>\log_yyyy.MM.dd_H-mm-ss[_version]`, streams named
 *    `<stamp>_<version> <stream>_NNN.log` — matched by substring, so BSG
 *    renames (notifications → push-notifications) don't break us.
 */

const REGISTRY_KEYS = [
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EscapeFromTarkov",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App 3932890",
];

const KNOWN_PATHS = ["C:\\Battlestate Games\\Escape from Tarkov"];

function queryRegistryInstall(key: string): string | null {
  try {
    const out = execFileSync("reg", ["query", key, "/v", "InstallLocation"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /InstallLocation\s+REG_SZ\s+(.+)/.exec(out);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Locate the EFT install directory: env override → registry (launcher, Steam)
 * → known default path. Returns null when no install is present (CI).
 */
export function detectInstallDir(): string | null {
  const override = process.env["TAC_EFT_PATH"];
  if (override && existsSync(override)) return override;
  for (const key of REGISTRY_KEYS) {
    const loc = queryRegistryInstall(key);
    if (loc && existsSync(loc)) return loc;
  }
  for (const p of KNOWN_PATHS) if (existsSync(p)) return p;
  return null;
}

/** Logs root under an install dir (`Logs`, or Steam's `build\Logs`). */
export function findLogsDir(installDir: string): string | null {
  for (const candidate of [join(installDir, "Logs"), join(installDir, "build", "Logs")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface SessionFolder {
  name: string;
  dir: string;
  /** sortable local start time `YYYY-MM-DDTHH:mm:ss` from the folder name */
  startedAt: string;
  /** game version suffix (1.0+), e.g. `1.0.6.0.46010`; null pre-1.0 */
  version: string | null;
}

const SESSION_NAME = /^log_(\d{4})\.(\d{2})\.(\d{2})_(\d{1,2})-(\d{2})-(\d{2})(?:_([\w.]+))?$/;

export function parseSessionFolderName(name: string): Omit<SessionFolder, "dir"> | null {
  const m = SESSION_NAME.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, version] = m;
  return {
    name,
    startedAt: `${y}-${mo}-${d}T${(h ?? "0").padStart(2, "0")}:${mi}:${s}`,
    version: version ?? null,
  };
}

/** All session folders under a Logs dir, ordered oldest → newest. */
export function listSessionFolders(logsDir: string): SessionFolder[] {
  if (!existsSync(logsDir)) return [];
  const out: SessionFolder[] = [];
  for (const entry of readdirSync(logsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const parsed = parseSessionFolderName(entry.name);
    if (parsed) out.push({ ...parsed, dir: join(logsDir, entry.name) });
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export interface SessionStreams {
  /** rotation counters sorted ascending (`_000`, `_001`, …) */
  application: string[];
  pushNotifications: string[];
}

/** Map a session folder's files to the streams we consume (substring match). */
export function sessionStreams(sessionDir: string): SessionStreams {
  const streams: SessionStreams = { application: [], pushNotifications: [] };
  if (!existsSync(sessionDir)) return streams;
  for (const file of readdirSync(sessionDir).sort()) {
    if (!file.endsWith(".log")) continue;
    if (file.includes("application")) streams.application.push(join(sessionDir, file));
    // "push-notifications" today, "notifications" pre-1.0 — substring survives both
    else if (file.includes("notifications")) streams.pushNotifications.push(join(sessionDir, file));
  }
  return streams;
}
