import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BRIEFING_WORD_CAP,
  generateBriefing,
  truncateAtSentence,
  wordCount,
} from "../src/briefing.js";
import { MockClient } from "../src/model.js";
import { ServiceClient } from "../src/service.js";
import { startStubService, STUB_FORESIGHT, STUB_PLAN, STUB_QM, type StubService } from "./stub-service.js";

let stub: StubService;
let service: ServiceClient;

beforeAll(async () => {
  stub = await startStubService();
  service = new ServiceClient(stub.url);
});
afterAll(async () => {
  await stub.close();
});

describe("word-cap helpers", () => {
  it("wordCount counts whitespace-separated words", () => {
    expect(wordCount("  one two   three ")).toBe(3);
    expect(wordCount("")).toBe(0);
  });

  it("truncateAtSentence cuts at a sentence boundary under the cap", () => {
    const text = "First sentence has five words. Second sentence also has five words. Third one.";
    const out = truncateAtSentence(text, 11);
    expect(out).toBe("First sentence has five words. Second sentence also has five words.");
  });

  it("truncateAtSentence hard-cuts a single giant sentence", () => {
    const text = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ");
    const out = truncateAtSentence(text, 10);
    expect(wordCount(out)).toBe(10);
  });
});

describe("per-raid briefing (M4.3)", () => {
  it("stays under 200 words and covers map, batch, bring-list and warnings", async () => {
    const { briefing, toolCalls, truncated } = await generateBriefing(new MockClient(), service, 1);

    expect(wordCount(briefing)).toBeLessThan(BRIEFING_WORD_CAP);
    expect(truncated).toBe(false);
    // structure: map, batch with a why, bring-list, warnings
    expect(briefing).toContain("customs");
    expect(briefing).toContain("Background Check");
    expect(briefing).toContain("unlocks the Prapor chain");
    expect(briefing).toContain("Salewa");
    expect(briefing).toContain("Chemical - Part 4");
    // grounded exclusively in tools
    const tools = toolCalls.map((c) => c.tool);
    for (const required of ["get_plan", "get_quartermaster", "get_foresight", "get_story"]) {
      expect(tools).toContain(required);
    }
  });

  it("briefs the requested raid index", async () => {
    const { briefing } = await generateBriefing(new MockClient(), service, 2);
    expect(briefing).toContain("Raid 2");
    expect(briefing).toContain("shoreline");
  });

  it("every number in the briefing comes from tool results (factual consistency)", async () => {
    const { briefing } = await generateBriefing(new MockClient(), service, 1);
    const toolJson = JSON.stringify([STUB_PLAN, STUB_QM, STUB_FORESIGHT]);
    const toolNumbers = new Set((toolJson.match(/\d+(?:\.\d+)?/g) ?? []).map(Number));
    const briefingNumbers = (briefing.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    expect(briefingNumbers.length).toBeGreaterThan(0);
    for (const n of briefingNumbers) {
      expect(toolNumbers, `briefing number ${n} must appear in a tool result`).toContain(n);
    }
  });

  it("regenerates once when the first draft is over the cap", async () => {
    // over the cap exactly once -> the strict retry lands under it
    const client = new MockClient({ longBriefings: 1 });
    const { briefing, truncated, toolCalls } = await generateBriefing(client, service, 1);
    expect(truncated).toBe(false);
    expect(wordCount(briefing)).toBeLessThan(BRIEFING_WORD_CAP);
    // two full tool passes (regeneration re-gathers data)
    expect(toolCalls.filter((c) => c.tool === "get_plan").length).toBe(2);
  });

  it("hard-truncates at a sentence boundary when the retry is over the cap too", async () => {
    const client = new MockClient({ longBriefings: 2 });
    const { briefing, truncated } = await generateBriefing(client, service, 1);
    expect(truncated).toBe(true);
    expect(wordCount(briefing)).toBeLessThanOrEqual(BRIEFING_WORD_CAP);
    expect(briefing.length).toBeGreaterThan(0);
  });
});
