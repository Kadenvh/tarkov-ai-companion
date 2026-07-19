/**
 * @tier T0 (pure data + diffing; nothing here touches disk).
 *
 * Curated EFT settings profiles (M6.1). Every value is one the in-game
 * graphics/game/post-fx UI itself exposes — the apply layer never writes
 * outside UI ranges (docs/research/06-environment-paths.md §3).
 *
 * Sources for the recommendations:
 *  - docs/research/06-environment-paths.md (field inventory, verified on this
 *    machine, EFT 1.0.6 / RTX 3080).
 *  - Long-standing community performance consensus for EFT (a CPU-bound Unity
 *    title): shadows/visibility/LOD are the dominant frame-time levers;
 *    SSR/SSAO/volumetrics and PostFx are GPU taxes with minimal play value;
 *    VSync off + Reflex on for input latency. As circulated by the EFT wiki
 *    "Game settings" page and the widely-shared competitive configs
 *    (Pestily/Klean-style streamer settings, r/EscapefromTarkov guides).
 *  - Visibility levers (PostFx Clarity/LumaSharpen, higher OverallVisibility,
 *    grass-shadow off) per the same community canon.
 */
import type { EftSettings, SettingValue } from "./eft-settings.js";
import { getSetting } from "./eft-settings.js";

export interface ProfileSetting {
  /** Flat key `"<File>.<Key>"`, e.g. `"Graphics.VSync"`. */
  key: string;
  value: SettingValue;
  /** Human rationale — surfaced verbatim in the UI/briefings (M3.6-style explainability). */
  why: string;
}

export interface RecommendationProfile {
  key: "max-fps" | "balanced" | "max-visibility" | "meta";
  name: string;
  description: string;
  settings: ProfileSetting[];
}

/** Settings shared by all three profiles — uncontroversial, latency/stability wins. */
const COMMON: ProfileSetting[] = [
  { key: "Graphics.VSync", value: false, why: "VSync adds a frame of input latency; cap FPS instead." },
  { key: "Graphics.NVidiaReflex", value: "On", why: "Reflex trims render-queue latency on NVIDIA GPUs at no visual cost." },
  { key: "Graphics.ChromaticAberrations", value: false, why: "Pure visual noise on edges; costs clarity and a little GPU." },
  { key: "Graphics.Noise", value: false, why: "Film grain hides pixels you want to see (players at range)." },
  { key: "Graphics.ZBlur", value: false, why: "Depth blur hurts target acquisition; small perf save too." },
  { key: "Graphics.HighQualityFog", value: false, why: "Perf cost with no competitive upside." },
  { key: "Game.AutoEmptyWorkingSet", value: true, why: "Lets the client trim working-set between raids; helps long sessions on 32 GB or less." },
  { key: "Game.SetAffinityToLogicalCores", value: true, why: "Community-standard toggle for smoother frame pacing on modern CPUs." },
];

export const PROFILES: RecommendationProfile[] = [
  {
    key: "max-fps",
    name: "Max FPS",
    description:
      "Lowest frame-time settings the in-game UI allows without making the game unreadable. For 240 Hz chasing or weaker GPUs.",
    settings: [
      ...COMMON,
      { key: "Graphics.ShadowsQuality", value: 0, why: "Shadows are the single biggest GPU lever; lowest still renders player shadows." },
      { key: "Graphics.CloudsQuality", value: "Low", why: "Volumetric clouds cost frames and reveal nothing." },
      { key: "Graphics.OverallVisibility", value: 1000, why: "Draw distance is a large CPU lever; 1000 m still covers every engagement range." },
      { key: "Graphics.LodBias", value: 2, why: "Lowest object LOD the slider allows — big CPU save on dense maps (Streets)." },
      { key: "Graphics.ShadowDistance", value: 40, why: "Minimum shadow draw distance; distant shadows are pure cost." },
      { key: "Graphics.Ssao", value: "Off", why: "Ambient occlusion is a GPU tax with zero information value." },
      { key: "Graphics.SSR", value: "Off", why: "Screen-space reflections are one of the priciest toggles." },
      { key: "Graphics.AntiAliasing", value: "TAA", why: "Base TAA over TAA High: nearly identical image, cheaper." },
      { key: "Graphics.GrassShadow", value: false, why: "Grass shadows eat frames and make prone players harder to spot." },
      { key: "Graphics.VolumetricLight", value: "Off", why: "God-rays cost GPU and add glare." },
      { key: "Graphics.HighQualityColor", value: false, why: "HDR-grade color buffer costs bandwidth for no gameplay gain." },
      { key: "PostFx.EnablePostFx", value: false, why: "The whole PostFx pass costs ~3-7% GPU; off is the fastest option." },
    ],
  },
  {
    key: "balanced",
    name: "Balanced",
    description:
      "The daily driver: near-max-fps frame times, but keeps the mid-range detail and sharpening that help you spot people. Tuned for a 1440p/RTX-3080-class rig.",
    settings: [
      ...COMMON,
      { key: "Graphics.ShadowsQuality", value: 1, why: "Low-medium shadows: readable player shadows without the ultra tax." },
      { key: "Graphics.CloudsQuality", value: "Low", why: "Clouds stay a pure cost at any quality." },
      { key: "Graphics.OverallVisibility", value: 1500, why: "Comfortable draw distance for Woods/Lighthouse sightlines at moderate CPU cost." },
      { key: "Graphics.LodBias", value: 2.5, why: "Sweet spot: distant objects keep shape without Streets-level CPU drain." },
      { key: "Graphics.ShadowDistance", value: 60, why: "Slightly past minimum so nearby cover shadows don't pop." },
      { key: "Graphics.Ssao", value: "Off", why: "Still not worth frames in a shooter." },
      { key: "Graphics.SSR", value: "Off", why: "Reflections stay off — priciest eye candy in the menu." },
      { key: "Graphics.AntiAliasing", value: "TAA_High", why: "TAA High resolves foliage shimmer that hides movement." },
      { key: "Graphics.Sharpen", value: 0.6, why: "In-engine sharpen offsets TAA blur; 0.5-0.7 is the community sweet spot." },
      { key: "Graphics.GrassShadow", value: false, why: "Costs frames, hides prone players." },
      { key: "Graphics.VolumetricLight", value: "Off", why: "Glare source; off keeps interiors readable." },
      { key: "PostFx.EnablePostFx", value: true, why: "Small GPU cost buys the Clarity/LumaSharpen visibility stack." },
      { key: "PostFx.Clarity", value: 20, why: "Mid-tone contrast lift makes shaded players pop." },
      { key: "PostFx.LumaSharpen", value: 50, why: "Moderate sharpen aids long-range spotting without halos." },
    ],
  },
  {
    key: "max-visibility",
    name: "Max Visibility",
    description:
      "Spot-people-first: longest useful draw distance, anti-shimmer AA, aggressive clarity/sharpen. Costs frames — for strong CPUs or 60-144 Hz targets.",
    settings: [
      ...COMMON,
      { key: "Graphics.ShadowsQuality", value: 1, why: "Low-medium keeps shadow shapes crisp enough to read without ultra cost." },
      { key: "Graphics.CloudsQuality", value: "Low", why: "Even here, clouds buy nothing." },
      { key: "Graphics.OverallVisibility", value: 3000, why: "Max draw distance — nothing pops in inside scope range on open maps." },
      { key: "Graphics.LodBias", value: 4, why: "Higher object LOD keeps distant silhouettes solid for scanning." },
      { key: "Graphics.ShadowDistance", value: 100, why: "Longer shadow draw exposes people standing in tree lines." },
      { key: "Graphics.Ssao", value: "Off", why: "AO darkens corners — the opposite of visibility." },
      { key: "Graphics.SSR", value: "Off", why: "Reflection shimmer is a distraction, not information." },
      { key: "Graphics.AntiAliasing", value: "TAA_High", why: "Best foliage stability: movement in bushes stays visible." },
      { key: "Graphics.Sharpen", value: 0.8, why: "Stronger in-engine sharpen for long-range edge definition." },
      { key: "Graphics.GrassShadow", value: false, why: "Non-negotiable for spotting prone players." },
      { key: "Graphics.VolumetricLight", value: "Off", why: "Kills god-ray glare on Interchange/Streets interiors." },
      { key: "PostFx.EnablePostFx", value: true, why: "The visibility stack lives here." },
      { key: "PostFx.Brightness", value: 90, why: "Slightly lifted brightness opens shadowed interiors." },
      { key: "PostFx.Clarity", value: 30, why: "Strong mid-tone contrast — the classic 'see people in bushes' knob." },
      { key: "PostFx.LumaSharpen", value: 70, why: "High sharpen for silhouette edges at range." },
      { key: "PostFx.AdaptiveSharpen", value: 40, why: "Adaptive pass sharpens low-contrast areas (shade) hardest." },
    ],
  },
];

/**
 * Competitive-meta reference for the Coach **Config Audit** (not a performance
 * preset, and deliberately NOT in `PROFILES`). It encodes only the handful of
 * settings where a personal config tends to drift from documented competitive
 * canon, so `diffSettings(current, META_PROFILE)` yields exactly the audit's
 * outliers.
 *
 * Sourcing honesty (docs/research/12-pro-configs.md): there are NO trustworthy
 * pro-config presets to ship — every "pro settings" page online is uncited and
 * usually two wipes stale, and the two streamers researched (LVNDMARK, Viibin)
 * publish nothing parseable. So these values are community **meta norms**, not
 * any one player's numbers.
 *
 * Deliberately encodes NO mouse-sensitivity key. ADS sensitivity is owned by
 * the 1:1 helper in audit.ts, where an ADS ≈ hipfire × √2 is the intentional
 * "true aim" tune — not an outlier. Keeping ADS out of the meta diff is how the
 * audit and the 1:1 helper are reconciled so they can never contradict.
 *
 * NOTE: `Sound.MusicVolume` is the music-volume key (confirmed against a real
 * Sound.ini — it reads `"MusicVolume": 4`). Apply is game-closed, backup-first,
 * and only ever touches the keys listed here.
 */
export const META_PROFILE: RecommendationProfile = {
  key: "meta",
  name: "Competitive meta",
  description:
    "Documented competitive-meta norms for the visibility/clarity/audio settings a personal config tends to drift on. Not a pro's config — there are none to cite (see docs/research/12-pro-configs.md) — just the community consensus baseline.",
  settings: [
    {
      key: "Graphics.SSR",
      value: "Off",
      why: "Screen-space reflections cost frames and add shimmer that hides movement — meta runs SSR Off.",
    },
    {
      key: "Graphics.ChromaticAberrations",
      value: false,
      why: "Edge colour-fringing is pure visual noise on the frame; competitive configs turn it Off.",
    },
    {
      key: "PostFx.Clarity",
      value: 50,
      why: "Negative Clarity flattens mid-tone contrast; meta runs it positive (~+50) so shaded players pop.",
    },
    {
      key: "PostFx.Brightness",
      value: 0,
      why: "High Brightness washes out shadow detail; meta keeps Brightness near 0 for flat, readable darks.",
    },
    {
      key: "PostFx.Intensity",
      value: 0,
      why: "Colour-filter Intensity tints the whole frame; meta leaves it at 0 (no filter).",
    },
    {
      key: "Sound.MusicVolume",
      value: 0,
      why: "Music masks footsteps and gunfire cues; meta runs music volume at 0 for audio clarity.",
    },
  ],
};

export function getProfile(key: RecommendationProfile["key"]): RecommendationProfile {
  const profile = [...PROFILES, META_PROFILE].find((p) => p.key === key);
  if (!profile) throw new Error(`Unknown settings profile: ${key}`);
  return profile;
}

export interface SettingDiff {
  key: string;
  /** Current on-disk value; undefined when the key is absent from the file. */
  current: SettingValue | undefined;
  recommended: SettingValue;
  why: string;
}

/**
 * Diff engine: current on-disk settings vs a profile. Only differing keys are
 * returned; keys whose file is missing entirely are skipped (we never invent a
 * settings file the game hasn't written yet).
 */
export function diffSettings(current: EftSettings, profile: RecommendationProfile): SettingDiff[] {
  const diffs: SettingDiff[] = [];
  for (const rec of profile.settings) {
    const file = rec.key.slice(0, rec.key.indexOf("."));
    if (!(file in current.raw)) continue;
    const value = getSetting(current, rec.key);
    if (value === rec.value) continue;
    diffs.push({ key: rec.key, current: value, recommended: rec.value, why: rec.why });
  }
  return diffs;
}

/** Diff against every profile at once — the `/api/environment/settings` payload shape. */
export function diffAllProfiles(current: EftSettings): Record<string, SettingDiff[]> {
  const out: Record<string, SettingDiff[]> = {};
  for (const profile of PROFILES) out[profile.key] = diffSettings(current, profile);
  return out;
}
