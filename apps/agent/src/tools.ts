import { z } from "zod";
import type { ServiceClient } from "./service.js";
import { ServiceError } from "./service.js";
import { GoalSchema, PlannerWeightsSchema } from "./types.js";

/**
 * The tool belt (CONTRACTS §8): every game fact the copilot states must come
 * from one of these tools, and every tool is a call against the service REST
 * API — the agent holds no game state of its own.
 * @tier T0
 */

export interface AgentTool {
  name: string;
  description: string;
  /** zod object schema for the tool input (validated before run). */
  input: z.ZodObject<z.ZodRawShape>;
  /**
   * Human-readable provenance for this tool, surfaced verbatim as a citation
   * tooltip (ToolCallRecord.detail). Usually the HTTP endpoint it grounds on,
   * e.g. "GET /api/state"; pure/local tools state "(no network)".
   */
  endpoint: string;
  /** Executes the tool; returns a JSON string (the model-visible result). */
  run(args: Record<string, unknown>): Promise<string>;
}

const WIKI_BASE = "https://escapefromtarkov.fandom.com/wiki/";

/** Pure URL construction — no network (M4.1 wiki citations). */
export function wikiCiteUrl(taskName: string): string {
  const slug = taskName.trim().replace(/\s+/g, "_");
  return WIKI_BASE + encodeURIComponent(slug).replace(/%2F/gi, "/");
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value);
}

export function buildToolBelt(service: ServiceClient): AgentTool[] {
  return [
    {
      name: "get_state",
      description:
        "Fetch the player's current state from the local service: level, XP estimate + confidence, task completion, hideout, traders, prestige, faction, and live raid/session status. The ONLY source of truth for player progress and whether the player is currently in a raid.",
      input: z.object({}),
      endpoint: "GET /api/state",
      run: async () => jsonResult(await service.get("/api/state")),
    },
    {
      name: "get_plan",
      description:
        "Fetch the current raid plan (Raid Director output): per-raid map, task batch with reasons, level before/after, foresight warnings, level stalls. Optional horizon = number of raids to plan.",
      input: z.object({ horizon: z.number().int().min(1).max(20).optional() }),
      endpoint: "GET /api/plan",
      run: async (args) => {
        const horizon = typeof args["horizon"] === "number" ? `?horizon=${args["horizon"]}` : "";
        return jsonResult(await service.get(`/api/plan${horizon}`));
      },
    },
    {
      name: "get_quartermaster",
      description:
        "Fetch the acquisition plan for the next N raids: items to buy/barter/craft/find-in-raid with routes, costs, gates, and craft schedule (CONTRACTS §7 shape).",
      input: z.object({ raids: z.number().int().min(1).max(20).optional() }),
      endpoint: "GET /api/quartermaster",
      run: async (args) => {
        const raids = typeof args["raids"] === "number" ? `?raids=${args["raids"]}` : "";
        return jsonResult(await service.get(`/api/quartermaster${raids}`));
      },
    },
    {
      name: "get_story",
      description:
        "Fetch the curated story dataset with per-chapter player status: chapters, stages, decision points, endings, and which endings remain reachable.",
      input: z.object({}),
      endpoint: "GET /api/story",
      run: async () => jsonResult(await service.get("/api/story")),
    },
    {
      name: "get_foresight",
      description:
        "Fetch all pending irreversibility warnings for the current goals: task-exclusivity conflicts (completing one task fails another), XP-gate stalls (the planned route reaches a level-gated goal task under-leveled — kind:'xp-gate' with requiredLevel/projectedLevel/levelsShort/raidsShort/message), and story decisions that lock endings. Use this to answer 'what's about to gate or lock me?'.",
      input: z.object({}),
      endpoint: "GET /api/foresight",
      run: async () => jsonResult(await service.get("/api/foresight")),
    },
    {
      name: "get_sources_status",
      description:
        "Fetch the health of every external data source the service reads (tarkov.dev, TarkovTracker, EFT wiki, etc.): per-source {id, up, apiVersion?, lastFetch?, cacheAgeSec?, quota?, lastError?}. Use this to answer 'what's my source/data-feed status?' or to warn that a fact may be stale because a source is down.",
      input: z.object({}),
      endpoint: "GET /api/sources/status",
      run: async () => jsonResult(await service.get("/api/sources/status")),
    },
    {
      name: "get_connectors",
      description:
        "Fetch the registered local device/config connectors (EFT config, Wootility, manual capture, NVIDIA, SteelSeries Sonar): per-connector {id, vendor, capabilities, riskTier, health}. Use this to answer 'what's my connector status?' / which integrations are connected.",
      input: z.object({}),
      endpoint: "GET /api/connectors",
      run: async () => jsonResult(await service.get("/api/connectors")),
    },
    {
      name: "set_goals",
      description:
        "Persist the player's goals and planner weights. goals: array of {type:'kappa'}|{type:'lightkeeper'}|{type:'level',level}|{type:'tasks',ids}. weights: {task,xp,criticality,mapCost} where mapCost maps a map name to a cost multiplier (>1 aversion, <1 preference).",
      input: z.object({
        goals: z.array(GoalSchema),
        weights: PlannerWeightsSchema.optional(),
      }),
      endpoint: "POST /api/goals",
      run: async (args) => {
        const parsed = z
          .object({ goals: z.array(GoalSchema), weights: PlannerWeightsSchema.optional() })
          .parse(args);
        return jsonResult(await service.post("/api/goals", parsed));
      },
    },
    {
      name: "lookup_task",
      description:
        "Search for a task by (partial) name via the service. Returns matching tasks and the graph summary (kappa/lightkeeper remaining counts).",
      input: z.object({ name: z.string().min(1) }),
      endpoint: "GET /api/graph/task",
      run: async (args) => {
        const name = String(args["name"]);
        // Preferred route (documented service extension); fall back to scanning
        // the graph summary + plan when the service doesn't ship it.
        try {
          return jsonResult(await service.get(`/api/graph/task?name=${encodeURIComponent(name)}`));
        } catch (err) {
          if (!(err instanceof ServiceError) || err.status !== 404) throw err;
        }
        const summary = await service.get("/api/graph/summary");
        const planRaw = (await service.get("/api/plan")) as
          | { plan?: { raids?: { map: string; tasks?: { id: string; name: string }[] }[] }; raids?: never }
          | { raids?: { map: string; tasks?: { id: string; name: string }[] }[] }
          | null;
        // live service wraps the Plan in {hash, plan}; tolerate flat too
        const plan =
          planRaw && typeof planRaw === "object" && "plan" in planRaw && planRaw.plan
            ? planRaw.plan
            : (planRaw as { raids?: { map: string; tasks?: { id: string; name: string }[] }[] } | null);
        const needle = name.toLowerCase();
        const matches: { id: string; name: string; map: string }[] = [];
        for (const raid of plan?.raids ?? []) {
          for (const t of raid.tasks ?? []) {
            if (t.name.toLowerCase().includes(needle)) matches.push({ ...t, map: raid.map });
          }
        }
        return jsonResult({ query: name, matches, summary });
      },
    },
    {
      name: "wiki_cite",
      description:
        "Construct the official EFT wiki URL for a task name so the answer can cite it. Pure string construction — performs no network request.",
      input: z.object({ taskName: z.string().min(1) }),
      endpoint: "wiki URL (no network)",
      run: async (args) => jsonResult({ taskName: args["taskName"], url: wikiCiteUrl(String(args["taskName"])) }),
    },
  ];
}
