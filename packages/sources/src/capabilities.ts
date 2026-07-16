/**
 * @tier T0 (pure data — a string-union vocabulary; touches nothing, reads
 * nothing, holds no credentials).
 *
 * The Sources capability taxonomy (SPEC-10 M10.1). A *source* advertises what
 * kinds of remote data it can supply, and The Coach / registry reasons about
 * capabilities rather than a specific vendor endpoint — so tarkov.dev vs. a
 * future mirror compete to satisfy the same `game-data`/`prices` capability.
 *
 * Sibling to `@tac/connectors`' `Capability` (local tools). This layer owns the
 * *remote-source* vocabulary. Kept deliberately separate: connectors describe
 * on-machine tools, sources describe network data feeds.
 */

/** Every capability a source may advertise (v1). Order is not significant. */
export const SOURCE_CAPABILITIES = [
  "game-data", // static patch data: tasks/items/maps/hideout/barters/crafts/traders
  "prices", // flea + trader prices (dynamic; 5-min TTL)
  "progress-read", // read a user's quest/hideout progress (TarkovTracker, GP scope)
  "story", // narrative/story chapters (EFT wiki — M10.4, not built in this slice)
  "submit", // opt-in crowdsourced submissions (tarkov.dev manager — M10.4, off by default)
] as const;

/** A capability a source can satisfy. */
export type SourceCapability = (typeof SOURCE_CAPABILITIES)[number];

/** Runtime membership test (for validating user-supplied / out-of-tree ids later). */
export function isSourceCapability(value: unknown): value is SourceCapability {
  return typeof value === "string" && (SOURCE_CAPABILITIES as readonly string[]).includes(value);
}
