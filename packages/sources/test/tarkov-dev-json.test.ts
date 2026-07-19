import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/cache.js";
import {
  STATIC_TTL_MS,
  createTarkovDevJsonSource,
} from "../src/sources/tarkov-dev-json.js";
import { jsonResponse, mutableMsClock, scriptedFetch, statusResponse } from "./helpers.js";

const TASKS: unknown = JSON.parse(
  readFileSync(resolve(fileURLToPath(import.meta.url), "../fixtures/tarkov-dev-tasks.json"), "utf8"),
);
const FIXED = "2026-01-01T00:00:00.000Z";

describe("tarkov-dev-json source (fixtures)", () => {
  it("advertises game-data + prices, kind rest, read-only (no quota)", () => {
    const source = createTarkovDevJsonSource();
    expect(source.id).toBe("tarkov-dev-json");
    expect(source.kind).toBe("rest");
    expect(source.capabilities).toEqual(["game-data", "prices"]);
    expect(source.quota).toBeUndefined();
  });

  it("fetches, parses, caches, and stamps a fresh reading", async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(TASKS, { etag: "tasks-v1" })]);
    const source = createTarkovDevJsonSource({ fetchImpl, clock: () => FIXED });

    const reading = await source.fetch({ capability: "game-data", path: "/regular/tasks" });
    expect(reading.sourceId).toBe("tarkov-dev-json");
    expect(reading.capability).toBe("game-data");
    expect(reading.fetchedAt).toBe(FIXED);
    expect(reading.fromCache).toBe(false);
    expect(reading.etag).toBe("tasks-v1");
    expect(reading.data).toEqual(TASKS);
    expect(calls[0]?.url).toBe("https://json.tarkov.dev/regular/tasks");
  });

  it("TTL hit serves from cache and skips the network entirely", async () => {
    const clock = mutableMsClock(0);
    const cache = new TtlCache(clock.now);
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(TASKS, { etag: "tasks-v1" })]);
    const source = createTarkovDevJsonSource({ fetchImpl, cache, now: clock.now, clock: () => FIXED });

    const first = await source.fetch({ capability: "game-data", path: "/regular/tasks" });
    expect(first.fromCache).toBe(false);

    clock.advance(1000); // still well within the static TTL
    const second = await source.fetch({ capability: "game-data", path: "/regular/tasks" });
    expect(second.fromCache).toBe(true);
    expect(second.data).toEqual(TASKS);
    expect(calls.length).toBe(1); // network hit exactly once
  });

  it("revalidates with a 304 after the TTL expires and serves from cache", async () => {
    const clock = mutableMsClock(0);
    const cache = new TtlCache(clock.now);
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse(TASKS, { etag: "tasks-v1" }),
      statusResponse(304, { etag: "tasks-v1" }),
    ]);
    const source = createTarkovDevJsonSource({ fetchImpl, cache, now: clock.now, clock: () => FIXED });

    await source.fetch({ capability: "game-data", path: "/regular/tasks" });
    clock.advance(STATIC_TTL_MS + 1); // expire the cached entry

    const revalidated = await source.fetch({ capability: "game-data", path: "/regular/tasks" });
    expect(revalidated.fromCache).toBe(true);
    expect(revalidated.data).toEqual(TASKS);
    expect(calls.length).toBe(2);
    expect(calls[1]?.init?.headers?.["If-None-Match"]).toBe("tasks-v1");
  });

  it("applies the 5-minute prices TTL, not the static one", async () => {
    const clock = mutableMsClock(0);
    const cache = new TtlCache(clock.now);
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse([{ price: 100 }]),
      jsonResponse([{ price: 200 }]),
    ]);
    const source = createTarkovDevJsonSource({ fetchImpl, cache, now: clock.now, clock: () => FIXED });

    await source.fetch({ capability: "prices", path: "/regular/prices/x" });
    clock.advance(5 * 60 * 1000 + 1); // just past the 5-min prices TTL
    await source.fetch({ capability: "prices", path: "/regular/prices/x" });
    expect(calls.length).toBe(2); // re-fetched because prices expire fast
  });

  it("health probes /status → connected, sniffs a version, exposes it via stats", async () => {
    const { fetchImpl } = scriptedFetch([jsonResponse({ currentVersion: "0.16.5.1" })]);
    const source = createTarkovDevJsonSource({ fetchImpl });
    expect(await source.health()).toBe("connected");
    expect(source.stats?.().apiVersion).toBe("0.16.5.1");
  });

  it("health returns error and records lastError when /status fails", async () => {
    // Persistent 500 → httpGet exhausts retries and throws; inject a no-op sleep
    // so the retries don't actually wait.
    const { fetchImpl } = scriptedFetch([statusResponse(500)]);
    const source = createTarkovDevJsonSource({ fetchImpl, sleep: async () => {} });
    expect(await source.health()).toBe("error");
    expect(source.stats?.().lastError).toMatch(/HTTP 500/);
  });

  it.skipIf(!process.env["TAC_LIVE"])("live smoke: /status is reachable", async () => {
    const source = createTarkovDevJsonSource();
    expect(await source.health()).toBe("connected");
  });
});
