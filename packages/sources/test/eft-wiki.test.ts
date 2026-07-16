import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/cache.js";
import { DEFAULT_USER_AGENT } from "../src/http.js";
import {
  STORY_TTL_MS,
  createEftWikiSource,
  eftWikiStoryRequest,
  type WikiStoryContent,
} from "../src/sources/eft-wiki.js";
import { jsonResponse, mutableMsClock, scriptedFetch, statusResponse } from "./helpers.js";

const PARSE: unknown = JSON.parse(
  readFileSync(resolve(fileURLToPath(import.meta.url), "../fixtures/eft-wiki-parse.json"), "utf8"),
);
const FIXED = "2026-01-01T00:00:00.000Z";
const PAGE = "The Blood of War - Part 1";

describe("eft-wiki source (fixtures)", () => {
  it("advertises story, kind mediawiki, read-only (no quota)", () => {
    const source = createEftWikiSource();
    expect(source.id).toBe("eft-wiki");
    expect(source.kind).toBe("mediawiki");
    expect(source.capabilities).toEqual(["story"]);
    expect(source.quota).toBeUndefined();
    expect(source.baseUrl).toContain("fandom.com");
  });

  it("fetches a page, extracts wikitext, stamps a provenance-tagged story reading, sends a real UA", async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(PARSE, { etag: "story-v1" })]);
    const source = createEftWikiSource({ fetchImpl, clock: () => FIXED });

    const reading = await source.fetch<WikiStoryContent>(eftWikiStoryRequest(PAGE));
    expect(reading.sourceId).toBe("eft-wiki");
    expect(reading.capability).toBe("story");
    expect(reading.fetchedAt).toBe(FIXED);
    expect(reading.fromCache).toBe(false);
    expect(reading.etag).toBe("story-v1");

    expect(reading.data.page).toBe(PAGE);
    expect(reading.data.title).toBe("The Blood of War - Part 1");
    expect(reading.data.pageId).toBe(21456);
    expect(reading.data.wikitext).toContain("Deliver the fuel to Skier");

    // MUST send a real User-Agent — Fandom 403/402s naive fetchers.
    const headers = calls[0]?.init?.headers ?? {};
    expect(headers["User-Agent"]).toBe(DEFAULT_USER_AGENT);
    expect(calls[0]?.url).toContain("action=parse");
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("page")).toBe(PAGE);
  });

  it("honors an overridden User-Agent", async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(PARSE)]);
    const source = createEftWikiSource({ fetchImpl, userAgent: "my-agent/9.9" });
    await source.fetch(eftWikiStoryRequest(PAGE));
    expect(calls[0]?.init?.headers?.["User-Agent"]).toBe("my-agent/9.9");
  });

  it("TTL hit serves from cache and skips the network entirely", async () => {
    const clock = mutableMsClock(0);
    const cache = new TtlCache(clock.now);
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(PARSE, { etag: "story-v1" })]);
    const source = createEftWikiSource({ fetchImpl, cache, now: clock.now, clock: () => FIXED });

    const first = await source.fetch(eftWikiStoryRequest(PAGE));
    expect(first.fromCache).toBe(false);

    clock.advance(1000); // well within the long story TTL
    const second = await source.fetch(eftWikiStoryRequest(PAGE));
    expect(second.fromCache).toBe(true);
    expect((second.data as WikiStoryContent).wikitext).toContain("Deliver the fuel");
    expect(calls.length).toBe(1); // network hit exactly once
  });

  it("revalidates with a 304 after the TTL expires and serves from cache", async () => {
    const clock = mutableMsClock(0);
    const cache = new TtlCache(clock.now);
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse(PARSE, { etag: "story-v1" }),
      statusResponse(304, { etag: "story-v1" }),
    ]);
    const source = createEftWikiSource({ fetchImpl, cache, now: clock.now, clock: () => FIXED });

    await source.fetch(eftWikiStoryRequest(PAGE));
    clock.advance(STORY_TTL_MS + 1);

    const revalidated = await source.fetch<WikiStoryContent>(eftWikiStoryRequest(PAGE));
    expect(revalidated.fromCache).toBe(true);
    expect(revalidated.data.wikitext).toContain("Deliver the fuel");
    expect(calls.length).toBe(2);
    expect(calls[1]?.init?.headers?.["If-None-Match"]).toBe("story-v1");
  });

  it("tolerates odd/missing fields (bare-string wikitext, absent title/pageid, empty body)", async () => {
    const { fetchImpl } = scriptedFetch([
      // formatversion=2 style: wikitext is a bare string, no title/pageid.
      jsonResponse({ parse: { wikitext: "raw story text" } }),
    ]);
    const source = createEftWikiSource({ fetchImpl });
    const reading = await source.fetch<WikiStoryContent>(eftWikiStoryRequest("Prapor"));
    expect(reading.data.page).toBe("Prapor");
    expect(reading.data.wikitext).toBe("raw story text");
    expect(reading.data.title).toBeUndefined();
    expect(reading.data.pageId).toBeUndefined();

    // A completely unexpected shape → empty wikitext, never throws.
    const { fetchImpl: f2 } = scriptedFetch([jsonResponse({ unexpected: true })]);
    const s2 = createEftWikiSource({ fetchImpl: f2 });
    const r2 = await s2.fetch<WikiStoryContent>(eftWikiStoryRequest("X"));
    expect(r2.data.wikitext).toBe("");
  });

  it("rejects a non-story capability", async () => {
    const source = createEftWikiSource();
    await expect(
      source.fetch({ capability: "prices", path: "/api.php?x=1" }),
    ).rejects.toThrow(/cannot satisfy/);
  });

  it("health probes siteinfo → connected, sniffs the MediaWiki generator", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse({ query: { general: { generator: "MediaWiki 1.39.7" } } }),
    ]);
    const source = createEftWikiSource({ fetchImpl });
    expect(await source.health()).toBe("connected");
    expect(source.stats?.().apiVersion).toBe("MediaWiki 1.39.7");
    expect(calls[0]?.url).toContain("meta=siteinfo");
    expect(calls[0]?.init?.headers?.["User-Agent"]).toBe(DEFAULT_USER_AGENT);
  });

  it("health returns error and records lastError when the probe fails (403 — Fandom bot-block)", async () => {
    const { fetchImpl } = scriptedFetch([statusResponse(403)]);
    const source = createEftWikiSource({ fetchImpl, sleep: async () => {} });
    expect(await source.health()).toBe("error");
    expect(source.stats?.().lastError).toMatch(/HTTP 403/);
  });

  it.skipIf(!process.env["TAC_LIVE"])("live smoke: siteinfo is reachable", async () => {
    const source = createEftWikiSource();
    expect(await source.health()).toBe("connected");
  });
});
