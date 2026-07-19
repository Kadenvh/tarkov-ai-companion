import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STORY_DIR } from "../src/paths.js";
import { parseStoryDataset, type StoryDataset } from "../src/story/schema.js";
import { checkEvidenceCount, crossValidate, TERRAGROUP_EVIDENCE, type Finding } from "../src/validate.js";
import type { Task } from "../src/tasks.js";
import type { QuestInfobox } from "../src/wiki/infobox.js";

const REAL = parseStoryDataset(JSON.parse(readFileSync(join(STORY_DIR, "story.json"), "utf8")));

/** Deep clone + set a stage hint / a decision-option note. */
function withText(base: StoryDataset, tt18Hint: string, saviorNote: string): StoryDataset {
  const d = structuredClone(base);
  const tt18 = d.chapters.flatMap((c) => c.stages).find((s) => s.id === "tt-18")!;
  tt18.hint = tt18Hint;
  const handOverAll = d.decisions.find((x) => x.id === "ticket_final")!.options.find((o) => o.id === "hand_over_all")!;
  handOverAll.effects.notes = saviorNote;
  return d;
}

function makeTask(over: Partial<Task> & { id: string }): Task {
  return {
    name: over.id,
    trader: "tr1",
    taskRequirements: [],
    traderRequirements: [],
    objectives: [],
    ...over,
  } as Task;
}

describe("cross-validation (M1.4)", () => {
  it("the shipped story.json passes the evidence-count check (8 of 9 major)", () => {
    expect(checkEvidenceCount(REAL)).toEqual([]);
  });

  it("carries the canonical 8-of-9 TerraGroup evidence facts", () => {
    expect(TERRAGROUP_EVIDENCE).toEqual({ majorRequired: 8, majorTotal: 9, minorOptional: 36 });
  });

  it("flags a bare '8 major' story (understates the 9-exist / miss-one reality)", () => {
    const stale = withText(
      REAL,
      "8 major evidence items (optionally 36 minor), then negotiate with Kerman",
      "All 8 major (optionally 36 minor) evidence items, then the Fence 4.0 rep chain.",
    );
    const findings = checkEvidenceCount(stale);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.field).sort()).toEqual([
      "story.ticket_final.hand_over_all.majorEvidence",
      "story.tt-18.majorEvidence",
    ]);
    for (const f of findings) {
      expect(f.severity).toBe("warning");
      expect(f.expected).toBe("8 of 9 major (miss at most one)");
    }
  });

  it("flags a seeded wiki⟷API kappa discrepancy", () => {
    const tasks: Record<string, Task> = {
      t1: makeTask({ id: "t1", name: "Debut", kappaRequired: false, wikiLink: "https://escapefromtarkov.fandom.com/wiki/Debut" }),
    };
    const wiki: Record<string, QuestInfobox> = {
      Debut: { givenBy: "Prapor", location: null, previous: [], leadsTo: [], related: [], kappaRequired: true },
    };
    const findings = crossValidate({ story: REAL, tasks, wiki });
    const wikiFindings = findings.filter((f: Finding) => f.category === "wiki");
    expect(wikiFindings).toHaveLength(1);
    expect(wikiFindings[0]).toMatchObject({
      severity: "warning",
      field: "task.kappaRequired",
      ref: "t1",
      expected: true,
      actual: false,
    });
  });

  it("skips wiki checks when no infoboxes are supplied", () => {
    const findings = crossValidate({ story: REAL, tasks: {} });
    expect(findings.every((f) => f.category !== "wiki")).toBe(true);
  });
});
