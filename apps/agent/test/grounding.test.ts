import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSystemPrompt, GROUNDING_RULE } from "../src/grounding.js";
import { buildToolBelt } from "../src/tools.js";
import { MockClient } from "../src/model.js";
import { ServiceClient } from "../src/service.js";
import { startStubService, type StubService } from "./stub-service.js";

let stub: StubService;
let service: ServiceClient;

beforeAll(async () => {
  stub = await startStubService();
  service = new ServiceClient(stub.url);
});
afterAll(async () => {
  await stub.close();
});

describe("system prompt (M4.1 grounding)", () => {
  it("contains the absolute grounding rule verbatim", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(GROUNDING_RULE);
    expect(GROUNDING_RULE).toMatch(/NEVER state a game fact/);
  });

  it("requires citing the source tool and forbids filling gaps from memory", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("cite which tool");
    expect(prompt).toContain("Never fill gaps from memory");
  });

  it("forbids speculation about unreleased content (1.1.0)", () => {
    expect(buildSystemPrompt()).toContain("Refuse to speculate about EFT version 1.1.0");
  });
});

describe("tool plumbing carries real service JSON into replies", () => {
  it("a state question is answered from get_state, cited", async () => {
    const client = new MockClient();
    const result = await client.complete({
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: "what level am I?" }],
      tools: buildToolBelt(service),
    });
    // 15 comes from the stub service response, not from the model
    expect(result.text).toContain("level 15");
    expect(result.text).toContain("(get_state)");
    expect(result.toolCalls.map((c) => c.tool)).toContain("get_state");
  });

  it("a plan question is answered from get_plan with the stub's map", async () => {
    const client = new MockClient();
    const result = await client.complete({
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: "what is the plan tonight?" }],
      tools: buildToolBelt(service),
    });
    expect(result.text).toContain("customs");
    expect(result.toolCalls.map((c) => c.tool)).toContain("get_plan");
  });

  it("unreleased-content questions are refused with zero tool calls and zero invented facts", async () => {
    const client = new MockClient();
    const result = await client.complete({
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: "what maps are coming in 1.1.0?" }],
      tools: buildToolBelt(service),
    });
    expect(result.text).toMatch(/can't speculate|unreleased/i);
    expect(result.toolCalls).toHaveLength(0);
  });

  it("tool failures surface as errors instead of invented answers", async () => {
    const deadService = new ServiceClient("http://127.0.0.1:1");
    const client = new MockClient();
    await expect(
      client.complete({
        system: buildSystemPrompt(),
        messages: [{ role: "user", content: "what level am I?" }],
        tools: buildToolBelt(deadService),
      }),
    ).rejects.toThrow(/get_state failed/);
  });
});
