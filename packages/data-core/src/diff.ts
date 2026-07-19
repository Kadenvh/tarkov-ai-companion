import type { GameMode } from "@tac/shared";
import { loadWorld, type LoadedWorld } from "./load.js";
import { loadMarket, type Market } from "./market.js";
import { snapshotRef } from "./snapshot.js";
import { checkInvariants, type InvariantReport } from "./invariants.js";
import type { Task } from "./tasks.js";

/**
 * Snapshot diff (M1.2). Reports the STRUCTURAL delta between two per-patch
 * snapshots so a new EFT version surfaces as a reviewable change list rather
 * than silent breakage (the M8.2 "survive the next patch without a human"
 * filter).
 *
 * The diff is deterministic — every list is sorted by id/name — and operates on
 * already-loaded worlds/markets ({@link diffWorlds}) so it is testable without
 * touching the filesystem; {@link diffSnapshots} is the on-disk wiring.
 *
 * @tier T0 — pure analysis of committed snapshot data; never touches the game.
 */

export interface TaskRef {
  id: string;
  name: string;
}

export interface CountDelta {
  from: number;
  to: number;
  delta: number;
}

/** Added/removed entries for an id-keyed collection (items/traders/stations). */
export interface CollectionDelta {
  total: CountDelta;
  added: TaskRef[];
  removed: TaskRef[];
}

/** Per-task field-level change (only fields that actually differ are present). */
export interface TaskFieldChange {
  id: string;
  name: string;
  /** human-readable one-liners describing every change on this task */
  changes: string[];
  prereqs?: { added: string[]; removed: string[] };
  failConditions?: { added: string[]; removed: string[] };
  minPlayerLevel?: CountDelta;
  kappaRequired?: { from: boolean; to: boolean };
  lightkeeperRequired?: { from: boolean; to: boolean };
  factionName?: { from: string | null; to: string | null };
  map?: { from: string | null; to: string | null };
  traderRequirementCount?: CountDelta;
}

export interface SnapshotDiff {
  fromVersion: string;
  toVersion: string;
  mode: GameMode;
  tasks: {
    added: TaskRef[];
    removed: TaskRef[];
    renamed: { id: string; from: string; to: string }[];
    changed: TaskFieldChange[];
  };
  counts: {
    tasks: CountDelta;
    kappa: CountDelta;
    lightkeeper: CountDelta;
  };
  items: CollectionDelta;
  traders: CollectionDelta & { loyaltyLevelChanged: TaskRef[] };
  hideout: CollectionDelta & { levelCountChanged: TaskRef[] };
  /** invariants of the TARGET ("to") snapshot — the world we're about to trust */
  invariants: InvariantReport;
  /** convenience mirror of `invariants.broken` for a quick go/no-go read */
  brokenInvariants: string[];
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const delta = (from: number, to: number): CountDelta => ({ from, to, delta: to - from });

/** Canonical string form of a task's prerequisite set: `taskId:status+status`. */
function prereqKeys(task: Task, name: (id: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of task.taskRequirements) {
    out.set(`${r.task}:${[...r.status].sort().join("+")}`, `${name(r.task)} [${[...r.status].sort().join(",")}]`);
  }
  return out;
}

/** Canonical string form of a task's taskStatus fail-conditions. */
function failKeys(task: Task, name: (id: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  for (const fc of task.failConditions ?? []) {
    if (fc.type === "taskStatus" && fc.task) {
      out.set(`${fc.task}:${[...(fc.status ?? [])].sort().join("+")}`, name(fc.task));
    }
  }
  return out;
}

function setDelta(from: Map<string, string>, to: Map<string, string>): { added: string[]; removed: string[] } {
  const added = [...to].filter(([k]) => !from.has(k)).map(([, v]) => v).sort();
  const removed = [...from].filter(([k]) => !to.has(k)).map(([, v]) => v).sort();
  return { added, removed };
}

function diffTask(
  id: string,
  a: Task,
  b: Task,
  nameA: (id: string) => string,
  nameB: (id: string) => string,
): TaskFieldChange | null {
  const changes: string[] = [];
  const change: TaskFieldChange = { id, name: b.name, changes };

  const prereqs = setDelta(prereqKeys(a, nameA), prereqKeys(b, nameB));
  if (prereqs.added.length || prereqs.removed.length) {
    change.prereqs = prereqs;
    if (prereqs.added.length) changes.push(`prereqs +${prereqs.added.length}: ${prereqs.added.join("; ")}`);
    if (prereqs.removed.length) changes.push(`prereqs -${prereqs.removed.length}: ${prereqs.removed.join("; ")}`);
  }

  const fails = setDelta(failKeys(a, nameA), failKeys(b, nameB));
  if (fails.added.length || fails.removed.length) {
    change.failConditions = fails;
    if (fails.added.length) changes.push(`failConditions +${fails.added.length}: ${fails.added.join("; ")}`);
    if (fails.removed.length) changes.push(`failConditions -${fails.removed.length}: ${fails.removed.join("; ")}`);
  }

  const lvlA = a.minPlayerLevel ?? 0;
  const lvlB = b.minPlayerLevel ?? 0;
  if (lvlA !== lvlB) {
    change.minPlayerLevel = delta(lvlA, lvlB);
    changes.push(`minPlayerLevel ${lvlA} -> ${lvlB}`);
  }

  const kappaA = a.kappaRequired ?? false;
  const kappaB = b.kappaRequired ?? false;
  if (kappaA !== kappaB) {
    change.kappaRequired = { from: kappaA, to: kappaB };
    changes.push(`kappaRequired ${kappaA} -> ${kappaB}`);
  }

  const lkA = a.lightkeeperRequired ?? false;
  const lkB = b.lightkeeperRequired ?? false;
  if (lkA !== lkB) {
    change.lightkeeperRequired = { from: lkA, to: lkB };
    changes.push(`lightkeeperRequired ${lkA} -> ${lkB}`);
  }

  const facA = a.factionName ?? null;
  const facB = b.factionName ?? null;
  if (facA !== facB) {
    change.factionName = { from: facA, to: facB };
    changes.push(`faction ${facA ?? "Any"} -> ${facB ?? "Any"}`);
  }

  const mapA = a.map ?? null;
  const mapB = b.map ?? null;
  if (mapA !== mapB) {
    change.map = { from: mapA, to: mapB };
    changes.push(`map ${mapA ?? "none"} -> ${mapB ?? "none"}`);
  }

  const trA = a.traderRequirements.length;
  const trB = b.traderRequirements.length;
  if (trA !== trB) {
    change.traderRequirementCount = delta(trA, trB);
    changes.push(`traderRequirements ${trA} -> ${trB}`);
  }

  return changes.length > 0 ? change : null;
}

export interface DiffSide {
  world: LoadedWorld;
  market: Market;
}

/** Pure diff over two already-loaded snapshot sides (filesystem-free, fully deterministic). */
export function diffWorlds(from: DiffSide, to: DiffSide): SnapshotDiff {
  const aTasks = from.world.graph.tasks;
  const bTasks = to.world.graph.tasks;
  const nameA = (id: string) => aTasks[id]?.name ?? from.market.itemName(id);
  const nameB = (id: string) => bTasks[id]?.name ?? to.market.itemName(id);

  const added: TaskRef[] = [];
  const removed: TaskRef[] = [];
  const renamed: { id: string; from: string; to: string }[] = [];
  const changed: TaskFieldChange[] = [];

  for (const [id, b] of Object.entries(bTasks)) {
    const a = aTasks[id];
    if (!a) {
      added.push({ id, name: b.name });
      continue;
    }
    if (a.name !== b.name) renamed.push({ id, from: a.name, to: b.name });
    const c = diffTask(id, a, b, nameA, nameB);
    if (c) changed.push(c);
  }
  for (const [id, a] of Object.entries(aTasks)) {
    if (!bTasks[id]) removed.push({ id, name: a.name });
  }

  added.sort(byId);
  removed.sort(byId);
  renamed.sort(byId);
  changed.sort(byId);

  const collectionDelta = (
    a: Record<string, { id: string; name: string }>,
    b: Record<string, { id: string; name: string }>,
  ): CollectionDelta => {
    const addedC: TaskRef[] = [];
    const removedC: TaskRef[] = [];
    for (const [id, v] of Object.entries(b)) if (!a[id]) addedC.push({ id, name: v.name });
    for (const [id, v] of Object.entries(a)) if (!b[id]) removedC.push({ id, name: v.name });
    return {
      total: delta(Object.keys(a).length, Object.keys(b).length),
      added: addedC.sort(byId),
      removed: removedC.sort(byId),
    };
  };

  const traders = {
    ...collectionDelta(from.market.traders, to.market.traders),
    loyaltyLevelChanged: [] as TaskRef[],
  };
  for (const [id, tb] of Object.entries(to.market.traders)) {
    const ta = from.market.traders[id];
    if (ta && ta.levels.length !== tb.levels.length) traders.loyaltyLevelChanged.push({ id, name: tb.name });
  }
  traders.loyaltyLevelChanged.sort(byId);

  const hideout = {
    ...collectionDelta(from.market.stations, to.market.stations),
    levelCountChanged: [] as TaskRef[],
  };
  for (const [id, sb] of Object.entries(to.market.stations)) {
    const sa = from.market.stations[id];
    if (sa && sa.levels.length !== sb.levels.length) hideout.levelCountChanged.push({ id, name: sb.name });
  }
  hideout.levelCountChanged.sort(byId);

  const kappaFrom = Object.values(aTasks).filter((t) => t.kappaRequired).length;
  const kappaTo = Object.values(bTasks).filter((t) => t.kappaRequired).length;
  const lkFrom = Object.values(aTasks).filter((t) => t.lightkeeperRequired).length;
  const lkTo = Object.values(bTasks).filter((t) => t.lightkeeperRequired).length;

  const invariants = checkInvariants(to.world);

  return {
    fromVersion: from.world.ref.version,
    toVersion: to.world.ref.version,
    mode: to.world.mode,
    tasks: { added, removed, renamed, changed },
    counts: {
      tasks: delta(Object.keys(aTasks).length, Object.keys(bTasks).length),
      kappa: delta(kappaFrom, kappaTo),
      lightkeeper: delta(lkFrom, lkTo),
    },
    items: collectionDelta(from.market.items, to.market.items),
    traders,
    hideout,
    invariants,
    brokenInvariants: invariants.broken,
  };
}

/** Load two on-disk snapshots and diff them (honors TAC_SNAPSHOT_DIR via the loaders). */
export function diffSnapshots(fromVersion: string, toVersion: string, mode: GameMode = "regular"): SnapshotDiff {
  const from: DiffSide = {
    world: loadWorld(mode, snapshotRef(fromVersion)),
    market: loadMarket(mode, snapshotRef(fromVersion)),
  };
  const to: DiffSide = {
    world: loadWorld(mode, snapshotRef(toVersion)),
    market: loadMarket(mode, snapshotRef(toVersion)),
  };
  return diffWorlds(from, to);
}

/** Render a human-readable summary of a diff (the CLI's non-`--json` output). */
export function formatDiff(diff: SnapshotDiff): string {
  const lines: string[] = [];
  const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  const c = (d: CountDelta) => `${d.from} -> ${d.to} (${sign(d.delta)})`;

  lines.push(`Snapshot diff  ${diff.fromVersion}  ->  ${diff.toVersion}   [${diff.mode}]`);
  lines.push("");
  lines.push("Counts");
  lines.push(`  tasks         ${c(diff.counts.tasks)}`);
  lines.push(`  kappa         ${c(diff.counts.kappa)}`);
  lines.push(`  lightkeeper   ${c(diff.counts.lightkeeper)}`);
  lines.push("");

  lines.push(`Tasks added (${diff.tasks.added.length})`);
  for (const t of diff.tasks.added) lines.push(`  + ${t.name}  (${t.id})`);
  lines.push(`Tasks removed (${diff.tasks.removed.length})`);
  for (const t of diff.tasks.removed) lines.push(`  - ${t.name}  (${t.id})`);
  lines.push(`Tasks renamed (${diff.tasks.renamed.length})`);
  for (const t of diff.tasks.renamed) lines.push(`  ~ ${t.from}  ->  ${t.to}  (${t.id})`);
  lines.push(`Tasks changed (${diff.tasks.changed.length})`);
  for (const t of diff.tasks.changed) {
    lines.push(`  * ${t.name}  (${t.id})`);
    for (const ch of t.changes) lines.push(`      ${ch}`);
  }
  lines.push("");

  lines.push("Market");
  lines.push(`  items         ${c(diff.items.total)}  (+${diff.items.added.length} / -${diff.items.removed.length})`);
  lines.push(
    `  traders       ${c(diff.traders.total)}  (loyalty changed: ${diff.traders.loyaltyLevelChanged.length})`,
  );
  lines.push(
    `  hideout       ${c(diff.hideout.total)}  (levels changed: ${diff.hideout.levelCountChanged.length})`,
  );
  lines.push("");

  lines.push(`Invariants (${diff.toVersion}): ${diff.invariants.ok ? "OK" : "BROKEN"}`);
  lines.push(`  acyclic=${diff.invariants.acyclic}  branchOnly=${diff.invariants.branchOnlyCount}  exclusivitySets=${diff.invariants.exclusivitySetCount}`);
  for (const b of diff.brokenInvariants) lines.push(`  !! ${b}`);

  return lines.join("\n");
}
