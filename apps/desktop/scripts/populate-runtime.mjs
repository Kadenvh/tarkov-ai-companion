// Drop a standalone Node runtime into apps/desktop/resources/runtime/node.exe
// so the packaged app can run the bundled sidecars (dist-electron/sidecars/*.mjs)
// without Node/pnpm/tsx installed on the target machine.
//
// It copies THIS machine's currently-running Node binary (process.execPath).
// That binary MUST be Node 26+ because the sidecars rely on `node:sqlite`
// (stable in Node 24+, used by @tac/state-engine) and are built with
// target:node26. If you run this under an older Node, the installed app will
// fail to open the profile database. The script prints the version it copied so
// you can confirm.
//
// electron-builder.yml then ships resources/runtime/ -> <install>/resources/runtime/
// via extraResources. `node.exe` is intentionally NOT committed (it is large and
// machine-specific); this script (or the `prepackage` npm script) regenerates it.
//
// Idempotent: re-running overwrites the existing copy.
//
// @tier T0 (build tooling — no game-process contact).

import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = resolve(root, "resources", "runtime");
const dest = resolve(runtimeDir, "node.exe");

const src = process.execPath;
const [major] = process.versions.node.split(".").map(Number);

console.log(`[populate-runtime] source runtime: ${src}`);
console.log(`[populate-runtime] this Node:      v${process.versions.node}`);

if (!Number.isInteger(major) || major < 26) {
  console.warn(
    `[populate-runtime] WARNING: this Node is v${process.versions.node}, but the ` +
      "sidecars need Node 26+ (node:sqlite + target:node26). The bundled runtime " +
      "will be the wrong version — re-run this under Node 26.",
  );
}

if (basename(src).toLowerCase() !== "node.exe") {
  console.warn(
    `[populate-runtime] NOTE: process.execPath basename is "${basename(src)}", not ` +
      '"node.exe". On Windows this should be node.exe; the copy is still written as ' +
      "node.exe so the packaged spawner can find it.",
  );
}

await mkdir(runtimeDir, { recursive: true });
await copyFile(src, dest);

const info = await stat(dest);
console.log(
  `[populate-runtime] copied -> ${dest} (${(info.size / 1024 / 1024).toFixed(1)} MB)`,
);

// Best-effort sanity check that the copied binary runs and reports its version.
try {
  const out = execFileSync(dest, ["--version"], { encoding: "utf8" }).trim();
  console.log(`[populate-runtime] bundled runtime reports ${out}`);
} catch (err) {
  console.warn(
    `[populate-runtime] could not verify the copied runtime: ${err instanceof Error ? err.message : String(err)}`,
  );
}
