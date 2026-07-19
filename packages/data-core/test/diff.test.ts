import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffSnapshots, formatDiff } from "../src/diff.js";

/**
 * M1.2 snapshot diff — driven against two purpose-built fixture snapshots so the
 * added / removed / renamed / gate-change / invariant-break cases are exact and
 * filesystem-real (gzipped json.gz files, loaded through the normal loaders via
 * TAC_SNAPSHOT_DIR). No network.
 */

const FROM = "9.0.0.00000";
const TO = "9.0.1.00001";

let root: string;

/** Write one gzipped snapshot file: <root>/<version>/<mode>/<name>.json.gz */
function save(version: string, name: string, data: unknown): void {
  const dir = join(root, version, "regular");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json.gz`), gzipSync(Buffer.from(JSON.stringify(data))));
}

interface FixtureTask {
  id: string;
  trader: string;
  minPlayerLevel?: number;
  kappaRequired?: boolean;
  lightkeeperRequired?: boolean;
  taskRequirements?: { task: string; status: string[] }[];
  failConditions?: { id: string; type: string; task: string; status: string[] }[];
}

function task(t: FixtureTask) {
  return {
    id: t.id,
    name: `${t.id} name`,
    trader: t.trader,
    minPlayerLevel: t.minPlayerLevel ?? 0,
    kappaRequired: t.kappaRequired ?? false,
    lightkeeperRequired: t.lightkeeperRequired ?? false,
    taskRequirements: t.taskRequirements ?? [],
    traderRequirements: [],
    objectives: [],
    ...(t.failConditions ? { failConditions: t.failConditions } : {}),
  };
}

function writeVersion(
  version: string,
  opts: {
    tasks: FixtureTask[];
    taskNames: Record<string, string>;
    items: string[];
    traderLevels: number;
    stationLevels: number;
  },
): void {
  const tasks: Record<string, unknown> = {};
  for (const t of opts.tasks) tasks[t.id] = task(t);
  save(version, "tasks", { tasks, questItems: {}, achievements: {}, prestige: {} });

  const taskStrings: Record<string, string> = {};
  for (const t of opts.tasks) taskStrings[`${t.id} name`] = opts.taskNames[t.id] ?? t.id;
  save(version, "tasks_en", taskStrings);

  const items: Record<string, unknown> = {};
  const itemStrings: Record<string, string> = {};
  for (const id of opts.items) {
    items[id] = { id, name: `${id} Name`, shortName: `${id} ShortName`, types: [], basePrice: 100, buyFromTrader: [], sellToTrader: [] };
    itemStrings[`${id} Name`] = id.toUpperCase();
    itemStrings[`${id} ShortName`] = id;
  }
  save(version, "items", {
    items,
    fleaMarket: { enabled: true, minPlayerLevel: 15, foundInRaidRequired: false },
    playerLevels: [{ level: 1, exp: 0 }],
  });
  save(version, "items_en", itemStrings);

  save(version, "maps", { maps: {} });
  save(version, "maps_en", {});

  const traderLevels = Array.from({ length: opts.traderLevels }, (_, i) => ({
    level: i + 1,
    requiredPlayerLevel: i * 10,
    requiredReputation: 0,
    requiredCommerce: 0,
  }));
  save(version, "traders", { tr1: { id: "tr1", name: "tr1 Nickname", currency: "RUB", levels: traderLevels } });
  save(version, "traders_en", { "tr1 Nickname": "Prapor" });

  const stationLevels = Array.from({ length: opts.stationLevels }, (_, i) => ({
    level: i + 1,
    constructionTime: 0,
    itemRequirements: [],
  }));
  save(version, "hideout", { st1: { id: "st1", name: "st1 Name", levels: stationLevels } });
  save(version, "hideout_en", { "st1 Name": "Stash" });

  save(version, "barters", []);
  save(version, "crafts", []);
  writeFileSync(join(root, version, "manifest.json"), JSON.stringify({ version }));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tac-diff-fixtures-"));
  process.env["TAC_SNAPSHOT_DIR"] = root;

  writeVersion(FROM, {
    tasks: [
      { id: "t-keep", trader: "tr1", minPlayerLevel: 10, kappaRequired: true },
      { id: "t-rename", trader: "tr1" },
      { id: "t-gate", trader: "tr1", minPlayerLevel: 5, taskRequirements: [{ task: "t-keep", status: ["complete"] }] },
      { id: "t-removed", trader: "tr1", lightkeeperRequired: true },
      { id: "t-a", trader: "tr1" },
      { id: "t-b", trader: "tr1" },
    ],
    taskNames: {
      "t-keep": "Keep",
      "t-rename": "Original Name",
      "t-gate": "Gate",
      "t-removed": "Removed Task",
      "t-a": "Alpha",
      "t-b": "Bravo",
    },
    items: ["i-keep", "i-removed"],
    traderLevels: 2,
    stationLevels: 1,
  });

  writeVersion(TO, {
    tasks: [
      // kappaRequired flipped true->false (kappa count delta -1)
      { id: "t-keep", trader: "tr1", minPlayerLevel: 10, kappaRequired: false },
      { id: "t-rename", trader: "tr1" }, // resolved name changes via string table
      // minPlayerLevel 5->15 and prereq status widened
      { id: "t-gate", trader: "tr1", minPlayerLevel: 15, taskRequirements: [{ task: "t-keep", status: ["complete", "failed"] }] },
      { id: "t-added", trader: "tr1" }, // new task
      // cycle: t-a <-> t-b (invariant break on the target snapshot)
      { id: "t-a", trader: "tr1", taskRequirements: [{ task: "t-b", status: ["complete"] }] },
      { id: "t-b", trader: "tr1", taskRequirements: [{ task: "t-a", status: ["complete"] }] },
    ],
    taskNames: {
      "t-keep": "Keep",
      "t-rename": "Renamed Name",
      "t-gate": "Gate",
      "t-added": "Added Task",
      "t-a": "Alpha",
      "t-b": "Bravo",
    },
    items: ["i-keep", "i-added"],
    traderLevels: 3, // loyalty level added
    stationLevels: 2, // station level added
  });
});

afterAll(() => {
  delete process.env["TAC_SNAPSHOT_DIR"];
  rmSync(root, { recursive: true, force: true });
});

describe("snapshot diff (M1.2)", () => {
  it("names added and removed tasks", () => {
    const diff = diffSnapshots(FROM, TO);
    expect(diff.tasks.added.map((t) => t.id)).toEqual(["t-added"]);
    expect(diff.tasks.added[0]?.name).toBe("Added Task");
    expect(diff.tasks.removed.map((t) => t.id)).toEqual(["t-removed"]);
    expect(diff.tasks.removed[0]?.name).toBe("Removed Task");
  });

  it("detects renamed tasks (same id, new resolved name)", () => {
    const diff = diffSnapshots(FROM, TO);
    expect(diff.tasks.renamed).toEqual([{ id: "t-rename", from: "Original Name", to: "Renamed Name" }]);
  });

  it("reports gate / prereq / kappa field changes on a shared task", () => {
    const diff = diffSnapshots(FROM, TO);
    const gate = diff.tasks.changed.find((c) => c.id === "t-gate");
    expect(gate?.minPlayerLevel).toEqual({ from: 5, to: 15, delta: 10 });
    expect(gate?.prereqs?.added.length).toBe(1);
    expect(gate?.prereqs?.removed.length).toBe(1);

    const keep = diff.tasks.changed.find((c) => c.id === "t-keep");
    expect(keep?.kappaRequired).toEqual({ from: true, to: false });
  });

  it("reports count deltas (kappa -1, lightkeeper -1, tasks 0)", () => {
    const diff = diffSnapshots(FROM, TO);
    expect(diff.counts.tasks).toEqual({ from: 6, to: 6, delta: 0 });
    expect(diff.counts.kappa).toEqual({ from: 1, to: 0, delta: -1 });
    expect(diff.counts.lightkeeper).toEqual({ from: 1, to: 0, delta: -1 });
  });

  it("reports item / trader / hideout changes", () => {
    const diff = diffSnapshots(FROM, TO);
    expect(diff.items.added.map((i) => i.id)).toEqual(["i-added"]);
    expect(diff.items.removed.map((i) => i.id)).toEqual(["i-removed"]);
    expect(diff.traders.loyaltyLevelChanged.map((t) => t.id)).toEqual(["tr1"]);
    expect(diff.hideout.levelCountChanged.map((s) => s.id)).toEqual(["st1"]);
  });

  it("flags broken invariants on the target snapshot (t-a <-> t-b cycle)", () => {
    const diff = diffSnapshots(FROM, TO);
    expect(diff.invariants.ok).toBe(false);
    expect(diff.invariants.acyclic).toBe(false);
    expect(diff.invariants.cycle).toEqual(expect.arrayContaining(["t-a", "t-b"]));
    expect(diff.brokenInvariants.join(" ")).toMatch(/cycle/);
  });

  it("renders a deterministic human-readable summary", () => {
    const text = formatDiff(diffSnapshots(FROM, TO));
    expect(text).toContain(`${FROM}  ->  ${TO}`);
    expect(text).toContain("+ Added Task");
    expect(text).toContain("- Removed Task");
    expect(text).toContain("Original Name  ->  Renamed Name");
    expect(text).toContain("Invariants");
    expect(text).toMatch(/BROKEN/);
  });
});
