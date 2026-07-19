import { z } from "zod";
import type { ModelClient } from "./model.js";
import type { ServiceClient } from "./service.js";
import { buildToolBelt, type AgentTool } from "./tools.js";
import { buildSystemPrompt } from "./grounding.js";
import { GoalSchema, PlannerWeightsSchema, type Goal, type PlannerWeights, type ToolCallRecord } from "./types.js";

/**
 * NL goal intake (M4.2): free-text goals -> { goals, weights, notes } via a
 * tool-forced JSON extraction (zod-validated, one in-loop retry on parse
 * failure plus one whole-call retry), then persisted through the set_goals
 * tool. Canonical example: "Kappa + Savior before prestige, hate Lighthouse"
 * -> kappa goal + story-ending guard note + mapCost.lighthouse > 1.
 * @tier T0
 */

export const GoalsIntakeSchema = z.object({
  goals: z.array(GoalSchema).min(1),
  weights: PlannerWeightsSchema,
  /** free-text guard notes, e.g. story-ending constraints the goal model cannot express */
  notes: z.array(z.string()).default([]),
});
export type GoalsIntake = z.infer<typeof GoalsIntakeSchema>;

export interface GoalsIntakeResult {
  goals: Goal[];
  weights: PlannerWeights;
  notes: string[];
  toolCalls: ToolCallRecord[];
}

const INTAKE_SYSTEM = [
  buildSystemPrompt(),
  "",
  "## Goal extraction task",
  "Extract the player's stated goals into the structured goal model:",
  "- kappa / lightkeeper / level N / explicit task lists become goals.",
  "- Map preferences become weights.mapCost: >1 for maps the player dislikes (e.g. 1.5), <1 for favourites (e.g. 0.75). Use lowercase map names.",
  "- Story/ending constraints (e.g. wanting a specific ending before prestige) cannot be expressed as goals — record them as a human-readable guard note in notes[] mentioning the ending by name.",
  "- Keep default weights {task:1, xp:0.15, criticality:0.4} unless the player expresses a preference.",
].join("\n");

function buildEmitTool(capture: { value?: GoalsIntake }): AgentTool {
  return {
    name: "emit_goals",
    description:
      "Emit the structured goal extraction. Call exactly once with the final goals, weights and notes.",
    input: GoalsIntakeSchema as unknown as z.ZodObject<z.ZodRawShape>,
    endpoint: "extraction (no network)",
    run: async (args) => {
      capture.value = GoalsIntakeSchema.parse(args);
      return JSON.stringify({ recorded: true });
    },
  };
}

export async function intakeGoals(
  client: ModelClient,
  service: ServiceClient,
  text: string,
): Promise<GoalsIntakeResult> {
  const belt = buildToolBelt(service);
  const capture: { value?: GoalsIntake } = {};
  const emitTool = buildEmitTool(capture);
  const tools = [...belt, emitTool];
  const toolCalls: ToolCallRecord[] = [];

  for (let attempt = 0; attempt < 2 && !capture.value; attempt++) {
    const result = await client.complete({
      system: INTAKE_SYSTEM,
      messages: [
        {
          role: "user",
          content:
            attempt === 0
              ? text
              : `${text}\n\n(Your previous extraction did not validate — call emit_goals again with schema-conformant JSON.)`,
        },
      ],
      tools,
      forceTool: "emit_goals",
    });
    toolCalls.push(...result.toolCalls);
  }
  if (!capture.value) {
    throw new Error("goals intake failed: model never produced a valid emit_goals call (after retry)");
  }

  const { goals, weights, notes } = capture.value;

  // Persist through the contracted set_goals tool (POST /api/goals).
  const setGoals = belt.find((t) => t.name === "set_goals")!;
  await setGoals.run({ goals, weights });
  toolCalls.push({ tool: "set_goals", argsSummary: JSON.stringify({ goals, weights }).slice(0, 200) });

  return { goals, weights, notes, toolCalls };
}
