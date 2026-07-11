/**
 * Story tracker logic — ending-compatibility predictions at parity with the
 * auto-tracker artifact, grounded in the verified decision graph shipped in
 * data/story/story.json (fixture below mirrors its effect edges exactly).
 */

import { describe, expect, it } from "vitest";
import {
  chapterProgress,
  decisionWarnings,
  endingOutlook,
  optionConsequence,
  overallProgress,
  stageVisibility,
  visibleStages,
} from "../src/lib/story";
import type { StoryChapter, StoryDecision, StoryEnding } from "../src/api/types";

const ENDINGS: StoryEnding[] = [
  { id: "savior", name: "Savior", subtitle: "For Humanity", description: "True ending." },
  { id: "survivor", name: "Survivor", subtitle: "Selfish Escape", description: "Escape alone." },
  { id: "fallen", name: "Fallen", subtitle: "Betrayer", description: "Paid Prapor." },
  { id: "debtor", name: "Debtor", subtitle: "LK's Pawn", description: "Owe Lightkeeper." },
];

/** Mirrors data/story/story.json effect edges (verified 2026-07-11). */
const DECISIONS: StoryDecision[] = [
  {
    id: "falling_skies_case",
    chapter: "falling-skies",
    question: "What did you do with the armored case?",
    options: [
      { id: "give_prapor", label: "Gave it to Prapor", effects: { notes: "No ending is locked." } },
      { id: "keep_case", label: "Kept it", effects: { notes: "No ending is locked." } },
    ],
  },
  {
    id: "ticket_kerman",
    chapter: "the-ticket",
    question: "Work with Mr. Kerman?",
    options: [
      { id: "yes", label: "Yes", effects: { locksEndings: ["survivor"] } },
      { id: "no", label: "No", effects: { setsOnlyEnding: "survivor" } },
    ],
  },
  {
    id: "ticket_evidence",
    chapter: "the-ticket",
    question: "Gather evidence for Kerman?",
    options: [
      { id: "yes", label: "Yes", effects: { locksEndings: ["fallen"] } },
      { id: "no", label: "No", effects: { setsOnlyEnding: "fallen" } },
    ],
  },
  {
    id: "ticket_final",
    chapter: "the-ticket",
    question: "Hand over all the evidence?",
    options: [
      { id: "hand_over_all", label: "Deliver everything", effects: { setsOnlyEnding: "savior" } },
      { id: "withhold_evidence", label: "Withhold it", effects: { setsOnlyEnding: "debtor" } },
    ],
  },
];

describe("endingOutlook — artifact-parity predictions", () => {
  it("1. no decisions: all four endings even at 25%", () => {
    const o = endingOutlook(ENDINGS, DECISIONS, {});
    expect(o.probabilities).toEqual({ savior: 25, survivor: 25, fallen: 25, debtor: 25 });
    expect(o.lockedIn).toBe(false);
    expect(o.possible).toHaveLength(4);
  });

  it("2. refuse Kerman: Survivor 100%, LOCKED", () => {
    const o = endingOutlook(ENDINGS, DECISIONS, { ticket_kerman: "no" });
    expect(o.probabilities["survivor"]).toBe(100);
    expect(o.probabilities["savior"]).toBe(0);
    expect(o.lockedIn).toBe(true);
    expect(o.forced).toBe("survivor");
    expect(o.predicted).toBe("survivor");
  });

  it("3. work with Kerman: Survivor locked out, three remain summing to 100", () => {
    const o = endingOutlook(ENDINGS, DECISIONS, { ticket_kerman: "yes" });
    expect(o.probabilities["survivor"]).toBe(0);
    expect(o.possible).toEqual(["savior", "fallen", "debtor"]);
    const sum = Object.values(o.probabilities).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
    expect(o.locked).toContainEqual({ ending: "survivor", byDecision: "ticket_kerman", option: "yes" });
  });

  it("4. Kerman yes + refuse evidence: Fallen 100%, LOCKED", () => {
    const o = endingOutlook(ENDINGS, DECISIONS, { ticket_kerman: "yes", ticket_evidence: "no" });
    expect(o.probabilities["fallen"]).toBe(100);
    expect(o.lockedIn).toBe(true);
    expect(o.predicted).toBe("fallen");
  });

  it("5. Kerman yes + gather evidence: Savior/Debtor 50-50, not locked", () => {
    const o = endingOutlook(ENDINGS, DECISIONS, { ticket_kerman: "yes", ticket_evidence: "yes" });
    expect(o.probabilities).toEqual({ savior: 50, survivor: 0, fallen: 0, debtor: 50 });
    expect(o.lockedIn).toBe(false);
  });

  it("6. full Savior path: hand over everything → Savior 100%, LOCKED", () => {
    const o = endingOutlook(ENDINGS, DECISIONS, {
      ticket_kerman: "yes",
      ticket_evidence: "yes",
      ticket_final: "hand_over_all",
    });
    expect(o.probabilities["savior"]).toBe(100);
    expect(o.lockedIn).toBe(true);
  });

  it("7. withhold evidence at the end: Debtor 100%", () => {
    const o = endingOutlook(ENDINGS, DECISIONS, {
      ticket_kerman: "yes",
      ticket_evidence: "yes",
      ticket_final: "withhold_evidence",
    });
    expect(o.probabilities["debtor"]).toBe(100);
    expect(o.predicted).toBe("debtor");
  });

  it("8. the armored-case decision alone locks nothing (verified data, unlike the artifact's priors)", () => {
    const o = endingOutlook(ENDINGS, DECISIONS, { falling_skies_case: "keep_case" });
    expect(o.possible).toHaveLength(4);
    expect(o.lockedIn).toBe(false);
  });
});

// ---------- stages / chapters ----------

const CHAPTER: StoryChapter = {
  id: "the-ticket",
  name: "The Ticket",
  wikiPage: "The_Ticket",
  order: 7,
  stages: [
    { id: "tt-01", name: "Wait for Kerman" },
    { id: "tt-02", name: "Decision: work with Kerman?", decision: "ticket_kerman" },
    { id: "tt-03", name: "Find the Jammer", condition: { decision: "ticket_kerman", option: "yes" } },
    { id: "tt-04", name: "Survivor buyout", condition: { decision: "ticket_kerman", option: "no" } },
  ],
};

describe("stage visibility & progress", () => {
  it("branch stages are conditional before the decision, hidden on the other branch", () => {
    const jammer = CHAPTER.stages[2]!;
    expect(stageVisibility(jammer, {})).toBe("conditional");
    expect(stageVisibility(jammer, { ticket_kerman: "yes" })).toBe("visible");
    expect(stageVisibility(jammer, { ticket_kerman: "no" })).toBe("hidden");
  });

  it("visibleStages drops only the other branch after deciding", () => {
    expect(visibleStages(CHAPTER, {}).map((s) => s.id)).toEqual(["tt-01", "tt-02", "tt-03", "tt-04"]);
    expect(visibleStages(CHAPTER, { ticket_kerman: "yes" }).map((s) => s.id)).toEqual([
      "tt-01",
      "tt-02",
      "tt-03",
    ]);
  });

  it("chapterProgress counts only visible stages and points at the next unchecked one", () => {
    const p = chapterProgress(CHAPTER, { "tt-01": true }, { ticket_kerman: "yes" });
    expect(p.done).toBe(1);
    expect(p.total).toBe(3);
    expect(p.pct).toBe(33);
    expect(p.complete).toBe(false);
    expect(p.nextStageId).toBe("tt-02");
  });

  it("overallProgress sums across chapters", () => {
    const o = overallProgress([CHAPTER], { "tt-01": true, "tt-02": true, "tt-03": true }, { ticket_kerman: "yes" });
    expect(o).toEqual({ done: 3, total: 3, pct: 100 });
  });
});

describe("decision warnings", () => {
  it("emits a warning with per-option consequence text for undecided visible decisions", () => {
    const warnings = decisionWarnings([CHAPTER], DECISIONS, ENDINGS, { "tt-01": true }, {});
    expect(warnings).toHaveLength(1);
    const w = warnings[0]!;
    expect(w.decisionId).toBe("ticket_kerman");
    expect(w.imminent).toBe(true); // tt-02 is the next unchecked stage
    expect(w.options.find((o) => o.id === "no")?.consequence).toMatch(/LOCKS you into the Survivor ending/);
    expect(w.options.find((o) => o.id === "yes")?.consequence).toMatch(/locks out: Survivor/);
  });

  it("suppresses the warning once decided and drops the imminent flag when not next", () => {
    expect(decisionWarnings([CHAPTER], DECISIONS, ENDINGS, {}, { ticket_kerman: "yes" })).toHaveLength(0);
    const notNext = decisionWarnings([CHAPTER], DECISIONS, ENDINGS, {}, {});
    expect(notNext[0]?.imminent).toBe(false); // tt-01 is next, not the decision stage
  });

  it("optionConsequence spells out no-lock options and appends notes", () => {
    const caseOption = DECISIONS[0]!.options[0]!;
    expect(optionConsequence(caseOption, ENDINGS)).toBe("no ending is locked · No ending is locked.");
  });
});
