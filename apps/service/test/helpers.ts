import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { loadWorld, loadMarket, type LoadedWorld, type Market } from "@tac/data-core";
import { buildApp, type BuildAppOptions } from "../src/app.js";

/**
 * Test harness: apps are built with buildApp() + inject(), an in-memory
 * profile DB, a temp data dir, and every environment touchpoint injected.
 * The real snapshot world on disk is used (read-only, fast enough); watchers
 * are never started (watch defaults to false; TAC_NO_WATCH set for safety).
 * Nothing here touches the real EFT install, Documents, or data/local.
 */

process.env["TAC_NO_WATCH"] = "1";

let world: LoadedWorld | null = null;
let market: Market | null = null;

/** Real on-disk snapshot world (regular mode), loaded once per test file. */
export function testWorld(): LoadedWorld {
  return (world ??= loadWorld("regular"));
}

export function testMarket(): Market {
  return (market ??= loadMarket("regular"));
}

export function tempDir(prefix = "tac-service-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A local port nothing listens on — forces ECONNREFUSED for proxy tests. */
export const DEAD_AGENT_URL = "http://127.0.0.1:59991";

const openApps: FastifyInstance[] = [];

export async function testApp(opts: Partial<BuildAppOptions> = {}): Promise<FastifyInstance> {
  const w = testWorld();
  const app = await buildApp({
    dataDir: tempDir(),
    memoryDb: true,
    world: w,
    market: testMarket(),
    loadWorldFn: () => w,
    loadMarketFn: () => testMarket(),
    isGameRunning: () => false,
    agentUrl: DEAD_AGENT_URL,
    // point at an empty dir so a real apps/web/dist never leaks into tests
    staticDir: tempDir("tac-nostatic-"),
    ...opts,
  });
  openApps.push(app);
  return app;
}

export async function closeApps(): Promise<void> {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
}

/** Minimal EFT settings dir (JSON-in-.ini, like the game writes) that diffs against every profile. */
export function writeSettingsFixture(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "Graphics.ini"),
    JSON.stringify(
      {
        VSync: true,
        NVidiaReflex: "Off",
        ShadowsQuality: 3,
        CloudsQuality: "High",
        OverallVisibility: 3000,
        LodBias: 4,
        ShadowDistance: 100,
        Ssao: "On",
        SSR: "On",
        AntiAliasing: "TAA_High",
        Sharpen: 0,
        GrassShadow: true,
        ChromaticAberrations: true,
        Noise: true,
        ZBlur: true,
        HighQualityFog: true,
        HighQualityColor: true,
        VolumetricLight: "High",
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, "Game.ini"),
    JSON.stringify({ FieldOfView: 65, AutoEmptyWorkingSet: false, SetAffinityToLogicalCores: false }, null, 2),
  );
  writeFileSync(
    join(dir, "PostFx.ini"),
    JSON.stringify({ EnablePostFx: true, Clarity: 0, LumaSharpen: 0 }, null, 2),
  );
}

/** PresentMon v1-style CSV: 3 EFT frames + 1 foreign process row. */
export const PRESENTMON_CSV = [
  "Application,ProcessID,Dropped,MsBetweenPresents",
  "EscapeFromTarkov.exe,1,0,8.0",
  "EscapeFromTarkov.exe,1,0,8.5",
  "EscapeFromTarkov.exe,1,0,9.0",
  "dwm.exe,2,0,16.7",
  "",
].join("\n");

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
