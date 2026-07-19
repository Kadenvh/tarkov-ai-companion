/**
 * Pull a full per-patch snapshot of json.tarkov.dev into data/snapshots/<version>/.
 * Files are gzipped JSON. English string tables are pulled for translated endpoints.
 *
 * Usage: pnpm snapshot [versionLabel]  (default: auto-detect from EFT logs)
 */
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENDPOINTS, fetchJson } from "../api.js";
import { snapshotDir, detectGameVersion } from "../paths.js";

const MODES = ["regular", "pve"] as const;
const LANG = "en";

const version = process.argv[2] ?? detectGameVersion();
if (!version) {
  console.error("No version label given and no local EFT install found. Usage: pnpm snapshot <version>");
  process.exit(1);
}

const outRoot = join(snapshotDir(), version);
const manifest: Record<string, unknown> = {
  version,
  source: "https://json.tarkov.dev",
  fetchedAt: new Date().toISOString(),
  lang: LANG,
  files: {} as Record<string, { bytes: number; topLevelKeys: string[] }>,
};

function save(mode: string, name: string, data: unknown): void {
  const dir = join(outRoot, mode);
  mkdirSync(dir, { recursive: true });
  const raw = Buffer.from(JSON.stringify(data));
  writeFileSync(join(dir, `${name}.json.gz`), gzipSync(raw));
  (manifest["files"] as Record<string, unknown>)[`${mode}/${name}`] = {
    bytes: raw.length,
    topLevelKeys: data && typeof data === "object" ? Object.keys(data as object) : [],
  };
  console.log(`  ${mode}/${name}.json.gz  (${(raw.length / 1024).toFixed(0)} KiB raw)`);
}

console.log(`Snapshotting json.tarkov.dev -> ${outRoot}`);
for (const mode of MODES) {
  for (const ep of ENDPOINTS) {
    save(mode, ep.name, await fetchJson(`/${mode}/${ep.name}`));
    if (ep.translated) save(mode, `${ep.name}_${LANG}`, await fetchJson(`/${mode}/${ep.name}_${LANG}`));
  }
}
writeFileSync(join(outRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("Snapshot complete.");
