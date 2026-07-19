/**
 * @tier T0 (pure data — a string-union vocabulary; touches nothing).
 *
 * The capability taxonomy (SPEC-8 §"Capability taxonomy (v1)"). A connector
 * advertises *capabilities*, not a brand: alternatives (Wootility vs. a generic
 * no-op) compete to satisfy the same capability, so The Coach stays
 * vendor-neutral and reasons about capabilities, never vendors.
 */

/** Every capability a connector may advertise (v1). Order is not significant. */
export const CAPABILITIES = [
  "game-config", // EFT Settings\*.ini (JSON)
  "keyboard-actuation", // actuation points, rapid-trigger, layers (Wooting HE etc.)
  "audio-mix", // device routing, EQ, ChatMix (Sonar/GG, Voicemeeter…)
  "gpu-3d-profile", // per-app DRS profile for EscapeFromTarkov.exe (NVAPI)
  "display-config", // resolution / refresh / HDR (OS display query)
  "perf-telemetry", // frametimes, GPU util/VRAM/clocks/temps (PresentMon/ETW)
  "tracker-sync", // quest/hideout/goal state (TarkovTracker .org mirror)
  "manual-capture", // user-supplied paste/screenshot → OCR (assisted fallback)
] as const;

/** A capability a connector can satisfy. */
export type Capability = (typeof CAPABILITIES)[number];

/** Runtime membership test (for validating out-of-tree / user-supplied ids later). */
export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (CAPABILITIES as readonly string[]).includes(value);
}
