import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildToolBelt, wikiCiteUrl } from "../src/tools.js";
import { zodToJsonSchema } from "../src/model.js";
import { ServiceClient } from "../src/service.js";
import { GoalSchema } from "../src/types.js";
import { startStubService, STUB_STATE, type StubService } from "./stub-service.js";

let stub: StubService;
let service: ServiceClient;

beforeAll(async () => {
  stub = await startStubService();
  service = new ServiceClient(stub.url);
});
afterAll(async () => {
  await stub.close();
});

describe("wiki_cite (pure URL construction, no network)", () => {
  it("builds the fandom URL from a task name", () => {
    expect(wikiCiteUrl("Debut")).toBe("https://escapefromtarkov.fandom.com/wiki/Debut");
  });

  it("replaces spaces with underscores and keeps punctuation URL-safe", () => {
    expect(wikiCiteUrl("The Punisher - Part 1")).toBe(
      "https://escapefromtarkov.fandom.com/wiki/The_Punisher_-_Part_1",
    );
  });

  it("the tool executor returns the URL without performing any request", async () => {
    const belt = buildToolBelt(new ServiceClient("http://127.0.0.1:1")); // unreachable on purpose
    const tool = belt.find((t) => t.name === "wiki_cite")!;
    const result = JSON.parse(await tool.run({ taskName: "Shortage" })) as { url: string };
    expect(result.url).toContain("/wiki/Shortage");
  });
});

describe("tool belt against the stub service", () => {
  it("exposes exactly the CONTRACTS §8 tool names", () => {
    const names = buildToolBelt(service).map((t) => t.name);
    expect(names).toEqual([
      "get_state",
      "get_plan",
      "get_quartermaster",
      "get_story",
      "get_foresight",
      "set_goals",
      "lookup_task",
      "wiki_cite",
    ]);
  });

  it("get_state passes the real service JSON through verbatim", async () => {
    const tool = buildToolBelt(service).find((t) => t.name === "get_state")!;
    expect(JSON.parse(await tool.run({}))).toEqual(STUB_STATE);
  });

  it("get_plan returns the live envelope with the Plan nested under plan", async () => {
    const tool = buildToolBelt(service).find((t) => t.name === "get_plan")!;
    const res = JSON.parse(await tool.run({ horizon: 5 })) as { hash: string; plan: { raids: unknown[] } };
    expect(res.hash).toBe("stub-plan-hash-1");
    expect(res.plan.raids).toHaveLength(2);
  });

  it("set_goals validates input and POSTs to /api/goals", async () => {
    const tool = buildToolBelt(service).find((t) => t.name === "set_goals")!;
    const before = stub.goalsPosts.length;
    await tool.run({ goals: [{ type: "level", level: 30 }] });
    expect(stub.goalsPosts.length).toBe(before + 1);
    expect(stub.goalsPosts.at(-1)).toMatchObject({ goals: [{ type: "level", level: 30 }] });
  });

  it("lookup_task falls back to scanning the plan when /api/graph/task is absent (404)", async () => {
    const tool = buildToolBelt(service).find((t) => t.name === "lookup_task")!;
    const result = JSON.parse(await tool.run({ name: "shortage" })) as {
      matches: { id: string; name: string; map: string }[];
      summary: { kappaRemaining: number };
    };
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ id: "task-shoreline-prep", name: "Shortage", map: "customs" });
    expect(result.summary.kappaRemaining).toBe(240);
  });
});

describe("zodToJsonSchema (ApiClient tool wire format)", () => {
  it("converts objects with optionals, enums, arrays and records", () => {
    const schema = z.object({
      name: z.string(),
      horizon: z.number().optional(),
      kind: z.enum(["a", "b"]),
      ids: z.array(z.string()),
      mapCost: z.record(z.string(), z.number()),
    });
    const json = zodToJsonSchema(schema);
    expect(json["type"]).toBe("object");
    expect(json["required"]).toEqual(["name", "kind", "ids", "mapCost"]);
    expect(json["properties"].horizon).toEqual({ type: "number" });
    expect(json["properties"].kind).toEqual({ enum: ["a", "b"] });
    expect(json["properties"].ids).toEqual({ type: "array", items: { type: "string" } });
    expect(json["properties"].mapCost).toEqual({ type: "object", additionalProperties: { type: "number" } });
  });

  it("converts the Goal discriminated union", () => {
    const json = zodToJsonSchema(z.object({ goals: z.array(GoalSchema) }));
    const variants = json["properties"].goals.items.anyOf as { properties: Record<string, unknown> }[];
    expect(variants).toHaveLength(4);
    expect(variants.map((v) => v.properties["type"])).toEqual([
      { const: "kappa" },
      { const: "lightkeeper" },
      { const: "level" },
      { const: "tasks" },
    ]);
  });
});
