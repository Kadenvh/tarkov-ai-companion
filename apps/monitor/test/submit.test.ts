import { describe, it, expect } from "vitest";
import { TarkovDevSubmitter } from "../src/submit.js";

function stubFetch() {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl = (async (url: string | URL, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe("TarkovDevSubmitter", () => {
  it("posts queue times to the manager queue endpoint", () => {
    const { calls, impl } = stubFetch();
    const s = new TarkovDevSubmitter({ baseUrl: "https://manager.example/api", fetchImpl: impl });
    s.queueTime({ mapDevId: "customs", queueSec: 42, type: "pmc", gameMode: "regular" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://manager.example/api/queue");
    expect(calls[0]!.body).toMatchObject({ map: "customs", time: 42, type: "pmc", gameMode: "regular" });
  });

  it("posts goons sightings with map, gameMode, unix-ms timestamp and int account id", () => {
    const { calls, impl } = stubFetch();
    const s = new TarkovDevSubmitter({ baseUrl: "https://manager.example/api", fetchImpl: impl });
    s.goons({ mapDevId: "woods", accountId: "12345", gameMode: "regular" });
    expect(calls[0]!.url).toBe("https://manager.example/api/goons");
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ map: "woods", gameMode: "regular", accountId: 12345 });
    expect(typeof body["timestamp"]).toBe("number");
  });

  it("sends a null account id when it is not numeric", () => {
    const { calls, impl } = stubFetch();
    const s = new TarkovDevSubmitter({ baseUrl: "https://manager.example/api", fetchImpl: impl });
    s.goons({ mapDevId: "woods", accountId: null, gameMode: "pve" });
    expect((calls[0]!.body as Record<string, unknown>)["accountId"]).toBeNull();
  });

  it("swallows network failures (fire-and-forget)", async () => {
    const impl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const s = new TarkovDevSubmitter({ baseUrl: "https://manager.example/api", fetchImpl: impl });
    expect(() => s.queueTime({ mapDevId: "customs", queueSec: 10, type: "pmc", gameMode: "pve" })).not.toThrow();
    await Promise.resolve();
  });
});
