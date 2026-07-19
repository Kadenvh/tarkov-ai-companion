import { gunzipSync } from "node:zlib";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { GameMode } from "@tac/shared";
import { snapshotDir } from "./paths.js";
import type { EndpointName } from "./api.js";

export interface SnapshotRef {
  version: string;
  dir: string;
}

/** All snapshot version labels on disk, ascending (lexicographic within a major line). */
export function listSnapshots(): string[] {
  const root = snapshotDir();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** Newest snapshot on disk (versions sort lexicographically well enough within a major line). */
export function latestSnapshot(): SnapshotRef {
  const version = listSnapshots().at(-1);
  if (!version) throw new Error(`No snapshots in ${snapshotDir()} — run \`pnpm snapshot\` first`);
  return { version, dir: join(snapshotDir(), version) };
}

/** Reference to a specific snapshot version (does not check existence — see {@link snapshotExists}). */
export function snapshotRef(version: string): SnapshotRef {
  return { version, dir: join(snapshotDir(), version) };
}

/** Whether a snapshot for `version` exists on disk (has a manifest.json). */
export function snapshotExists(version: string): boolean {
  return existsSync(join(snapshotDir(), version, "manifest.json"));
}

/** The snapshot immediately preceding `version` on disk, or null if none. */
export function previousSnapshotOf(version: string): string | null {
  const all = listSnapshots();
  const idx = all.indexOf(version);
  if (idx <= 0) return null;
  return all[idx - 1] ?? null;
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
