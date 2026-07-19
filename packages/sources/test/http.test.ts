import { describe, expect, it } from "vitest";
import { DEFAULT_USER_AGENT, HttpError, httpGet, unwrapData } from "../src/http.js";
import { fakeSleep, jsonResponse, scriptedFetch, statusResponse } from "./helpers.js";

describe("httpGet — headers + conditional requests", () => {
  it("sends a real User-Agent and Accept, and If-None-Match when an ETag is cached", async () => {
    const { fetchImpl, calls } = scriptedFetch([jsonResponse({ ok: true }, { etag: "v2" })]);
    const result = await httpGet({ url: "https://x/y", fetchImpl, etag: "v1" });

    expect(result.status).toBe(200);
    expect(result.attempts).toBe(1);
    expect(result.etag).toBe("v2");
    const headers = calls[0]?.init?.headers ?? {};
    expect(headers["User-Agent"]).toBe(DEFAULT_USER_AGENT);
    expect(headers["Accept"]).toBe("application/json");
    expect(headers["If-None-Match"]).toBe("v1");
  });

  it("treats a 304 as a cache hit: no body, no throw, ETag carried through", async () => {
    const { fetchImpl } = scriptedFetch([statusResponse(304, { etag: "v1" })]);
    const result = await httpGet({ url: "https://x/y", fetchImpl, etag: "v1" });
    expect(result.notModified).toBe(true);
    expect(result.status).toBe(304);
    expect(result.body).toBeUndefined();
    expect(result.etag).toBe("v1");
  });

  it("tolerates a body carrying both `data` and `errors` (partial GraphQL)", async () => {
    const body = { data: { tasks: [{ id: "1" }] }, errors: [{ message: "partial" }] };
    const { fetchImpl } = scriptedFetch([jsonResponse(body)]);
    const result = await httpGet({ url: "https://x/gql", fetchImpl });
    expect(result.body).toEqual(body);
    expect(unwrapData(result.body)).toEqual({ tasks: [{ id: "1" }] });
  });
});

describe("httpGet — retry/backoff", () => {
  it("retries a 429 then succeeds (deterministic rng, injected sleep)", async () => {
    const { fetchImpl, calls } = scriptedFetch([statusResponse(429), jsonResponse({ ok: true })]);
    const { sleep, delays } = fakeSleep();
    const result = await httpGet({
      url: "https://x/y",
      fetchImpl,
      sleep,
      rng: () => 0.5,
      baseDelayMs: 100,
    });
    expect(result.status).toBe(200);
    expect(result.attempts).toBe(2);
    expect(calls.length).toBe(2);
    expect(delays).toHaveLength(1);
    // attempt 0: base·2^0 (=100) + jitter (0.5·100 = 50) = 150
    expect(delays[0]).toBe(150);
  });

  it("honors Retry-After over the exponential schedule", async () => {
    const { fetchImpl } = scriptedFetch([
      statusResponse(503, { headers: { "Retry-After": "2" } }),
      jsonResponse({ ok: true }),
    ]);
    const { sleep, delays } = fakeSleep();
    await httpGet({ url: "https://x/y", fetchImpl, sleep, rng: () => 0, baseDelayMs: 100 });
    expect(delays[0]).toBe(2000);
  });

  it("throws HttpError once retries are exhausted on persistent 5xx", async () => {
    const { fetchImpl, calls } = scriptedFetch([statusResponse(500)]);
    const { sleep } = fakeSleep();
    await expect(
      httpGet({ url: "https://x/y", fetchImpl, sleep, maxRetries: 2, rng: () => 0 }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(calls.length).toBe(3); // 1 initial + 2 retries
  });

  it("does not retry a non-retryable 4xx", async () => {
    const { fetchImpl, calls } = scriptedFetch([statusResponse(404)]);
    await expect(httpGet({ url: "https://x/y", fetchImpl })).rejects.toBeInstanceOf(HttpError);
    expect(calls.length).toBe(1);
  });
});

describe("unwrapData", () => {
  it("returns .data when present, else the body unchanged", () => {
    expect(unwrapData({ data: { a: 1 }, errors: [] })).toEqual({ a: 1 });
    expect(unwrapData({ a: 1 })).toEqual({ a: 1 });
    expect(unwrapData(null)).toBeNull();
    expect(unwrapData([1, 2, 3])).toEqual([1, 2, 3]);
  });
});
