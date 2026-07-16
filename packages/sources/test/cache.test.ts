import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/cache.js";
import { mutableMsClock } from "./helpers.js";

describe("TtlCache", () => {
  it("is fresh within its TTL and stale after it (injected clock)", () => {
    const clock = mutableMsClock(1000);
    const cache = new TtlCache(clock.now);

    cache.set("k", { v: 1 }, 5000);
    expect(cache.isFresh("k")).toBe(true);

    clock.set(1000 + 4999);
    expect(cache.isFresh("k")).toBe(true);

    clock.set(1000 + 5000); // now === expiresAt → no longer fresh
    expect(cache.isFresh("k")).toBe(false);
  });

  it("stores value + etag and reports age in seconds", () => {
    const clock = mutableMsClock(0);
    const cache = new TtlCache(clock.now);

    cache.set("k", { v: 42 }, 10_000, "etag-1");
    const entry = cache.get<{ v: number }>("k");
    expect(entry?.value).toEqual({ v: 42 });
    expect(entry?.etag).toBe("etag-1");

    clock.advance(3000);
    expect(cache.ageSec("k")).toBe(3);
  });

  it("returns undefined for absent keys and supports delete/clear", () => {
    const cache = new TtlCache();
    expect(cache.get("nope")).toBeUndefined();
    expect(cache.isFresh("nope")).toBe(false);
    expect(cache.ageSec("nope")).toBeUndefined();

    cache.set("a", 1, 1000);
    cache.set("b", 2, 1000);
    expect(cache.size).toBe(2);
    cache.delete("a");
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
