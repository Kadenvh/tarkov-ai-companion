/**
 * Story tracker logic (M5.3) — port of auto-tracker/tarkov-story-tracker.tsx
 * onto the live /api/story dataset (data/story/story.json schema).
 *
 * Feature parity with the artifact v2:
 *  - per-chapter progress (done/total/pct) + next-stage highlight
 *  - ending compatibility matrix + prediction from made decisions
 *  - decision-point warnings before irreversible choices
 *
 * Deviation (deliberate, documented in SPEC-7): the artifact used hand-tuned
 * probability priors ("kept the case → savior 40%"); this port derives the
 * outlook from the VERIFIED decision graph (locksEndings / setsOnlyEnding
 * effects) — reachable endings split the probability evenly, locked endings
 * are 0%. Same predictive surface, grounded in wiki-verified data instead of
 * vibes. Branch-conditional stages (new in the dataset) hide when the player
 * chose the other branch.
 */

import type {
  StoryChapter,
  StoryDecision,
  StoryDecisionOption,
  StoryEnding,
  StoryStage,
} from "../api/types";

/** decisionId -> chosen optionId */
export type DecisionsMade = Record<string, string>;
/** stageId -> done */
export type StageProgress = Record<string, boolean>;

// ---------- stage visibility (branch conditions) ----------

export type StageVisibility = "visible" | "hidden" | "conditional";

/**
 * A stage with a branch condition is:
 *  - "visible"      when it has no condition, or the matching option was chosen
 *  - "hidden"       when the decision was made with a DIFFERENT option
 *  - "conditional"  when the gating decision has not been made yet
 */
export function stageVisibility(stage: StoryStage, made: DecisionsMade): StageVisibility {
  if (!stage.condition) return "visible";
  const chosen = made[stage.condition.decision];
  if (chosen === undefined) return "conditional";
  return chosen === stage.condition.option ? "visible" : "hidden";
}

/** Stages that currently apply to this player (visible + conditional). */
export function visibleStages(chapter: StoryChapter, made: DecisionsMade): StoryStage[] {
  return chapter.stages.filter((s) => stageVisibility(s, made) !== "hidden");
}

// ---------- progress ----------

export interface ChapterProgress {
  chapterId: string;
  done: number;
  total: number;
  pct: number;
  complete: boolean;
  /** first visible unchecked stage (the artifact's "next task" arrow) */
  nextStageId: string | null;
}

export function chapterProgress(
  chapter: StoryChapter,
  progress: StageProgress,
  made: DecisionsMade,
): ChapterProgress {
  const stages = visibleStages(chapter, made);
  const done = stages.filter((s) => progress[s.id] === true).length;
  const total = stages.length;
  const next = stages.find((s) => progress[s.id] !== true);
  return {
    chapterId: chapter.id,
    done,
    total,
    pct: total === 0 ? 0 : Math.round((done / total) * 100),
    complete: total > 0 && done === total,
    nextStageId: next?.id ?? null,
  };
}

export interface OverallProgress {
  done: number;
  total: number;
  pct: number;
}

export function overallProgress(
  chapters: StoryChapter[],
  progress: StageProgress,
  made: DecisionsMade,
): OverallProgress {
  let done = 0;
  let total = 0;
  for (const chapter of chapters) {
    const p = chapterProgress(chapter, progress, made);
    done += p.done;
    total += p.total;
  }
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}

// ---------- ending outlook (the artifact's predictor, data-driven) ----------

export interface EndingOutlook {
  /** ending ids still reachable */
  possible: string[];
  /** endings ruled out, with the decision that did it */
  locked: { ending: string; byDecision: string; option: string }[];
  /** non-null when a decision pinned exactly one ending */
  forced: string | null;
  /** ending id -> integer percent (sums to 100 when any ending is possible) */
  probabilities: Record<string, number>;
  /** highest-probability ending (ties -> dataset order), null if none reachable */
  predicted: string | null;
  /** true when only one ending remains — the artifact's "LOCKED" badge */
  lockedIn: boolean;
}

export function endingOutlook(
  endings: StoryEnding[],
  decisions: StoryDecision[],
  made: DecisionsMade,
): EndingOutlook {
  const order = endings.map((e) => e.id);
  const possible = new Set(order);
  const locked: EndingOutlook["locked"] = [];
  let forced: string | null = null;

  for (const decision of decisions) {
    const chosenId = made[decision.id];
    if (!chosenId) continue;
    const option = decision.options.find((o) => o.id === chosenId);
    if (!option) continue;
    if (option.effects.setsOnlyEnding) {
      forced = option.effects.setsOnlyEnding;
      for (const ending of [...possible]) {
        if (ending !== forced) {
          possible.delete(ending);
          locked.push({ ending, byDecision: decision.id, option: chosenId });
        }
      }
    }
    for (const ending of option.effects.locksEndings ?? []) {
      if (possible.delete(ending)) {
        locked.push({ ending, byDecision: decision.id, option: chosenId });
      }
    }
  }

  const alive = order.filter((e) => possible.has(e));
  const probabilities: Record<string, number> = {};
  for (const e of order) probabilities[e] = 0;
  if (alive.length > 0) {
    const share = Math.floor(100 / alive.length);
    let remainder = 100 - share * alive.length;
    for (const e of alive) {
      probabilities[e] = share + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
    }
  }

  return {
    possible: alive,
    locked,
    forced,
    probabilities,
    predicted: alive[0] ?? null,
    lockedIn: alive.length === 1,
  };
}

// ---------- decision-point warnings ----------

export interface DecisionWarning {
  decisionId: string;
  chapterId: string;
  stageId: string;
  question: string;
  /** per-option consequence text (locks/forces + curator notes) */
  options: { id: string; label: string; consequence: string }[];
  /** true when the gating stage is the player's next actionable stage */
  imminent: boolean;
}

export function optionConsequence(option: StoryDecisionOption, endings: StoryEnding[]): string {
  const name = (id: string): string => endings.find((e) => e.id === id)?.name ?? id;
  const bits: string[] = [];
  if (option.effects.setsOnlyEnding) {
    bits.push(`LOCKS you into the ${name(option.effects.setsOnlyEnding)} ending`);
  }
  if (option.effects.locksEndings && option.effects.locksEndings.length > 0) {
    bits.push(`permanently locks out: ${option.effects.locksEndings.map(name).join(", ")}`);
  }
  if (bits.length === 0) bits.push("no ending is locked");
  if (option.effects.notes) bits.push(option.effects.notes);
  return bits.join(" · ");
}

/**
 * Warnings for every undecided decision point that is currently visible.
 * `imminent` marks decisions whose stage is the chapter's next unchecked stage.
 */
export function decisionWarnings(
  chapters: StoryChapter[],
  decisions: StoryDecision[],
  endings: StoryEnding[],
  progress: StageProgress,
  made: DecisionsMade,
): DecisionWarning[] {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const warnings: DecisionWarning[] = [];
  for (const chapter of chapters) {
    const prog = chapterProgress(chapter, progress, made);
    for (const stage of visibleStages(chapter, made)) {
      if (!stage.decision) continue;
      if (made[stage.decision] !== undefined) continue;
      const decision = byId.get(stage.decision);
      if (!decision) continue;
      warnings.push({
        decisionId: decision.id,
        chapterId: chapter.id,
        stageId: stage.id,
        question: decision.question,
        options: decision.options.map((o) => ({
          id: o.id,
          label: o.label,
          consequence: optionConsequence(o, endings),
        })),
        imminent: prog.nextStageId === stage.id,
      });
    }
  }
  return warnings;
}
