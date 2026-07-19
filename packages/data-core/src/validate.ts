import type { StoryDataset } from "./story/schema.js";
import type { Task } from "./tasks.js";
import type { QuestInfobox } from "./wiki/infobox.js";

/**
 * Wiki ⟷ API cross-validation (M1.4) + curated-dataset self-checks.
 *
 * Emits {@link Finding}s (severity + field + expected/actual) where the curated
 * `story.json` and the tarkov.dev task data overlap with each other and with the
 * EFT wiki. Pure and injectable: the wiki side is passed in as a fixture map so
 * the checks never hit the network (the service/CLI supplies live infoboxes; the
 * tests supply canned ones).
 *
 * @tier T0 — pure analysis of committed data; never touches the game.
 */

export type Severity = "error" | "warning" | "info";

export interface Finding {
  severity: Severity;
  /** which body of data the finding is about */
  category: "story" | "task" | "wiki";
  /** dotted path to the specific field, e.g. `story.tt-18.majorEvidence` */
  field: string;
  message: string;
  expected?: string | number | boolean;
  actual?: string | number | boolean;
  /** id/handle of the record (task id, stage id, decision id) */
  ref?: string;
}

/**
 * Canonical TerraGroup-evidence facts for the Savior/Debtor ending chain.
 *
 * The dataset originally read "8 major" evidence. Corroborated community
 * sources (wiki The Ticket evidence branch + guides) establish that **9 major
 * evidence items exist across the story, of which 8 are required** — you may
 * miss at most one chapter's evidence and still deliver enough for the Savior
 * hand-over. This constant is the single source of truth the evidence-count
 * check enforces against the story hints.
 */
export const TERRAGROUP_EVIDENCE = {
  majorRequired: 8,
  majorTotal: 9,
  minorOptional: 36,
} as const;

export interface CrossValidateInput {
  story: StoryDataset;
  /** tarkov.dev tasks (names resolved onto `.name` by loadWorld) */
  tasks: Record<string, Task>;
  /**
   * Wiki infoboxes keyed by page title (from the MediaWiki parser). Optional —
   * when absent the wiki⟷API checks are skipped and only the self-checks run.
   */
  wiki?: Record<string, QuestInfobox>;
}

/** Verify the TerraGroup major-evidence count in the story hints reflects the 8-of-9 reality. */
export function checkEvidenceCount(story: StoryDataset): Finding[] {
  const findings: Finding[] = [];
  const { majorRequired, majorTotal } = TERRAGROUP_EVIDENCE;

  // The claim lives in two places: the tt-18 stage hint and the ticket_final
  // "hand_over_all" (Savior) decision note. Both must acknowledge that the
  // count is "of 9" / that a chapter may be missed — a bare "8 major" is a
  // silent overstatement of certainty.
  const reflectsReality = (text: string): boolean => {
    const t = text.toLowerCase();
    const mentionsRequired = t.includes(String(majorRequired));
    const mentionsTotalOrMiss =
      t.includes(`of ${majorTotal}`) || t.includes(String(majorTotal)) || t.includes("miss");
    return mentionsRequired && mentionsTotalOrMiss;
  };

  const tt18 = story.chapters.flatMap((c) => c.stages).find((s) => s.id === "tt-18");
  if (tt18?.hint && !reflectsReality(tt18.hint)) {
    findings.push({
      severity: "warning",
      category: "story",
      field: "story.tt-18.majorEvidence",
      ref: "tt-18",
      message: `tt-18 hint states the major-evidence count without noting that ${majorTotal} exist / ${majorRequired} required (may miss one chapter)`,
      expected: `${majorRequired} of ${majorTotal} major (miss at most one)`,
      actual: tt18.hint,
    });
  }

  const finalDecision = story.decisions.find((d) => d.id === "ticket_final");
  const handOverAll = finalDecision?.options.find((o) => o.id === "hand_over_all");
  const note = handOverAll?.effects.notes ?? "";
  if (handOverAll && !reflectsReality(note)) {
    findings.push({
      severity: "warning",
      category: "story",
      field: "story.ticket_final.hand_over_all.majorEvidence",
      ref: "ticket_final",
      message: `ticket_final hand_over_all (Savior) note states the major-evidence count without the ${majorTotal}-exist / ${majorRequired}-required framing`,
      expected: `${majorRequired} of ${majorTotal} major (miss at most one)`,
      actual: note,
    });
  }

  return findings;
}

/** Self-consistency: every ending referenced by a decision effect must exist. */
function checkStoryEndingRefs(story: StoryDataset): Finding[] {
  const findings: Finding[] = [];
  const endings = new Set(story.endings.map((e) => e.id));
  for (const decision of story.decisions) {
    for (const option of decision.options) {
      for (const e of option.effects.locksEndings ?? []) {
        if (!endings.has(e)) {
          findings.push({
            severity: "error",
            category: "story",
            field: `story.${decision.id}.${option.id}.locksEndings`,
            ref: decision.id,
            message: `decision option locks unknown ending "${e}"`,
            actual: e,
          });
        }
      }
      const only = option.effects.setsOnlyEnding;
      if (only && !endings.has(only)) {
        findings.push({
          severity: "error",
          category: "story",
          field: `story.${decision.id}.${option.id}.setsOnlyEnding`,
          ref: decision.id,
          message: `decision option sets unknown ending "${only}"`,
          actual: only,
        });
      }
    }
  }
  return findings;
}

/** Extract a wiki page title from a task's wikiLink (…/wiki/<Title>), or null. */
function wikiTitleOf(task: Task): string | null {
  if (!task.wikiLink) return null;
  const m = /\/wiki\/([^#?]+)/.exec(task.wikiLink);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

/** Wiki ⟷ API drift: compare each task's kappa flag against the wiki infobox. */
function checkWikiTaskDrift(tasks: Record<string, Task>, wiki: Record<string, QuestInfobox>): Finding[] {
  const findings: Finding[] = [];
  for (const task of Object.values(tasks)) {
    const title = wikiTitleOf(task);
    if (!title) continue;
    const box = wiki[title] ?? wiki[title.replace(/_/g, " ")];
    if (!box) continue;

    // kappa flag drift (only when the wiki states one)
    if (box.kappaRequired !== null) {
      const apiKappa = task.kappaRequired ?? false;
      if (box.kappaRequired !== apiKappa) {
        findings.push({
          severity: "warning",
          category: "wiki",
          field: "task.kappaRequired",
          ref: task.id,
          message: `kappa flag disagrees with wiki for "${task.name}"`,
          expected: box.kappaRequired,
          actual: apiKappa,
        });
      }
    }
  }
  return findings;
}

/** Run all cross-validation checks and return the aggregated findings. */
export function crossValidate(input: CrossValidateInput): Finding[] {
  const findings: Finding[] = [
    ...checkEvidenceCount(input.story),
    ...checkStoryEndingRefs(input.story),
  ];
  if (input.wiki) findings.push(...checkWikiTaskDrift(input.tasks, input.wiki));
  return findings;
}

/** Bucket findings by severity for a quick summary. */
export function summarizeFindings(findings: Finding[]): { error: number; warning: number; info: number } {
  return {
    error: findings.filter((f) => f.severity === "error").length,
    warning: findings.filter((f) => f.severity === "warning").length,
    info: findings.filter((f) => f.severity === "info").length,
  };
}
