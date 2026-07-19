import { z } from "zod";
import type { AgentTool } from "./tools.js";
import { BackendUnavailableError, DEFAULT_WEIGHTS, type AgentBackend, type ToolCallRecord } from "./types.js";

/**
 * ModelClient abstraction (M4.1): one interface, three backends.
 *  - AgentSdkClient — @anthropic-ai/claude-agent-sdk. Rides this machine's
 *    Claude Code login (no API key needed); tools are exposed as an in-process
 *    SDK MCP server. The live default.
 *  - ApiClient — plain @anthropic-ai/sdk manual tool loop; needs
 *    ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN).
 *  - MockClient — deterministic canned responses driven by a scenario table;
 *    executes the REAL tool executors so tests exercise the full service
 *    plumbing without any Claude auth (TAC_AGENT_MOCK=1).
 * @tier T0
 */

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompleteOptions {
  system: string;
  messages: ChatMessage[];
  tools: AgentTool[];
  /** Force this tool to be called (JSON extraction); backend-specific mechanics. */
  forceTool?: string;
  maxTokens?: number;
}

export interface CompleteResult {
  text: string;
  toolCalls: ToolCallRecord[];
}

export interface ModelClient {
  readonly backend: AgentBackend;
  /** Cheap, non-billing availability check. */
  available(): Promise<{ ok: boolean; detail?: string }>;
  complete(opts: CompleteOptions): Promise<CompleteResult>;
}

const MAX_LOOP_ITERATIONS = 12;
const DEFAULT_MODEL = () => process.env["TAC_AGENT_MODEL"] ?? "claude-opus-4-8";

function summarizeArgs(args: unknown): string {
  const s = JSON.stringify(args ?? {});
  return s.length > 200 ? `${s.slice(0, 197)}...` : s;
}

/** Validate + execute a tool call; returns a model-visible result string. */
async function executeTool(
  tool: AgentTool,
  rawArgs: unknown,
  toolCalls: ToolCallRecord[],
): Promise<{ ok: boolean; result: string }> {
  toolCalls.push({ tool: tool.name, argsSummary: summarizeArgs(rawArgs), detail: tool.endpoint });
  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { ok: false, result: `Invalid input for ${tool.name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Fix the arguments and call the tool again.` };
  }
  try {
    return { ok: true, result: await tool.run(parsed.data) };
  } catch (err) {
    return { ok: false, result: `Tool ${tool.name} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// zod -> JSON Schema (minimal, covers the shapes the tool belt uses)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, any> {
  const def = schema._def as { typeName: string };
  const d = def as unknown as Record<string, unknown>;
  switch (def.typeName) {
    case "ZodObject": {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value as z.ZodTypeAny);
        if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) required.push(key);
      }
      return { type: "object", properties, required, additionalProperties: false };
    }
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodLiteral":
      return { const: d["value"] };
    case "ZodEnum":
      return { enum: d["values"] as string[] };
    case "ZodArray":
      return { type: "array", items: zodToJsonSchema(d["type"] as z.ZodTypeAny) };
    case "ZodRecord":
      return { type: "object", additionalProperties: zodToJsonSchema(d["valueType"] as z.ZodTypeAny) };
    case "ZodOptional":
    case "ZodDefault":
    case "ZodNullable":
      return zodToJsonSchema(d["innerType"] as z.ZodTypeAny);
    case "ZodUnion":
      return { anyOf: (d["options"] as z.ZodTypeAny[]).map(zodToJsonSchema) };
    case "ZodDiscriminatedUnion": {
      const options = d["options"] as Map<string, z.ZodTypeAny> | z.ZodTypeAny[];
      return { anyOf: [...options.values()].map(zodToJsonSchema) };
    }
    default:
      throw new Error(`zodToJsonSchema: unsupported type ${def.typeName}`);
  }
}

// ---------------------------------------------------------------------------
// ApiClient — plain Anthropic API, manual tool loop
// ---------------------------------------------------------------------------

export class ApiClient implements ModelClient {
  readonly backend: AgentBackend = "api";

  async available(): Promise<{ ok: boolean; detail?: string }> {
    if (process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"]) return { ok: true };
    return { ok: false, detail: "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN), or use TAC_AGENT_BACKEND=agent-sdk to ride the Claude Code login." };
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const availability = await this.available();
    if (!availability.ok) {
      throw new BackendUnavailableError("Anthropic API backend has no credentials.", availability.detail ?? "");
    }
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();

    const apiTools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: zodToJsonSchema(t.input) as { type: "object"; [k: string]: unknown },
    }));

    type ApiMessage = { role: "user" | "assistant"; content: unknown };
    const messages: ApiMessage[] = opts.messages.map((m) => ({ role: m.role, content: m.content }));
    const toolCalls: ToolCallRecord[] = [];
    let forcedToolDone = false;

    for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
      const forceName = forcedToolDone ? undefined : opts.forceTool;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response: any = await client.messages.create({
        model: DEFAULT_MODEL(),
        max_tokens: opts.maxTokens ?? 4096,
        system: opts.system,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: messages as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: apiTools as any,
        // forced tool_choice is incompatible with thinking, so adaptive
        // thinking is enabled only on non-forced calls.
        ...(forceName !== undefined
          ? { tool_choice: { type: "tool" as const, name: forceName } }
          : { thinking: { type: "adaptive" as const } }),
      });

      const toolUses = (response.content as { type: string }[]).filter((b) => b.type === "tool_use") as {
        type: "tool_use";
        id: string;
        name: string;
        input: unknown;
      }[];

      if (toolUses.length === 0 || response.stop_reason === "end_turn" || response.stop_reason === "refusal") {
        const text = (response.content as { type: string; text?: string }[])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");
        return { text, toolCalls };
      }

      messages.push({ role: "assistant", content: response.content });
      const results: unknown[] = [];
      for (const use of toolUses) {
        const tool = opts.tools.find((t) => t.name === use.name);
        if (!tool) {
          results.push({ type: "tool_result", tool_use_id: use.id, content: `Unknown tool ${use.name}`, is_error: true });
          continue;
        }
        const outcome = await executeTool(tool, use.input, toolCalls);
        if (outcome.ok && use.name === opts.forceTool) forcedToolDone = true;
        results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.result, is_error: !outcome.ok });
      }
      messages.push({ role: "user", content: results });
    }
    throw new Error(`ApiClient: tool loop exceeded ${MAX_LOOP_ITERATIONS} iterations`);
  }
}

// ---------------------------------------------------------------------------
// AgentSdkClient — Claude Agent SDK (Claude Code harness, local login)
// ---------------------------------------------------------------------------

const BUILTIN_TOOLS_OFF = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch",
  "Task", "TodoWrite", "NotebookEdit", "Skill", "KillShell", "BashOutput",
];

export class AgentSdkClient implements ModelClient {
  readonly backend: AgentBackend = "agent-sdk";

  async available(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await import("@anthropic-ai/claude-agent-sdk");
    } catch (err) {
      return { ok: false, detail: `@anthropic-ai/claude-agent-sdk failed to load: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"]) {
      return { ok: true, detail: "agent-sdk loads; API credentials found in the environment" };
    }
    // Cheap login heuristic: the standalone Claude Code CLI persists its OAuth
    // login as `claudeAiOauth` in ~/.claude/.credentials.json. The Claude
    // Desktop app's login lives inside the app sandbox and is NOT visible to a
    // spawned SDK process (verified live on this machine 2026-07-11).
    try {
      const { readFile } = await import("node:fs/promises");
      const { homedir } = await import("node:os");
      const { join } = await import("node:path");
      const raw = await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8");
      if (raw.includes("claudeAiOauth")) {
        return { ok: true, detail: "agent-sdk loads; Claude Code CLI login found on disk" };
      }
    } catch {
      /* no credentials file — fall through */
    }
    return {
      ok: false,
      detail:
        "No usable Claude auth for a spawned agent-sdk process: run `claude /login` with the standalone Claude Code CLI, or set ANTHROPIC_API_KEY (TAC_AGENT_BACKEND=api).",
    };
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const sdk = await import("@anthropic-ai/claude-agent-sdk").catch((err: unknown) => {
      throw new BackendUnavailableError(
        `Claude Agent SDK unavailable: ${err instanceof Error ? err.message : String(err)}`,
        "Reinstall deps (pnpm install) or switch to TAC_AGENT_BACKEND=api with ANTHROPIC_API_KEY set.",
      );
    });

    const toolCalls: ToolCallRecord[] = [];
    const sdkTools = opts.tools.map((t) =>
      sdk.tool(t.name, t.description, t.input.shape, async (args: Record<string, unknown>) => {
        const outcome = await executeTool(t, args, toolCalls);
        return { content: [{ type: "text" as const, text: outcome.result }], ...(outcome.ok ? {} : { isError: true }) };
      }),
    );
    const server = sdk.createSdkMcpServer({ name: "tac", version: "1.0.0", tools: sdkTools });

    const history = opts.messages
      .map((m) => `${m.role === "user" ? "Player" : "Copilot"}: ${m.content}`)
      .join("\n\n");
    const forceNote = opts.forceTool
      ? `\n\nYou MUST call the tool ${opts.forceTool} exactly once with your extraction before answering. Do not answer without calling it.`
      : "";
    const prompt = `${history}${forceNote}\n\nRespond to the player's last message.`;

    const model = process.env["TAC_AGENT_MODEL"];
    const q = sdk.query({
      prompt,
      options: {
        systemPrompt: opts.system,
        mcpServers: { tac: server },
        allowedTools: opts.tools.map((t) => `mcp__tac__${t.name}`),
        disallowedTools: BUILTIN_TOOLS_OFF,
        permissionMode: "dontAsk",
        maxTurns: MAX_LOOP_ITERATIONS,
        ...(model ? { model } : {}),
      },
    });

    try {
      for await (const message of q) {
        if (message.type === "assistant" && message.error === "authentication_failed") {
          throw new BackendUnavailableError(
            "Claude Code authentication failed.",
            "Log in with `claude` (Claude Code) on this machine, or switch to TAC_AGENT_BACKEND=api with ANTHROPIC_API_KEY.",
          );
        }
        if (message.type === "result") {
          if (message.subtype === "success" && !message.is_error) return { text: message.result, toolCalls };
          // A "successful" result can still carry is_error (observed live:
          // result text "Not logged in · Please run /login").
          const detail = message.subtype === "success" ? message.result : message.errors.join("; ");
          if (/not logged in|please run \/login|authentication/i.test(detail)) {
            throw new BackendUnavailableError(
              `Claude Code is not logged in: ${detail}`,
              "Run `claude /login` on this machine (standalone CLI), or set TAC_AGENT_BACKEND=api with ANTHROPIC_API_KEY.",
            );
          }
          throw new Error(`agent-sdk query failed: ${message.subtype} (${detail})`);
        }
      }
    } catch (err) {
      if (err instanceof BackendUnavailableError) throw err;
      throw new BackendUnavailableError(
        `Claude Agent SDK query failed: ${err instanceof Error ? err.message : String(err)}`,
        "Ensure Claude Code is installed and logged in on this machine, or switch to TAC_AGENT_BACKEND=api with ANTHROPIC_API_KEY.",
      );
    }
    throw new Error("agent-sdk query ended without a result message");
  }
}

// ---------------------------------------------------------------------------
// MockClient — deterministic scenario table (TAC_AGENT_MOCK=1)
// ---------------------------------------------------------------------------

export interface MockOptions {
  /** Emit invalid args on the first forced-tool call (tests intake retry). */
  badFirstForcedCall?: boolean;
  /** Produce an over-200-word briefing this many times (tests the word cap). */
  longBriefings?: number;
}

interface PlanLike {
  raids?: { index: number; map: string; levelBefore?: number; levelAfter?: number; tasks?: { id: string; name: string; reasons?: string[] }[] }[];
}
interface QmLike {
  items?: { name: string; count: number; fir?: boolean; route?: { kind?: string; detail?: string; totalCost?: number } }[];
  totalRubles?: number;
}
interface ForesightLike {
  warnings?: {
    kind?: string;
    completing?: { name?: string };
    fails?: { name?: string }[];
    severity?: string;
    /** XP-gate stalls carry a preformatted message + the gated task. */
    message?: string;
    task?: { name?: string };
  }[];
}
interface SourceStatusLike {
  id: string;
  up: boolean;
}
interface ConnectorLike {
  id: string;
  health?: string;
}

/** GET /api/plan returns the Plan wrapped in {hash, plan} (live service) or flat. */
export function unwrapPlan(raw: unknown): PlanLike {
  if (raw && typeof raw === "object" && "plan" in (raw as Record<string, unknown>)) {
    const inner = (raw as { plan?: unknown }).plan;
    if (inner && typeof inner === "object") return inner as PlanLike;
  }
  return (raw ?? {}) as PlanLike;
}

/** Deterministic canned model. Executes the real tool executors so tests cover service plumbing. */
export class MockClient implements ModelClient {
  readonly backend: AgentBackend = "mock";
  private badCallSpent = false;
  private longBriefingsLeft: number;

  constructor(private readonly opts: MockOptions = {}) {
    this.longBriefingsLeft = opts.longBriefings ?? 0;
  }

  async available(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const toolCalls: ToolCallRecord[] = [];
    const lastUser = [...opts.messages].reverse().find((m) => m.role === "user")?.content ?? "";

    const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      const tool = opts.tools.find((t) => t.name === name);
      if (!tool) throw new Error(`mock scenario needs tool ${name}, not in belt`);
      const outcome = await executeTool(tool, args, toolCalls);
      if (!outcome.ok) throw new Error(outcome.result);
      return JSON.parse(outcome.result);
    };

    // Scenario: forced JSON extraction (goals intake)
    if (opts.forceTool) {
      const tool = opts.tools.find((t) => t.name === opts.forceTool);
      if (!tool) throw new Error(`forced tool ${opts.forceTool} not in belt`);
      const args = parseGoalsFromText(lastUser);
      if (this.opts.badFirstForcedCall && !this.badCallSpent) {
        this.badCallSpent = true;
        // deliberately invalid: goals as a bare string — the loop reports the
        // validation error back to the "model", which then retries correctly.
        const bad = await executeTool(tool, { goals: "kappa" }, toolCalls);
        if (bad.ok) throw new Error("mock expected the invalid forced call to fail validation");
      }
      const outcome = await executeTool(tool, args, toolCalls);
      if (!outcome.ok) return { text: `Could not record goals: ${outcome.result}`, toolCalls };
      return { text: "Goals recorded (set via emit_goals).", toolCalls };
    }

    // Scenario: briefing
    if (lastUser.startsWith("BRIEFING_REQUEST")) {
      const raidIndex = Number(/raidIndex=(\d+)/.exec(lastUser)?.[1] ?? "1");
      const plan = unwrapPlan(await call("get_plan"));
      const qm = (await call("get_quartermaster")) as QmLike;
      const foresight = (await call("get_foresight")) as ForesightLike;
      await call("get_story");
      let text = composeMockBriefing(raidIndex, plan, qm, foresight);
      if (this.longBriefingsLeft > 0) {
        this.longBriefingsLeft--;
        text += ` ${"The map rotation favours patient play and the copilot pads this sentence deliberately to overflow the word budget for testing purposes only." .split(" ").join(" ")}`.repeat(20);
      }
      return { text, toolCalls };
    }

    // Scenario: multi-tool session plan — the headline grounded answer that
    // fuses plan + foresight + source health into one cited reply.
    if (/prioriti|session|focus|what should i|game ?plan|do tonight/i.test(lastUser)) {
      const plan = unwrapPlan(await call("get_plan"));
      const foresight = (await call("get_foresight")) as ForesightLike;
      const sources = (await call("get_sources_status")) as SourceStatusLike[];
      const first = plan.raids?.[0];
      const gate = (foresight.warnings ?? []).find((w) => w.kind === "xp-gate");
      const down = sources.filter((s) => !s.up).map((s) => s.id);
      const parts = [
        first
          ? `Start on ${first.map} with ${first.tasks?.length ?? 0} tasks (get_plan).`
          : "No raids planned (get_plan).",
        gate?.message
          ? `Heads up (get_foresight): ${gate.message}`
          : "No XP-gate stalls pending (get_foresight).",
        down.length
          ? `Data caveat (get_sources_status): ${down.join(", ")} is down, so some numbers may be stale.`
          : "All data sources are up (get_sources_status).",
      ];
      return { text: parts.join(" "), toolCalls };
    }

    // Scenario: source / connector health (grounding-surface status)
    if (/source|connector|integration|data ?feed|tracker|offline|stale|status/i.test(lastUser)) {
      const sources = (await call("get_sources_status")) as SourceStatusLike[];
      const connectors = (await call("get_connectors")) as ConnectorLike[];
      const up = sources.filter((s) => s.up).map((s) => s.id);
      const down = sources.filter((s) => !s.up).map((s) => s.id);
      const conn = connectors.map((c) => `${c.id}: ${c.health ?? "unknown"}`).join(", ");
      return {
        text:
          `Sources up: ${up.join(", ") || "none"}` +
          `${down.length ? `; down: ${down.join(", ")}` : ""} (get_sources_status). ` +
          `Connectors (get_connectors): ${conn || "none"}.`,
        toolCalls,
      };
    }

    // Scenario: irreversibility / gating question (task-exclusivity + XP gates)
    if (/gate|lock|foresight|irreversib|miss out|about to|conflict/i.test(lastUser)) {
      const foresight = (await call("get_foresight")) as ForesightLike;
      const warnings = foresight.warnings ?? [];
      if (warnings.length === 0) {
        return { text: "Nothing is about to gate or lock you right now (get_foresight).", toolCalls };
      }
      const lines = warnings.slice(0, 3).map((w) =>
        w.kind === "xp-gate"
          ? (w.message ?? `Level gate on ${w.task?.name ?? "a task"}.`)
          : `Completing ${w.completing?.name ?? "a task"} would fail ${w.fails?.map((f) => f.name).join(", ") ?? "another task"}.`,
      );
      return { text: `Watch out (get_foresight): ${lines.join(" ")}`, toolCalls };
    }

    // Scenario: unreleased-content refusal
    if (/1\.1\.0|unreleased|next patch/i.test(lastUser)) {
      return {
        text: "I can't speculate about unreleased content — my data covers the installed patch only (no tool returns 1.1.0 data).",
        toolCalls,
      };
    }

    // Scenario: state question
    if (/level|state|progress/i.test(lastUser)) {
      const state = (await call("get_state")) as { level?: number };
      return { text: `You are level ${state.level} (get_state).`, toolCalls };
    }

    // Scenario: plan question
    if (/plan|raid|tonight/i.test(lastUser)) {
      const plan = unwrapPlan(await call("get_plan"));
      const first = plan.raids?.[0];
      return {
        text: first
          ? `Next raid: ${first.map} with ${first.tasks?.length ?? 0} tasks (get_plan).`
          : "No raids planned (get_plan returned an empty plan).",
        toolCalls,
      };
    }

    return {
      text: "I only answer from tool data. Ask about your state, plan, quartermaster, story, or goals.",
      toolCalls,
    };
  }
}

/** Deterministic keyword extraction used by the mock's goals scenario. */
export function parseGoalsFromText(text: string): { goals: unknown[]; weights: unknown; notes: string[] } {
  const lower = text.toLowerCase();
  const goals: unknown[] = [];
  if (lower.includes("kappa")) goals.push({ type: "kappa" });
  if (/light\s?keeper/.test(lower)) goals.push({ type: "lightkeeper" });
  const level = /level\s+(\d+)/.exec(lower);
  if (level) goals.push({ type: "level", level: Number(level[1]) });
  if (goals.length === 0) goals.push({ type: "kappa" });

  const mapCost: Record<string, number> = {};
  for (const m of lower.matchAll(/(?:hate|avoid|dread)\s+([a-z-]+)/g)) mapCost[m[1]!] = 1.5;
  for (const m of lower.matchAll(/(?:love|prefer|enjoy)\s+([a-z-]+)/g)) mapCost[m[1]!] = 0.75;

  const notes: string[] = [];
  if (/savior|saviour|ending/.test(lower)) {
    notes.push(
      "Story-ending guard: the Savior ending must stay reachable — foresight will flag any decision or task that locks it before prestige.",
    );
  }
  return { goals, weights: { ...DEFAULT_WEIGHTS, mapCost }, notes };
}

function composeMockBriefing(raidIndex: number, plan: PlanLike, qm: QmLike, foresight: ForesightLike): string {
  const raid = plan.raids?.find((r) => r.index === raidIndex) ?? plan.raids?.[0];
  if (!raid) return "No planned raid found (get_plan returned an empty plan).";
  const batch = (raid.tasks ?? [])
    .slice(0, 4)
    .map((t) => `${t.name}${t.reasons?.[0] ? ` — ${t.reasons[0]}` : ""}`)
    .join("; then ");
  const bring = (qm.items ?? [])
    .slice(0, 4)
    .map((i) => `${i.count}x ${i.name}${i.route?.kind ? ` (${i.route.kind}${i.route.totalCost !== undefined ? `, ${i.route.totalCost} roubles` : ""})` : ""}`)
    .join(", ");
  const warnings = (foresight.warnings ?? [])
    .slice(0, 2)
    .map((w) =>
      w.kind === "xp-gate"
        ? (w.message ?? `level gate on ${w.task?.name ?? "a task"}`)
        : `completing ${w.completing?.name ?? "a task"} fails ${w.fails?.map((f) => f.name).join(", ") ?? "another task"}`,
    )
    .join("; ");
  const parts = [
    `Raid ${raid.index} (get_plan): ${raid.map}.`,
    batch ? `Batch order: ${batch}.` : "No batched tasks.",
    bring ? `Bring (get_quartermaster): ${bring}.` : "Nothing to bring.",
    warnings ? `Warnings (get_foresight): ${warnings}.` : "No irreversibility warnings (get_foresight).",
  ];
  if (raid.levelBefore !== undefined && raid.levelAfter !== undefined) {
    parts.push(`Level ${raid.levelBefore} into the raid, ${raid.levelAfter} after.`);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function resolveBackend(): AgentBackend {
  if (process.env["TAC_AGENT_MOCK"] === "1") return "mock";
  const backend = process.env["TAC_AGENT_BACKEND"];
  if (backend === "mock" || backend === "api" || backend === "agent-sdk") return backend;
  return "agent-sdk";
}

export function createModelClient(backend: AgentBackend = resolveBackend(), mockOpts?: MockOptions): ModelClient {
  switch (backend) {
    case "mock":
      return new MockClient(mockOpts);
    case "api":
      return new ApiClient();
    case "agent-sdk":
      return new AgentSdkClient();
  }
}
