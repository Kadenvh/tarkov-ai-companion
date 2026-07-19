import { describe, expect, it } from "vitest";
import { openProfile } from "../src/store.js";

/**
 * M10 persistence round-trips (CONTRACTS §4): the `connector_reading` provenance
 * store and the `source_quota` shared-budget ledger. In-memory DBs, mirroring
 * the existing store tests.
 */

const mem = (key = "persist-regular") => openProfile(key, { memory: true });

describe("connector_reading persistence (M10)", () => {
  it("inserts and lists readings with JSON round-trip + filters", () => {
    const store = mem();
    store.insertConnectorReading({
      connectorId: "eft-config",
      capability: "game-config",
      capturedAt: "2026-07-16T10:00:00.000Z",
      gameVersion: "1.0.6.5.46189",
      settingsHash: "abc123",
      data: { VSync: true, ShadowsQuality: 3 },
    });
    store.insertConnectorReading({
      connectorId: "wootility",
      capability: "keyboard-actuation",
      capturedAt: "2026-07-16T11:00:00.000Z",
      data: { actuationPoint: 1.2 },
      source: "connector",
    });
    store.insertConnectorReading({
      connectorId: "manual-capture",
      capability: "game-config",
      capturedAt: "2026-07-16T12:00:00.000Z",
      data: { note: "manual" },
      source: "manual",
    });

    const all = store.listConnectorReadings();
    expect(all).toHaveLength(3);
    // most-recent first
    expect(all[0]!.connectorId).toBe("manual-capture");
    expect(all[0]!.source).toBe("manual");
    // JSON round-trips; unset optional columns come back null
    const eft = all.find((r) => r.connectorId === "eft-config")!;
    expect(eft.data).toEqual({ VSync: true, ShadowsQuality: 3 });
    expect(eft.gameVersion).toBe("1.0.6.5.46189");
    expect(eft.settingsHash).toBe("abc123");
    const woot = all.find((r) => r.connectorId === "wootility")!;
    expect(woot.gameVersion).toBeNull();
    expect(woot.settingsHash).toBeNull();
    expect(woot.raidId).toBeNull();
    expect(woot.source).toBe("connector");

    // capability filter
    const configOnly = store.listConnectorReadings({ capability: "game-config" });
    expect(configOnly).toHaveLength(2);
    expect(configOnly.every((r) => r.capability === "game-config")).toBe(true);

    // sinceIso filter (inclusive lower bound)
    const recent = store.listConnectorReadings({ sinceIso: "2026-07-16T11:00:00.000Z" });
    expect(recent.map((r) => r.connectorId)).toEqual(["manual-capture", "wootility"]);

    // limit
    expect(store.listConnectorReadings({ limit: 1 })).toHaveLength(1);
  });
});

describe("source_quota persistence (M10)", () => {
  it("upserts, reads back, and updates in place with merge semantics", () => {
    const store = mem();
    expect(store.getSourceQuota("tarkovtracker")).toBeNull();

    store.upsertSourceQuota("tarkovtracker", { readsRemaining: 998, resetsAt: "2026-07-17T00:00:00.000Z" });
    const first = store.getSourceQuota("tarkovtracker")!;
    expect(first.readsRemaining).toBe(998);
    expect(first.writesRemaining).toBeNull();
    expect(first.resetsAt).toBe("2026-07-17T00:00:00.000Z");
    expect(typeof first.updatedAt).toBe("string");

    // upsert twice updates the same row in place (PK = source_id)
    store.upsertSourceQuota("tarkovtracker", { readsRemaining: 500 });
    const rows = store.getAllSourceQuota();
    expect(rows).toHaveLength(1);
    const second = store.getSourceQuota("tarkovtracker")!;
    expect(second.readsRemaining).toBe(500);
    // merge: an absent field preserves the stored value
    expect(second.resetsAt).toBe("2026-07-17T00:00:00.000Z");

    // a second source is tracked independently
    store.upsertSourceQuota("tarkov-dev-json", { readsRemaining: 42 });
    expect(store.getAllSourceQuota()).toHaveLength(2);
    expect(store.getSourceQuota("tarkov-dev-json")!.readsRemaining).toBe(42);
  });
});
