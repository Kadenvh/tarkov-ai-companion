/**
 * @tier T1 (passive read of game-written files; the paired writer lives in
 * apply.ts and is T1-write: game-closed only, backup first).
 *
 * EFT settings model. The five files under
 * `%APPDATA%\Battlestate Games\Escape from Tarkov\Settings\` are plain JSON
 * despite the `.ini` extension (docs/research/06-environment-paths.md §1).
 * Schemas are deliberately loose (`passthrough`, everything optional): BSG
 * adds/renames keys across patches and a missing field must never crash the
 * advisor. We only *type* the fields the advisor reasons about.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defaultSettingsDir } from "./paths.js";

export const SETTINGS_FILES = ["Graphics", "Game", "PostFx", "Sound", "Control"] as const;
export type SettingsFileName = (typeof SETTINGS_FILES)[number];

/** Graphics.ini — perf-critical knobs (resolution/quality/upscaling/frame caps). */
export const GraphicsSettings = z
  .object({
    VSync: z.boolean(),
    GameFramerate: z.number(),
    LobbyFramerate: z.number(),
    DisableGameFramerateLimit: z.boolean(),
    TextureQuality: z.number(),
    ShadowsQuality: z.number(),
    CloudsQuality: z.string(),
    SuperSampling: z.string(),
    SuperSamplingFactor: z.number(),
    AnisotropicFiltering: z.string(),
    OverallVisibility: z.number(),
    LodBias: z.number(),
    ShadowDistance: z.number(),
    Ssao: z.string(),
    SSR: z.string(),
    AntiAliasing: z.string(),
    NVidiaReflex: z.string(),
    Sharpen: z.number(),
    HighQualityFog: z.boolean(),
    GrassShadow: z.boolean(),
    ChromaticAberrations: z.boolean(),
    Noise: z.boolean(),
    ZBlur: z.boolean(),
    HighQualityColor: z.boolean(),
    VolumetricLight: z.string(),
    DLSSMode: z.string(),
    DLSSPreset: z.string(),
    FSR2Mode: z.string(),
    FSR3Mode: z.string(),
    MipStreamingBufferSize: z.number(),
    MipStreamingIOCount: z.number(),
  })
  .partial()
  .passthrough();
export type GraphicsSettings = z.infer<typeof GraphicsSettings>;

/** Game.ini — gameplay-adjacent client prefs (FOV, head bob, memory/affinity toggles). */
export const GameSettings = z
  .object({
    FieldOfView: z.number(),
    HeadBobbing: z.number(),
    AutoEmptyWorkingSet: z.boolean(),
    SetAffinityToLogicalCores: z.boolean(),
    EnableHideoutPreload: z.boolean(),
    StreamerModeEnabled: z.boolean(),
  })
  .partial()
  .passthrough();
export type GameSettings = z.infer<typeof GameSettings>;

/** PostFx.ini — post-processing (visibility levers: clarity/sharpen; perf lever: EnablePostFx). */
export const PostFxSettings = z
  .object({
    EnablePostFx: z.boolean(),
    Brightness: z.number(),
    Saturation: z.number(),
    Clarity: z.number(),
    Colorfulness: z.number(),
    LumaSharpen: z.number(),
    AdaptiveSharpen: z.number(),
    ColorFilterType: z.string(),
  })
  .partial()
  .passthrough();
export type PostFxSettings = z.infer<typeof PostFxSettings>;

export type SettingValue = string | number | boolean;

export interface EftSettings {
  /** Directory the files were read from. */
  dir: string;
  /** Which of the five files actually existed on disk. */
  present: SettingsFileName[];
  graphics: GraphicsSettings;
  game: GameSettings;
  postfx: PostFxSettings;
  /** Raw parsed JSON per file — the diff/apply layer works on these. */
  raw: Partial<Record<SettingsFileName, Record<string, unknown>>>;
}

/** Parse one settings file's text (exported for fixture-level tests). */
export function parseSettingsJson(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("EFT settings file is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Load whatever settings files exist under `dir` (default: the real install's
 * roaming settings dir). Missing files are tolerated — a fresh machine or a
 * fixture dir may only have a subset. Malformed JSON throws: silently advising
 * against a half-read config would be worse than failing loudly.
 */
export function loadEftSettings(dir: string = defaultSettingsDir()): EftSettings {
  const raw: Partial<Record<SettingsFileName, Record<string, unknown>>> = {};
  const present: SettingsFileName[] = [];
  for (const name of SETTINGS_FILES) {
    const file = join(dir, `${name}.ini`);
    if (!existsSync(file)) continue;
    raw[name] = parseSettingsJson(readFileSync(file, "utf8"));
    present.push(name);
  }
  return {
    dir,
    present,
    graphics: GraphicsSettings.parse(raw.Graphics ?? {}),
    game: GameSettings.parse(raw.Game ?? {}),
    postfx: PostFxSettings.parse(raw.PostFx ?? {}),
    raw,
  };
}

/**
 * Read a setting by flat key `"<File>.<Key>"`, e.g. `"Graphics.VSync"`.
 * Returns undefined when the file or key is absent, or the value is not a
 * scalar (nested objects like DisplaySettings are out of advisor scope).
 */
export function getSetting(settings: EftSettings, key: string): SettingValue | undefined {
  const dot = key.indexOf(".");
  if (dot < 0) return undefined;
  const file = key.slice(0, dot) as SettingsFileName;
  const field = key.slice(dot + 1);
  const value = settings.raw[file]?.[field];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}
