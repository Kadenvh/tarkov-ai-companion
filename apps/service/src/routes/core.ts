import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { endingReachability } from "@tac/planner";
import { addCalibration, estimateXp, estimateLevelBand, worldXpSource } from "@tac/state-engine";
import type { StoryDataset } from "@tac/data-core";
import type { ProfileStore } from "@tac/state-engine";
import { saveConfig } from "../config.js";
import { UnknownProfileError, type ServiceRuntime } from "../runtime.js";

/** CONTRACTS §5.1 — core routes, plus the documented story-progress extension. */

const SelectBody = z.object({ profileKey: z.string() });

const ManualBody = z.object({
  level: z.number().int().min(1).max(79).optional(),
  faction: z.enum(["USEC", "BEAR"]).optional(),
  prestige: z.number().int().min(0).max(6).optional(),
  /** station id -> built level */
  hideout: z.record(z.string(), z.number().int().min(0)).optional(),
  /** trader id -> { level?, rep? } */
  traders: z
    .record(z.string(), z.object({ level: z.number().int().min(1).optional(), rep: z.number().optional() }))
    .optional(),
  /** task id -> { complete?, failed? } */
  tasks: z
    .record(z.string(), z.object({ complete: z.boolean().optional(), failed: z.boolean().optional() }))
    .optional(),
});

const ImportBody = z.object({ token: z.string().min(1) });

const StoryProgressBody = z.object({
  /** stage id -> done */
  stages: z.record(z.string(), z.boolean()).optional(),
  /** decision id -> chosen option id */
  decisions: z.record(z.string(), z.string()).optional(),
});

export interface StoryProgress {
  stages: Record<string, boolean>;
  decisions: Record<string, string>;
}

export function storyProgressOf(store: ProfileStore): StoryProgress {
  const raw = store.getMeta("storyProgress");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<StoryProgress>;
      return { stages: parsed.stages ?? {}, decisions: parsed.decisions ?? {} };
    } catch {
      // fall through
    }
  }
  return { stages: {}, decisions: {} };
}

/**
 * Bridge the story dataset's decision shape (zod-optional fields are
 * `T | undefined` under exactOptionalPropertyTypes) to the planner's
 * `StoryDecisionLike` input, which uses plain optional properties.
 */
export function decisionsForReachability(dataset: StoryDataset) {
  return dataset.decisions.map((d) => ({
    id: d.id,
    options: d.options.map((o) => ({
      id: o.id,
      effects: {
        ...(o.effects.locksEndings !== undefined ? { locksEndings: o.effects.locksEndings } : {}),
        ...(o.effects.setsOnlyEnding !== undefined ? { setsOnlyEnding: o.effects.setsOnlyEnding } : {}),
      },
    })),
  }));
}

export function chapterStatuses(dataset: StoryDataset, progress: StoryProgress) {
  return dataset.chapters.map((chapter) => {
    const required = chapter.stages.filter((s) => !s.optional);
    const done = required.filter((s) => progress.stages[s.id]).length;
    const anyDone = chapter.stages.some((s) => progress.stages[s.id]);
    const status: "complete" | "in-progress" | "not-started" =
      required.length > 0 && done === required.length ? "complete" : anyDone ? "in-progress" : "not-started";
    return {
      chapterId: chapter.id,
      name: chapter.name,
      order: chapter.order,
      status,
      stagesComplete: done,
      stagesTotal: required.length,
      optionalStagesTotal: chapter.stages.length - required.length,
    };
  });
}

export function registerCoreRoutes(app: FastifyInstance, rt: ServiceRuntime): void {
  app.get("/api/health", async () => {
    const gameVersion = rt.gameVersion();
    const snapshotVersion = rt.snapshotVersion();
    return {
      ok: true,
      version: rt.version,
      snapshotVersion,
      profileKey: rt.store.profileKey,
      gameMode: rt.gameMode,
      // M8.2 patch sentinel: mismatch between the installed game and the data snapshot
      gameVersion,
      patchDetected: gameVersion !== null && gameVersion !== snapshotVersion,
      // M2.7 mirror status (null = no TarkovTracker token configured)
      trackerSync: rt.mirrorStatus(),
    };
  });

  app.get("/api/profiles", async () => ({
    profiles: rt.config.profiles,
    activeProfile: rt.config.activeProfile,
  }));

  app.post("/api/profiles/select", async (req, reply) => {
    const body = SelectBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0]?.message ?? "invalid body" });
    try {
      const entry = await rt.selectProfile(body.data.profileKey);
      return { ok: true, profileKey: entry.key, gameMode: entry.gameMode };
    } catch (err) {
      if (err instanceof UnknownProfileError) return reply.status(404).send({ error: err.message });
      throw err;
    }
  });

  app.get("/api/state", async () => {
    const store = rt.store;
    const world = rt.world();
    const estimate = estimateXp(store, worldXpSource(world));
    const tasks = store.getTasks();
    return {
      profileKey: store.profileKey,
      gameMode: store.gameMode,
      level: store.level,
      faction: store.faction,
      prestige: store.prestige,
      progressEpoch: store.progressEpoch,
      xp: { ...estimate, levelBand: estimateLevelBand(estimate, worldXpSource(world)) },
      tasks,
      objectives: store.getObjectives(),
      hideout: store.getHideout(),
      traders: store.getTraders(),
      counts: {
        tasksCompleted: tasks.filter((t) => t.complete).length,
        tasksFailed: tasks.filter((t) => t.failed && !t.complete).length,
      },
    };
  });

  app.post("/api/state/manual", async (req, reply) => {
    const body = ManualBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0]?.message ?? "invalid body" });
    const store = rt.store;
    const patch = body.data;
    if (patch.level !== undefined) {
      store.setLevel(patch.level);
      // a user-stated level is an XP calibration anchor (M2.5/M2.6)
      addCalibration(store, "level", patch.level);
    }
    if (patch.faction !== undefined) store.setFaction(patch.faction);
    if (patch.prestige !== undefined) store.setPrestige(patch.prestige);
    for (const [stationId, level] of Object.entries(patch.hideout ?? {})) store.setHideoutLevel(stationId, level);
    for (const [traderId, t] of Object.entries(patch.traders ?? {})) {
      store.setTraderState(traderId, {
        ...(t.level !== undefined ? { level: t.level } : {}),
        ...(t.rep !== undefined ? { rep: t.rep } : {}),
      });
    }
    for (const [taskId, t] of Object.entries(patch.tasks ?? {})) {
      store.setTaskState(taskId, {
        ...(t.complete !== undefined ? { complete: t.complete } : {}),
        ...(t.failed !== undefined ? { failed: t.failed } : {}),
      });
    }
    return { ok: true, level: store.level, faction: store.faction, prestige: store.prestige };
  });

  // Connect a token, then pull the first sync. Folds into the single sync path
  // (M10 progress-read source → change-aware mapper) rather than fetching itself.
  app.post("/api/state/import/tarkovtracker", async (req, reply) => {
    const body = ImportBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0]?.message ?? "invalid body" });

    rt.config.tarkovTrackerToken = body.data.token;
    saveConfig(rt.config, rt.dataDir);
    rt.rebuildSources(); // the read feed must authenticate with the NEW token
    rt.restartMirror();
    rt.restartTrackerSync(); // scheduled read feed from now on (SPEC-8)

    const result = await rt.syncTarkovTracker();
    if (!result.ok) {
      if (result.reason === "unauthorized") {
        return reply.status(401).send({ error: "TarkovTracker rejected the token (401)" });
      }
      if (result.reason === "quota-exhausted") {
        return reply.status(429).send({ error: "TarkovTracker read quota exhausted", ...(result.quota ? { quota: result.quota } : {}) });
      }
      return reply.status(502).send({ error: result.error ?? "TarkovTracker API unreachable" });
    }
    const progress = result.progress;
    return {
      ok: true,
      tasks: progress?.tasksProgress?.length ?? 0,
      objectives: progress?.taskObjectivesProgress?.length ?? 0,
      hideoutModules: progress?.hideoutModulesProgress?.length ?? 0,
      level: progress?.playerLevel ?? null,
      applied: result.applied,
    };
  });

  // On-demand read sync (SPEC-8): pull the latest progress FROM TarkovTracker
  // into the local store. Read-only; 409 when no token is connected.
  app.post("/api/state/sync/tarkovtracker", async (_req, reply) => {
    if (!rt.config.tarkovTrackerToken) {
      return reply.status(409).send({ error: "TarkovTracker not connected — add a token in Settings" });
    }
    const result = await rt.syncTarkovTracker();
    if (!result.ok) {
      if (result.reason === "unauthorized") {
        return reply.status(401).send({ error: "TarkovTracker rejected the token (401)" });
      }
      if (result.reason === "quota-exhausted" || result.reason === "quota-low") {
        return reply
          .status(429)
          .send({ error: "TarkovTracker read quota exhausted", ...(result.quota ? { quota: result.quota } : {}) });
      }
      return reply.status(502).send({ error: result.error ?? "TarkovTracker sync failed" });
    }
    return {
      ok: true,
      applied: result.applied,
      changed: result.changed,
      fromCache: result.fromCache ?? false,
      ...(result.quota ? { quota: result.quota } : {}),
    };
  });

  // On-demand log pull (two-PC pull model). Drives ONE watcher cycle over the
  // configured logs dir (e.g. hero's Tailscale-shared Logs) — cursor-based, so
  // only new lines are ingested, and nothing polls in the background. Wired to
  // the UI "Sync logs" button and a Stream Deck key.
  app.post("/api/sync", async () => {
    const summary = rt.syncOnce();
    return { ok: true, lastSyncAt: rt.lastSyncAt, logsDir: rt.logsDir(), ...summary };
  });

  app.get("/api/story", async (_req, reply) => {
    const dataset = rt.story();
    if (!dataset) return reply.status(404).send({ error: "story dataset not found (data/story/story.json)" });
    const progress = storyProgressOf(rt.store);
    return {
      dataset,
      player: {
        chapters: chapterStatuses(dataset, progress),
        decisions: progress.decisions,
        stages: progress.stages,
        endings: endingReachability(
          dataset.endings.map((e) => e.id),
          decisionsForReachability(dataset),
          progress.decisions,
        ),
      },
    };
  });

  // Documented extension (SPEC-6): persist story tracker progress (web Goals view).
  app.post("/api/story/progress", async (req, reply) => {
    const body = StoryProgressBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0]?.message ?? "invalid body" });
    const current = storyProgressOf(rt.store);
    const next: StoryProgress = {
      stages: { ...current.stages, ...(body.data.stages ?? {}) },
      decisions: { ...current.decisions, ...(body.data.decisions ?? {}) },
    };
    rt.store.setMeta("storyProgress", JSON.stringify(next), "story");
    return { ok: true, ...next };
  });

  app.get("/api/graph/summary", async () => {
    const graph = rt.world().graph;
    const tasks = Object.values(graph.tasks);
    const completed = new Set(
      rt.store
        .getTasks()
        .filter((t) => t.complete)
        .map((t) => t.taskId),
    );
    const kappa = tasks.filter((t) => t.kappaRequired);
    const lightkeeper = tasks.filter((t) => t.lightkeeperRequired);
    return {
      totalTasks: tasks.length,
      completedTasks: tasks.filter((t) => completed.has(t.id)).length,
      kappa: { required: kappa.length, remaining: kappa.filter((t) => !completed.has(t.id)).length },
      lightkeeper: {
        required: lightkeeper.length,
        remaining: lightkeeper.filter((t) => !completed.has(t.id)).length,
      },
      snapshotVersion: rt.snapshotVersion(),
    };
  });
}
