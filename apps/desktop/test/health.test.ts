import { describe, expect, it, vi } from "vitest";
import { HealthGateTimeoutError, waitForHealth, type HealthFetch } from "../src/lib/health.js";

/** A sleep stub that resolves immediately but advances a fake clock. */
function fakeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("waitForHealth", () => {
  it("resolves on the first attempt when the endpoint is already 200", async () => {
    const fetchImpl: HealthFetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const clock = fakeClock();
    const attempts = await waitForHealth({
      url: "http://127.0.0.1:3141/api/health",
      fetchImpl,
      ...clock,
    });
    expect(attempts).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries on non-200 responses until it sees a 200", async () => {
    const statuses = [503, 503, 200];
    let i = 0;
    const fetchImpl: HealthFetch = vi.fn(async () => {
      const status = statuses[i++] ?? 200;
      return { ok: status === 200, status };
    });
    const clock = fakeClock();
    const attempts = await waitForHealth({
      url: "http://127.0.0.1:3141/api/health",
      fetchImpl,
      ...clock,
    });
    expect(attempts).toBe(3);
  });

  it("treats a thrown fetch (connection refused) as a miss and keeps polling", async () => {
    let i = 0;
    const fetchImpl: HealthFetch = vi.fn(async () => {
      if (i++ < 2) throw new Error("ECONNREFUSED");
      return { ok: true, status: 200 };
    });
    const clock = fakeClock();
    const attempts = await waitForHealth({
      url: "http://127.0.0.1:3141/api/health",
      fetchImpl,
      ...clock,
    });
    expect(attempts).toBe(3);
  });

  it("rejects with a timeout error once the budget is spent", async () => {
    const fetchImpl: HealthFetch = vi.fn(async () => ({ ok: false, status: 500 }));
    const clock = fakeClock();
    await expect(
      waitForHealth({
        url: "http://127.0.0.1:3141/api/health",
        fetchImpl,
        timeoutMs: 1_000,
        intervalMs: 200,
        ...clock,
      }),
    ).rejects.toBeInstanceOf(HealthGateTimeoutError);
  });

  it("applies capped exponential backoff between misses", async () => {
    const fetchImpl: HealthFetch = vi.fn(async () => ({ ok: false, status: 500 }));
    const delays: number[] = [];
    let t = 0;
    await expect(
      waitForHealth({
        url: "http://127.0.0.1:3141/api/health",
        fetchImpl,
        timeoutMs: 10_000,
        intervalMs: 100,
        maxIntervalMs: 400,
        now: () => t,
        sleep: async (ms) => {
          delays.push(ms);
          t += ms;
        },
      }),
    ).rejects.toBeInstanceOf(HealthGateTimeoutError);
    // 100, 200, 400, 400, ... capped at 400.
    expect(delays.slice(0, 4)).toEqual([100, 200, 400, 400]);
  });
});
