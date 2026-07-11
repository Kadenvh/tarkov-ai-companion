import { z } from "zod";

/**
 * Zod schemas for the json.tarkov.dev tasks payload — deliberately loose
 * (passthrough) everywhere we don't yet consume fields, strict on what the
 * graph depends on. Shape verified live against 1.0.6 data (2026-07-11).
 */

export const TaskRequirement = z.object({
  task: z.string(),
  status: z.array(z.enum(["complete", "failed", "active"])).nonempty(),
});
export type TaskRequirement = z.infer<typeof TaskRequirement>;

export const TraderRequirement = z
  .object({
    trader: z.string().optional(),
    requirementType: z.string().optional(),
    compareMethod: z.string().optional(),
    value: z.number().optional(),
  })
  .passthrough();

const Objective = z
  .object({
    id: z.string(),
    type: z.string(),
    description: z.string().optional(),
    optional: z.boolean().optional(),
    maps: z.array(z.string()).optional(),
    // failCondition objectives of type "taskStatus" carry these:
    task: z.string().optional(),
    status: z.array(z.string()).optional(),
  })
  .passthrough();
export type Objective = z.infer<typeof Objective>;

export const Task = z
  .object({
    id: z.string(),
    name: z.string(),
    normalizedName: z.string().optional(),
    trader: z.string(),
    map: z.string().nullable().optional(),
    minPlayerLevel: z.number().optional(),
    // observed null on at least one PvE task in 1.0.6 data
    experience: z.number().nullable().optional(),
    factionName: z.string().optional(),
    kappaRequired: z.boolean().optional(),
    lightkeeperRequired: z.boolean().optional(),
    taskRequirements: z.array(TaskRequirement),
    traderRequirements: z.array(TraderRequirement),
    objectives: z.array(Objective),
    failConditions: z.array(Objective).optional(),
    availableDelaySecondsMin: z.number().nullable().optional(),
    availableDelaySecondsMax: z.number().nullable().optional(),
    wikiLink: z.string().optional(),
  })
  .passthrough();
export type Task = z.infer<typeof Task>;

export const TasksPayload = z
  .object({
    tasks: z.record(z.string(), Task),
    questItems: z.unknown().optional(),
    achievements: z.unknown().optional(),
    prestige: z.unknown().optional(),
  })
  .passthrough();
export type TasksPayload = z.infer<typeof TasksPayload>;

export function parseTasks(raw: unknown): Record<string, Task> {
  return TasksPayload.parse(raw).tasks;
}
