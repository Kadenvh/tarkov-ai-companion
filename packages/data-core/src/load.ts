import type { GameMode } from "@tac/shared";
import { latestSnapshot, loadRaw, loadStrings, tr, type SnapshotRef } from "./snapshot.js";
import { parseTasks } from "./tasks.js";
import { buildTaskGraph, type TaskGraph } from "./graph.js";

export interface LoadedWorld {
  ref: SnapshotRef;
  mode: GameMode;
  graph: TaskGraph;
  /** resolve a task's display name via the string table */
  taskName: (id: string) => string;
  /** resolve a map id to its display name (maps are also translation-keyed) */
  mapName: (id: string) => string;
  playerLevels: { level: number; exp: number }[];
}

/**
 * One-call world loader: builds the task graph with display names resolved and
 * exposes the XP curve. Names are written back onto each task so downstream
 * consumers (planner) can read `task.name` directly.
 */
export function loadWorld(mode: GameMode = "regular", ref: SnapshotRef = latestSnapshot()): LoadedWorld {
  const tasks = parseTasks(loadRaw(ref, mode, "tasks"));
  const strings = loadStrings(ref, mode, "tasks");
  for (const task of Object.values(tasks)) task.name = tr(strings, task.name);

  const graph = buildTaskGraph(tasks);
  const items = loadRaw(ref, mode, "items") as { playerLevels?: { level: number; exp: number }[] };

  const mapsRaw = loadRaw(ref, mode, "maps") as { maps: Record<string, { id: string; name: string }> };
  const mapStrings = loadStrings(ref, mode, "maps");
  const mapNames = new Map<string, string>();
  for (const m of Object.values(mapsRaw.maps ?? {})) mapNames.set(m.id, tr(mapStrings, m.name));

  return {
    ref,
    mode,
    graph,
    taskName: (id) => tasks[id]?.name ?? id,
    mapName: (id) => mapNames.get(id) ?? id,
    playerLevels: items.playerLevels ?? [],
  };
}
