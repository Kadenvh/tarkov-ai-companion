import { gunzipSync } from "node:zlib";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { GameMode } from "@tac/shared";
import { SNAPSHOT_DIR } from "./paths.js";
import type { EndpointName } from "./api.js";

export interface SnapshotRef {
  version: string;
  dir: string;
}

/** Newest snapshot on disk (versions sort lexicographically well enough within a major line). */
export function latestSnapshot(): SnapshotRef {
  const versions = readdirSync(SNAPSHOT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const version = versions.at(-1);
  if (!version) throw new Error(`No snapshots in ${SNAPSHOT_DIR} — run \`pnpm snapshot\` first`);
  return { version, dir: join(SNAPSHOT_DIR, version) };
}

export function loadRaw(ref: SnapshotRef, mode: GameMode, name: string): unknown {
  const file = join(ref.dir, mode, `${name}.json.gz`);
  if (!existsSync(file)) throw new Error(`Missing snapshot file: ${file}`);
  return JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
}

/** English string table for a translated endpoint: flat map of key -> localized text. */
export function loadStrings(ref: SnapshotRef, mode: GameMode, name: EndpointName): Record<string, string> {
  return loadRaw(ref, mode, `${name}_en`) as Record<string, string>;
}

/** Resolve a translation key like "<id> name" against a string table, falling back to the key. */
export function tr(strings: Record<string, string>, key: string | null | undefined): string {
  if (!key) return "";
  return strings[key] ?? key;
}
