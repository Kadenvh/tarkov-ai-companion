import { z } from "zod";

/**
 * Curated story dataset schema (M1.5). tarkov.dev has zero story-chapter
 * coverage — this dataset is ours, seeded from the prior story-tracker
 * artifact + the EFT Fandom wiki (CC-BY-SA), enriched per patch.
 */

export const StageCondition = z.object({
  decision: z.string(),
  option: z.string(),
});

export const Stage = z.object({
  id: z.string(),
  name: z.string(),
  hint: z.string().optional(),
  /** tarkov.dev map ids or names once enriched; free text allowed at seed stage */
  maps: z.array(z.string()).optional(),
  optional: z.boolean().optional(),
  /** present when this stage IS a decision point */
  decision: z.string().optional(),
  /** present when this stage only exists under a prior decision branch */
  condition: StageCondition.optional(),
});

export const Chapter = z.object({
  id: z.string(),
  name: z.string(),
  wikiPage: z.string(),
  order: z.number(),
  addedIn: z.string().optional(),
  stages: z.array(Stage).nonempty(),
});

export const DecisionOption = z.object({
  id: z.string(),
  label: z.string(),
  effects: z.object({
    locksEndings: z.array(z.string()).optional(),
    setsOnlyEnding: z.string().optional(),
    notes: z.string().optional(),
  }),
});

export const Decision = z.object({
  id: z.string(),
  chapter: z.string(),
  question: z.string(),
  options: z.array(DecisionOption).min(2),
  /** seed = encoded from prior artifact; verified = re-checked against wiki */
  confidence: z.enum(["seed", "verified"]),
});

export const Ending = z.object({
  id: z.string(),
  name: z.string(),
  subtitle: z.string(),
  description: z.string(),
});

export const StoryDataset = z.object({
  schemaVersion: z.literal(1),
  gameVersion: z.string(),
  attribution: z.string(),
  chapters: z.array(Chapter).nonempty(),
  decisions: z.array(Decision),
  endings: z.array(Ending).length(4),
});
export type StoryDataset = z.infer<typeof StoryDataset>;

export function parseStoryDataset(raw: unknown): StoryDataset {
  return StoryDataset.parse(raw);
}
