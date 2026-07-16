import { describe, expect, it } from "vitest";
import type { SourceCapability } from "../src/capabilities.js";
import type {
  HealthStatus,
  QuotaState,
  Source,
  SourceReading,
  SourceStats,
} from "../src/source.js";
import { makeReading } from "../src/source.js";
import { DuplicateSourceError, SourceRegistry } from "../src/registry.js";

/** Minimal stub source for registry tests. */
function stub(
  id: string,
  capabilities: SourceCapability[],
  health: HealthStatus | (() => Promise<HealthStatus>),
  extra: { quota?: QuotaState; stats?: SourceStats } = {},
): Source {
  return {
    id,
    kind: "rest",
    baseUrl: `https://${id}`,
    capabilities,
    async health() {
      return typeof health === "function" ? health() : health;
    },
    async fetch<T = unknown>(): Promise<SourceReading<T>> {
      return makeReading(
        { sourceId: id, capability: capabilities[0]!, data: { id } as T, fromCache: false },
        () => "2026-01-01T00:00:00.000Z",
      );
    },
    ...(extra.quota !== undefined ? { quota: () => extra.quota! } : {}),
    ...(extra.stats !== undefined ? { stats: () => extra.stats! } : {}),
  };
}

describe("SourceRegistry.register", () => {
  it("registers sources in order and rejects duplicate ids", () => {
    const reg = new SourceRegistry();
    reg.register(stub("a", ["game-data"], "connected"));
    reg.register(stub("b", ["prices"], "connected"));
    expect(reg.list().map((s) => s.id)).toEqual(["a", "b"]);
    expect(() => reg.register(stub("a", ["prices"], "connected"))).toThrow(DuplicateSourceError);
  });

  it("get returns a source by id or undefined", () => {
    const reg = new SourceRegistry();
    reg.register(stub("a", ["game-data"], "connected"));
    expect(reg.get("a")?.id).toBe("a");
    expect(reg.get("missing")).toBeUndefined();
  });
});

describe("SourceRegistry.byCapability — 0 / 1 / N", () => {
  it("returns [] when nothing advertises the capability", () => {
    const reg = new SourceRegistry();
    reg.register(stub("a", ["game-data"], "connected"));
    expect(reg.byCapability("story")).toEqual([]);
  });

  it("returns the single candidate", () => {
    const reg = new SourceRegistry();
    reg.register(stub("a", ["progress-read"], "connected"));
    reg.register(stub("b", ["game-data"], "connected"));
    expect(reg.byCapability("progress-read").map((s) => s.id)).toEqual(["a"]);
  });

  it("returns all N candidates for a contested capability", () => {
    const reg = new SourceRegistry();
    reg.register(stub("primary", ["game-data", "prices"], "connected"));
    reg.register(stub("mirror", ["game-data"], "stale"));
    expect(reg.byCapability("game-data").map((s) => s.id).sort()).toEqual(["mirror", "primary"]);
  });
});

describe("SourceRegistry.status — M10.3 shape", () => {
  it("collapses health to up, and folds in stats + quota", async () => {
    const reg = new SourceRegistry();
    reg.register(
      stub("tarkov-dev-json", ["game-data", "prices"], "connected", {
        stats: { apiVersion: "1.2.3", lastFetch: "2026-01-01T00:00:00.000Z", cacheAgeSec: 12 },
      }),
    );
    reg.register(
      stub("tarkovtracker", ["progress-read"], "stale", {
        quota: { readsRemaining: 5, resetsAt: "2026-01-02T00:00:00.000Z" },
      }),
    );

    const status = await reg.status();
    expect(status).toEqual([
      {
        id: "tarkov-dev-json",
        up: true,
        apiVersion: "1.2.3",
        lastFetch: "2026-01-01T00:00:00.000Z",
        cacheAgeSec: 12,
      },
      {
        id: "tarkovtracker",
        up: true, // stale is still "reachable/up"
        quota: { readsRemaining: 5, resetsAt: "2026-01-02T00:00:00.000Z" },
      },
    ]);
  });

  it("reports up:false for missing/error and surfaces a thrown health error", async () => {
    const reg = new SourceRegistry();
    reg.register(stub("down", ["game-data"], "error"));
    reg.register(
      stub("boom", ["prices"], async () => {
        throw new Error("network unreachable");
      }),
    );

    const status = await reg.status();
    expect(status[0]).toEqual({ id: "down", up: false });
    expect(status[1]).toEqual({ id: "boom", up: false, lastError: "network unreachable" });
  });

  it("healthAll reports every source by id", async () => {
    const reg = new SourceRegistry();
    reg.register(stub("a", ["game-data"], "connected"));
    reg.register(stub("b", ["prices"], "stale"));
    expect(await reg.healthAll()).toEqual({ a: "connected", b: "stale" });
  });
});
