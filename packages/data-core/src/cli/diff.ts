/**
 * Snapshot-diff CLI (M1.2). Reports the structural delta between two per-patch
 * snapshots so a new EFT version reads as a reviewable change list.
 *
 * Usage:
 *   pnpm --filter @tac/data-core diff                 # previous -> latest
 *   pnpm --filter @tac/data-core diff <to>            # (to's predecessor) -> to
 *   pnpm --filter @tac/data-core diff <from> <to>     # explicit pair
 *   ... [--json] [--mode regular|pve]
 *
 * (Runnable via tsx, like the existing snapshot CLI.)
 */
import type { GameMode } from "@tac/shared";
import { diffSnapshots, formatDiff } from "../diff.js";
import { listSnapshots, previousSnapshotOf, snapshotExists } from "../snapshot.js";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const modeIdx = argv.indexOf("--mode");
const mode: GameMode = modeIdx !== -1 && argv[modeIdx + 1] === "pve" ? "pve" : "regular";
const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--mode");

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

let fromVersion: string;
let toVersion: string;

if (positional.length === 0) {
  const to = listSnapshots().at(-1);
  if (!to) die("No snapshots on disk — run `pnpm snapshot` first.");
  const from = previousSnapshotOf(to!);
  if (!from) die(`Only one snapshot on disk (${to}) — nothing to diff against. Pass an explicit <from> <to>.`);
  fromVersion = from!;
  toVersion = to!;
} else if (positional.length === 1) {
  toVersion = positional[0]!;
  const from = previousSnapshotOf(toVersion);
  if (!from) die(`No snapshot precedes ${toVersion} on disk. Pass an explicit <from> <to>.`);
  fromVersion = from;
} else {
  fromVersion = positional[0]!;
  toVersion = positional[1]!;
}

for (const v of [fromVersion, toVersion]) {
  if (!snapshotExists(v)) {
    die(`No snapshot on disk for ${v}. Available: ${listSnapshots().join(", ") || "(none)"}`);
  }
}

const diff = diffSnapshots(fromVersion, toVersion, mode);

if (json) {
  process.stdout.write(JSON.stringify(diff, null, 2) + "\n");
} else {
  console.log(formatDiff(diff));
}

// Non-zero exit when the TARGET snapshot breaks a structural invariant, so the
// CLI can gate CI / a patch-readiness check.
if (!diff.invariants.ok) process.exit(2);
