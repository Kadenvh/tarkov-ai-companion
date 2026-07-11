import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STORY_DIR } from "../src/paths.js";
import { parseStoryDataset } from "../src/story/schema.js";

const dataset = parseStoryDataset(
  JSON.parse(readFileSync(join(STORY_DIR, "story.json"), "utf8")),
);

describe("story dataset (M1.5)", () => {
  it("has 10 chapters in order and 4 endings", () => {
    expect(dataset.chapters).toHaveLength(10);
    expect(dataset.chapters.map((c) => c.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(dataset.endings.map((e) => e.id).sort()).toEqual(["debtor", "fallen", "savior", "survivor"]);
  });

  it("every stage decision reference resolves", () => {
    const decisionIds = new Set(dataset.decisions.map((d) => d.id));
    for (const chapter of dataset.chapters) {
      for (const stage of chapter.stages) {
        if (stage.decision) expect(decisionIds.has(stage.decision), `${stage.id} -> ${stage.decision}`).toBe(true);
        if (stage.condition) expect(decisionIds.has(stage.condition.decision), `${stage.id} condition`).toBe(true);
      }
    }
  });

  it("every decision is anchored to an existing chapter stage", () => {
    const anchored = new Set(
      dataset.chapters.flatMap((c) => c.stages.map((s) => s.decision).filter(Boolean)),
    );
    for (const decision of dataset.decisions) {
      expect(anchored.has(decision.id), decision.id).toBe(true);
      expect(dataset.chapters.some((c) => c.id === decision.chapter)).toBe(true);
    }
  });

  it("every ending referenced by decision effects exists", () => {
    const endings = new Set(dataset.endings.map((e) => e.id));
    for (const decision of dataset.decisions) {
      for (const option of decision.options) {
        for (const id of option.effects.locksEndings ?? []) expect(endings.has(id)).toBe(true);
        if (option.effects.setsOnlyEnding) expect(endings.has(option.effects.setsOnlyEnding)).toBe(true);
      }
    }
  });

  it("stage ids are globally unique", () => {
    const ids = dataset.chapters.flatMap((c) => c.stages.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
