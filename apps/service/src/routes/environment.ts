import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  PROFILES,
  getProfile,
  applyProfile,
  auditConfig,
  diffAllProfiles,
  loadEftSettings,
  nvidiaReport,
  parsePresentMonCsv,
  summarizeRun,
  toPerfSampleRow,
  detectRegression,
  buildAmmoTable,
  ammoByCaliber,
  GameRunningError,
  type AmmoEntry,
  type RecommendationProfile,
} from "@tac/environment";
import type { GameMode } from "@tac/shared";
import type { ServiceRuntime } from "../runtime.js";

/**
 * CONTRACTS §5.4 — environment routes, plus the documented PresentMon-import
 * extension. Settings apply is T1-write: game-closed guard (409 when running),
 * timestamped backup before any write — all enforced inside @tac/environment.
 */

const ApplyBody = z.object({
  profile: z.enum(["max-fps", "balanced", "max-visibility", "meta"]),
  /**
   * Optional subset filter (Config Audit "one-click Apply"): apply only these
   * flat keys of the named profile. Reuses the same game-closed / backup-first
   * applyProfile path — just a narrower profile.
   */
  keys: z.array(z.string()).optional(),
});

const PerfImportBody = z
  .object({
    /** raw PresentMon CSV text… */
    csv: z.string().min(1).optional(),
    /** …or a path to one on disk (read-only) */
    path: z.string().min(1).optional(),
    map: z.string().nullish(),
    raidId: z.number().int().nullish(),
    ts: z.string().optional(),
  })
  .refine((b) => b.csv !== undefined || b.path !== undefined, { message: "provide `csv` or `path`" });

interface PerfSampleDbRow {
  map: string | null;
  ts: string;
  fps_avg: number | null;
  fps_p1: number | null;
  frametime_p50: number | null;
  frametime_p95: number | null;
  frametime_p99: number | null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function registerEnvironmentRoutes(app: FastifyInstance, rt: ServiceRuntime): void {
  const ammoCache = new Map<GameMode, AmmoEntry[]>();

  const loadSettings = () => (rt.settingsDir ? loadEftSettings(rt.settingsDir) : loadEftSettings());

  app.get("/api/environment/settings", async (_req, reply) => {
    let settings;
    try {
      settings = loadSettings();
    } catch (err) {
      return reply.status(500).send({ error: `failed to read EFT settings: ${(err as Error).message}` });
    }
    return {
      dir: settings.dir,
      present: settings.present,
      diffs: diffAllProfiles(settings),
      profiles: PROFILES.map((p: RecommendationProfile) => ({
        key: p.key,
        name: p.name,
        description: p.description,
      })),
      // Coach Config Audit + ADS 1:1 helper (meta divergences, on-meta green
      // checks, and the mouse-sensitivity 1:1 readout). Degrades to empty
      // arrays / undefined fields when files are missing.
      audit: auditConfig(settings),
    };
  });

  app.post("/api/environment/settings/apply", async (req, reply) => {
    const body = ApplyBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0]?.message ?? "invalid body" });
    try {
      const base = getProfile(body.data.profile);
      const keys = body.data.keys;
      const profile =
        keys && keys.length > 0
          ? { ...base, settings: base.settings.filter((s) => keys.includes(s.key)) }
          : base;
      const result = await applyProfile(profile, {
        isGameRunning: rt.isGameRunning,
        backupDir: rt.backupDir,
        ...(rt.settingsDir ? { settingsDir: rt.settingsDir } : {}),
      });
      return { ok: true, profile: body.data.profile, backupId: result.backupId, applied: result.applied };
    } catch (err) {
      if (err instanceof GameRunningError) return reply.status(409).send({ error: err.message });
      throw err;
    }
  });

  app.get("/api/environment/nvidia", async () => {
    return rt.nvidiaRunner ? nvidiaReport(rt.nvidiaRunner) : nvidiaReport();
  });

  app.get("/api/environment/perf", async () => {
    const rows = rt.store.db
      .prepare(
        `SELECT map, ts, fps_avg, fps_p1, frametime_p50, frametime_p95, frametime_p99
         FROM perf_samples ORDER BY ts ASC, id ASC`,
      )
      .all() as unknown as PerfSampleDbRow[];

    const byMap = new Map<string, PerfSampleDbRow[]>();
    for (const row of rows) {
      const key = row.map ?? "unknown";
      byMap.set(key, [...(byMap.get(key) ?? []), row]);
    }

    const maps = [...byMap.entries()].map(([map, samples]) => {
      const latest = samples[samples.length - 1]!;
      const prior = samples.slice(0, -1);
      const baseline =
        prior.length > 0
          ? {
              fps_avg: median(prior.map((s) => s.fps_avg ?? 0)) ?? 0,
              fps_p1: median(prior.map((s) => s.fps_p1 ?? 0)) ?? 0,
            }
          : null;
      return {
        map,
        n: samples.length,
        latest,
        baseline,
        regression: baseline
          ? detectRegression({ fps_avg: latest.fps_avg ?? 0, fps_p1: latest.fps_p1 ?? 0 }, baseline)
          : null,
      };
    });

    return { samples: rows.length, maps };
  });

  // Documented extension (SPEC-6): PresentMon CSV ingest -> perf_samples row (M6.3).
  app.post("/api/environment/perf/import", async (req, reply) => {
    const body = PerfImportBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0]?.message ?? "invalid body" });
    // Defense-in-depth on the {path} form: this is an unauthenticated local API,
    // so never let it become an arbitrary-file-read primitive — only .csv files.
    if (body.data.path !== undefined && !body.data.path.toLowerCase().endsWith(".csv")) {
      return reply.status(400).send({ error: "path must point to a .csv file (PresentMon capture)" });
    }
    let csv: string;
    try {
      csv = body.data.csv ?? readFileSync(body.data.path!, "utf8");
    } catch (err) {
      return reply.status(400).send({ error: `cannot read CSV: ${(err as Error).message}` });
    }
    let frametimes: number[];
    try {
      frametimes = parsePresentMonCsv(csv);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
    if (frametimes.length === 0) {
      return reply.status(400).send({ error: "no EscapeFromTarkov.exe frames found in the CSV" });
    }
    const summary = summarizeRun(frametimes);
    const row = toPerfSampleRow(summary, {
      ts: body.data.ts ?? new Date().toISOString(),
      map: body.data.map ?? null,
      raidId: body.data.raidId ?? null,
    });
    rt.store.db
      .prepare(
        `INSERT INTO perf_samples (raid_id, map, ts, fps_avg, fps_p1, frametime_p50, frametime_p95, frametime_p99, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.raid_id,
        row.map,
        row.ts,
        row.fps_avg,
        row.fps_p1,
        row.frametime_p50,
        row.frametime_p95,
        row.frametime_p99,
        row.source,
      );
    return { ok: true, frames: summary.frameCount, row };
  });

  app.get("/api/environment/ammo", async (req) => {
    const mode = rt.gameMode;
    let table = ammoCache.get(mode);
    if (!table) {
      table = buildAmmoTable(mode, rt.world().ref);
      ammoCache.set(mode, table);
    }
    const caliber = (req.query as Record<string, unknown>)["caliber"];
    const entries = typeof caliber === "string" && caliber.length > 0 ? ammoByCaliber(table, caliber) : table;
    return { caliber: typeof caliber === "string" ? caliber : null, count: entries.length, ammo: entries };
  });
}
