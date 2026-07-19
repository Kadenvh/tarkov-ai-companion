import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/cache.js";
import { DEFAULT_USER_AGENT } from "../src/http.js";
import { QuotaExhaustedError, QuotaLedger } from "../src/quota.js";
import {
  PROGRESS_TTL_MS,
  TARKOVTRACKER_PROGRESS_REQUEST,
  createTarkovTrackerSource,
} from "../src/sources/tarkovtracker.js";
import { jsonResponse, mutableMsClock, scriptedFetch, statusResponse } from "./helpers.js";

const PROGRESS: unknown = JSON.parse(
  readFileSync(
    resolve(fileURLToPath(import.meta.url), "../fixtures/tarkovtracker-progress.json"),
    "utf8",
  ),
);
const FIXED = "2026-01-01T00:00:00.000Z";
const TOKEN = "test-token-abc";

describe("tarkovtracker source (fixtures)", () => {
  it("advertises progress-read, kind rest, exposes quota, no write path", () => {
    const source = createTarkovTrackerSource({ token: TOKEN });
    expect(source.id).toBe("tarkovtracker");
    expect(source.kind).toBe("rest");
    expect(source.capabilities).toEqual(["progress-read"]);
    expect(typeof source.quota).toBe("function");
    // read-only: no `write` on the Source contract at all.
    expect((source as unknown as Record<string, unknown>)["write"]).toBeUndefined();
  });

  it("reads /progress: unwraps `data`, parses tolerantly, sets Authorization + UA", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse(PROGRESS, {
        etag: "prog-v1",
        headers: { "X-RateLimit-Remaining": "999" },
      }),
    ]);
    const source = createTarkovTrackerSource({ token: TOKEN, fetchImpl, clock: () => FIXED });

    const reading = await source.fetch(TARKOVTRACKER_PROGRESS_REQUEST);
    expect(reading.sourceId).toBe("tarkovtracker");
    expect(reading.capability).toBe("progress-read");
    expect(reading.fromCache).toBe(false);
    expect(reading.fetchedAt).toBe(FIXED);

    const data = reading.data as { playerLevel?: number; tasksProgress?: unknown[] };
    expect(data.playerLevel).toBe(42);
    expect(data.tasksProgress).toHaveLength(2);

    expect(calls[0]?.url).toBe("https://api.tarkovtracker.org/progress");
    const headers = calls[0]?.init?.headers ?? {};
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(headers["User-Agent"]).toBe(DEFAULT_USER_AGENT);
  });

  it("tolerates a `data` + `errors` body (parses the data half)", async () => {
    const body = {
      data: { playerLevel: 7, tasksProgress: [] },
      errors: [{ message: "partial upstream error" }],
    };
    const { fetchImpl } = scriptedFetch([jsonResponse(body)]);
    const source = createTarkovTrackerSource({ token: TOKEN, fetchImpl, clock: () => FIXED });
    const reading = await source.fetch(TARKOVTRACKER_PROGRESS_REQUEST);
    expect((reading.data as { playerLevel?: number }).playerLevel).toBe(7);
  });

  it("updates the quota ledger from response headers", async () => {
    const clock = mutableMsClock(0);
    const quota = new QuotaLedger(clock.now);
    const { fetchImpl } = scriptedFetch([
      jsonResponse(PROGRESS, { headers: { "X-RateLimit-Remaining": "12" } }),
    ]);
    const source = createTarkovTrackerSource({ token: TOKEN, fetchImpl, quota, clock: () => FIXED });

    await source.fetch(TARKOVTRACKER_PROGRESS_REQUEST);
    expect(source.quota?.().readsRemaining).toBe(12);
  });

  it("refuses a read (QuotaExhaustedError) when the budget is exhausted, no network", async () => {
    const quota = new QuotaLedger();
    quota.updateFromHeaders(new Headers({ "X-RateLimit-Remaining": "0" }));
    const { fetchImpl, calls } = scriptedFetch([jsonResponse(PROGRESS)]);
    const source = createTarkovTrackerSource({ token: TOKEN, fetchImpl, quota, clock: () => FIXED });

    await expect(source.fetch(TARKOVTRACKER_PROGRESS_REQUEST)).rejects.toBeInstanceOf(
      QuotaExhaustedError,
    );
    expect(calls.length).toBe(0); // refused before hitting the wire
  });

  it("a TTL hit serves from cache and spends no quota / no network", async () => {
    const clock = mutableMsClock(0);
    const cache = new TtlCache(clock.now);
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse(PROGRESS, { headers: { "X-RateLimit-Remaining": "500" } }),
    ]);
    const source = createTarkovTrackerSource({
      token: TOKEN,
      fetchImpl,
      cache,
      now: clock.now,
      clock: () => FIXED,
    });

    await source.fetch(TARKOVTRACKER_PROGRESS_REQUEST);
    clock.advance(1000); // within the 60s progress TTL
    const cached = await source.fetch(TARKOVTRACKER_PROGRESS_REQUEST);
    expect(cached.fromCache).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("a 304 after the TTL is served from cache and does not decrement the local budget", async () => {
    const clock = mutableMsClock(0);
    const cache = new TtlCache(clock.now);
    const quota = new QuotaLedger(clock.now);
    const { fetchImpl, calls } = scriptedFetch([
      jsonResponse(PROGRESS, { etag: "prog-v1", headers: { "X-RateLimit-Remaining": "500" } }),
      // A 304 revalidate: server reports the SAME remaining (no spend).
      statusResponse(304, { etag: "prog-v1", headers: { "X-RateLimit-Remaining": "500" } }),
    ]);
    const source = createTarkovTrackerSource({
      token: TOKEN,
      fetchImpl,
      cache,
      quota,
      now: clock.now,
      clock: () => FIXED,
    });

    await source.fetch(TARKOVTRACKER_PROGRESS_REQUEST);
    clock.advance(PROGRESS_TTL_MS + 1); // expire the cache → conditional GET
    const revalidated = await source.fetch(TARKOVTRACKER_PROGRESS_REQUEST);

    expect(revalidated.fromCache).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[1]?.init?.headers?.["If-None-Match"]).toBe("prog-v1");
    expect(source.quota?.().readsRemaining).toBe(500); // unchanged
  });

  it("health: missing without a token, connected with token+budget, stale when exhausted", async () => {
    expect(await createTarkovTrackerSource({ token: "" }).health()).toBe("missing");

    const source = createTarkovTrackerSource({ token: TOKEN });
    expect(await source.health()).toBe("connected");

    const quota = new QuotaLedger();
    quota.updateFromHeaders(new Headers({ "X-RateLimit-Remaining": "0" }));
    const exhausted = createTarkovTrackerSource({ token: TOKEN, quota });
    expect(await exhausted.health()).toBe("stale");
  });

  it("rejects a capability it does not advertise", async () => {
    const source = createTarkovTrackerSource({ token: TOKEN });
    await expect(
      source.fetch({ capability: "game-data", path: "/regular/tasks" }),
    ).rejects.toThrow(/cannot satisfy capability/);
  });

  it.skipIf(!process.env["TAC_LIVE"])("live smoke: /progress with a real token", async () => {
    const token = process.env["TAC_TT_TOKEN"];
    if (token === undefined) return;
    const source = createTarkovTrackerSource({ token });
    const reading = await source.fetch(TARKOVTRACKER_PROGRESS_REQUEST);
    expect(reading.sourceId).toBe("tarkovtracker");
  });
});
