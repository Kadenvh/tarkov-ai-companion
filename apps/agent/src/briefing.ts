import type { ModelClient } from "./model.js";
import type { ServiceClient } from "./service.js";
import { buildToolBelt } from "./tools.js";
import { buildSystemPrompt } from "./grounding.js";
import type { ToolCallRecord } from "./types.js";

/**
 * Per-raid briefing (M4.3): map, batch order with short whys, bring-list,
 * decision warnings — under 200 words, grounded exclusively in tool results.
 * The word cap is enforced programmatically: one regeneration attempt, then a
 * hard truncation at a sentence boundary.
 * @tier T0
 */

export const BRIEFING_WORD_CAP = 200;

export function wordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

/** Cut at sentence boundaries so the truncated briefing still reads whole. */
export function truncateAtSentence(text: string, cap: number = BRIEFING_WORD_CAP): string {
  if (wordCount(text) <= cap) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [text];
  let out = "";
  for (const sentence of sentences) {
    const candidate = out + sentence;
    if (wordCount(candidate) > cap) break;
    out = candidate;
  }
  if (!out) {
    // single giant sentence — fall back to a hard word cut
    out = text.trim().split(/\s+/).slice(0, cap).join(" ");
  }
  return out.trim();
}

function briefingPrompt(raidIndex: number, strict: boolean): string {
  return [
    `BRIEFING_REQUEST raidIndex=${raidIndex}`,
    "",
    `Generate a pre-raid briefing for planned raid ${raidIndex}. Use get_plan, get_quartermaster, get_foresight, and get_story to gather ONLY current data.`,
    "Structure: the map; the task batch in execution order with a short why per task; the bring-list (keys/items with acquisition route); any irreversibility warnings.",
    "Always call the map by its display name from get_plan's mapNames — never output a raw 24-hex id.",
    `Hard limit: fewer than ${BRIEFING_WORD_CAP} words. Plain text, no headings.`,
    strict ? `Your previous draft was too long. It MUST be under ${BRIEFING_WORD_CAP} words this time — cut detail, keep the structure.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface BriefingResult {
  briefing: string;
  toolCalls: ToolCallRecord[];
  /** true when the programmatic cap had to hard-truncate the model output. */
  truncated: boolean;
}

export async function generateBriefing(
  client: ModelClient,
  service: ServiceClient,
  raidIndex: number,
): Promise<BriefingResult> {
  const tools = buildToolBelt(service);
  const system = buildSystemPrompt();

  let result = await client.complete({
    system,
    messages: [{ role: "user", content: briefingPrompt(raidIndex, false) }],
    tools,
  });
  let toolCalls = result.toolCalls;

  if (wordCount(result.text) > BRIEFING_WORD_CAP) {
    // regenerate once with a stricter instruction
    result = await client.complete({
      system,
      messages: [{ role: "user", content: briefingPrompt(raidIndex, true) }],
      tools,
    });
    toolCalls = [...toolCalls, ...result.toolCalls];
  }

  const overCap = wordCount(result.text) > BRIEFING_WORD_CAP;
  const briefing = overCap ? truncateAtSentence(result.text) : result.text;
  return { briefing, toolCalls, truncated: overCap };
}
