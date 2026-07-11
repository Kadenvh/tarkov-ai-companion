/**
 * Backfill CLI (M2.3) — reconstruct player state from all historical logs.
 *
 *   pnpm --filter @tac/state-engine exec tsx src/cli/backfill.ts \
 *     [--profile-key main-regular] [--logs "C:\...\Logs"] [--db-dir data/local/profiles] [--profile-id <24hex>]
 *
 * Read-only on the game's files; writes only the local profile database.
 */
import { detectInstallDir, findLogsDir } from "../logs/discover.js";
import { backfillHistory } from "../backfill.js";
import { openProfile } from "../store.js";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const profileKey = arg("--profile-key") ?? "main-regular";
const logsDir =
  arg("--logs") ??
  (() => {
    const install = detectInstallDir();
    return install ? findLogsDir(install) : null;
  })();

if (!logsDir) {
  console.error("No EFT Logs directory found (pass --logs or set TAC_EFT_PATH).");
  process.exit(1);
}

const dir = arg("--db-dir");
const store = openProfile(profileKey, dir ? { dir } : {});
const profileId = arg("--profile-id");
const result = backfillHistory(store, { logsDir, ...(profileId ? { profileId } : {}) });
console.log(JSON.stringify({ profileKey, logsDir, ...result }, null, 2));
store.close();
