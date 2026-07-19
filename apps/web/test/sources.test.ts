import { describe, expect, it } from "vitest";
import { readConnectors, readSourceStatusRow, readSourceStatuses } from "../src/lib/normalize";

describe("readSourceStatuses (§5.7)", () => {
  it("reads a bare array of status rows with quota", () => {
    const rows = readSourceStatuses([
      {
        id: "tarkovtracker",
        up: true,
        apiVersion: "1.2.3",
        cacheAgeSec: 42,
        quota: { readsRemaining: 998, writesRemaining: 100, resetsAt: "2026-07-16T00:00:00.000Z" },
        lastFetch: "2026-07-16T12:00:00.000Z",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.up).toBe(true);
    expect(rows[0]!.quota?.readsRemaining).toBe(998);
    expect(rows[0]!.apiVersion).toBe("1.2.3");
  });

  it("accepts the { sources: [...] } envelope and drops id-less rows", () => {
    const rows = readSourceStatuses({ sources: [{ id: "x", up: false }, { up: true }] });
    expect(rows.map((r) => r.id)).toEqual(["x"]);
    expect(rows[0]!.up).toBe(false);
  });

  it("degrades a partial / non-object payload to an empty array (no white-screen)", () => {
    expect(readSourceStatuses(null)).toEqual([]);
    expect(readSourceStatuses(undefined)).toEqual([]);
    expect(readSourceStatuses(42)).toEqual([]);
    expect(readSourceStatuses({})).toEqual([]);
  });

  it("readSourceStatusRow normalizes a single WS frame payload; null when unusable", () => {
    const row = readSourceStatusRow({ id: "tarkov-dev-json", up: true, lastError: "boom" });
    expect(row?.id).toBe("tarkov-dev-json");
    expect(row?.lastError).toBe("boom");
    expect(readSourceStatusRow({ up: true })).toBeNull();
    expect(readSourceStatusRow("nope")).toBeNull();
  });

  it("omits a quota object that carries no numeric budget", () => {
    const row = readSourceStatusRow({ id: "s", up: true, quota: {} });
    expect(row?.quota).toBeUndefined();
  });
});

describe("readConnectors (§5.6)", () => {
  it("reads rows and clamps unknown health to 'error'", () => {
    const list = readConnectors([
      { id: "eft-config", vendor: "BSG", capabilities: ["game-config"], riskTier: "T1", health: "connected" },
      { id: "manual-capture", vendor: "TAC", capabilities: ["manual-capture"], riskTier: "T0", health: "weird" },
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]!.health).toBe("connected");
    expect(list[1]!.health).toBe("error");
    expect(list[0]!.capabilities).toEqual(["game-config"]);
  });

  it("accepts the { connectors: [...] } envelope and degrades junk to []", () => {
    expect(readConnectors({ connectors: [{ id: "a", capabilities: [], riskTier: "T0", health: "stale", vendor: "" }] })).toHaveLength(1);
    expect(readConnectors(null)).toEqual([]);
    expect(readConnectors({ nope: 1 })).toEqual([]);
  });
});
