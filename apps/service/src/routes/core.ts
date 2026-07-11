import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { endingReachability } from "@tac/planner";
import { addCalibration, estimateXp, estimateLevelBand, worldXpSource, TRACKER_BASE_URL } from "@tac/state-engine";
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

  app.post("/api/state/import/tarkovtracker", async (req, reply) => {
    const body = ImportBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0]?.message ?? "invalid body" });
    let res: Response;
    try {
      res = await rt.fetchImpl(`${TRACKER_BASE_URL}/progress`, {
        headers: { Authorization: `Bearer ${body.data.token}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return reply.status(502).send({ error: "TarkovTracker API unreachable" });
    }
    if (!res.ok) {
      return reply
        .status(res.status === 401 ? 401 : 502)
        .send({ error: `TarkovTracker returned ${res.status}` });
    }
    const progress = rt.store.importTarkovTracker(await res.json());
    rt.config.tarkovTrackerToken = body.data.token;
    saveConfig(rt.config, rt.dataDir);
    return {
      ok: true,
      tasks: progress.tasksProgress.length,
      objectives: progress.taskObjectivesProgress.length,
      hideoutModules: progress.hideoutModulesProgress.length,
      level: progress.playerLevel ?? null,
    };
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
