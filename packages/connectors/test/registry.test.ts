import { describe, expect, it } from "vitest";
import type { Capability } from "../src/capabilities.js";
import type { Connector, HealthStatus } from "../src/connector.js";
import { makeReading } from "../src/connector.js";
import { ConnectorRegistry, RiskTierRejectedError } from "../src/registry.js";

/** Minimal stub connector for resolver tests. */
function stub(
  id: string,
  capabilities: Capability[],
  health: HealthStatus,
  riskTier: Connector["riskTier"] = "T0",
): Connector {
  return {
    id,
    vendor: "test",
    capabilities,
    riskTier,
    async detect() {
      return { installed: true };
    },
    async read(cap) {
      return makeReading({ connectorId: id, capability: cap, data: { id } }, () => "2026-01-01T00:00:00.000Z");
    },
    async health() {
      return health;
    },
  };
}

describe("ConnectorRegistry.register — risk-tier guard", () => {
  it("accepts T0 and T1 connectors", () => {
    const reg = new ConnectorRegistry();
    expect(() => reg.register(stub("a", ["manual-capture"], "connected", "T0"))).not.toThrow();
    expect(() => reg.register(stub("b", ["game-config"], "connected", "T1"))).not.toThrow();
    expect(reg.list().map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("throws RiskTierRejectedError for T2/T3 (would-be process-contact) connectors", () => {
    const reg = new ConnectorRegistry();
    // Cast: a lying/out-of-tree connector may declare a tier outside the type.
    const t2 = stub("mem-reader", ["perf-telemetry"], "connected", "T2" as Connector["riskTier"]);
    const t3 = stub("injector", ["keyboard-actuation"], "connected", "T3" as Connector["riskTier"]);
    expect(() => reg.register(t2)).toThrow(RiskTierRejectedError);
    expect(() => reg.register(t3)).toThrow(/only T0\/T1/);
    expect(reg.list()).toEqual([]);
  });
});

describe("ConnectorRegistry.byCapability — 0 / 1 / N candidates", () => {
  it("returns [] when no connector advertises the capability", () => {
    const reg = new ConnectorRegistry();
    reg.register(stub("a", ["manual-capture"], "connected"));
    expect(reg.byCapability("audio-mix")).toEqual([]);
  });

  it("returns the single candidate", () => {
    const reg = new ConnectorRegistry();
    reg.register(stub("a", ["game-config"], "connected", "T1"));
    reg.register(stub("b", ["manual-capture"], "connected"));
    expect(reg.byCapability("game-config").map((c) => c.id)).toEqual(["a"]);
  });

  it("returns all N candidates for a contested capability", () => {
    const reg = new ConnectorRegistry();
    reg.register(stub("woot", ["keyboard-actuation"], "missing", "T1"));
    reg.register(stub("generic", ["keyboard-actuation"], "connected"));
    expect(reg.byCapability("keyboard-actuation").map((c) => c.id).sort()).toEqual([
      "generic",
      "woot",
    ]);
  });
});

describe("ConnectorRegistry.resolve", () => {
  it("returns undefined when nothing satisfies the capability", async () => {
    const reg = new ConnectorRegistry();
    reg.register(stub("a", ["manual-capture"], "connected"));
    expect(await reg.resolve("audio-mix")).toBeUndefined();
  });

  it("prefers a connected connector over an unhealthy one", async () => {
    const reg = new ConnectorRegistry();
    reg.register(stub("missing-one", ["keyboard-actuation"], "missing", "T1"));
    reg.register(stub("live-one", ["keyboard-actuation"], "connected"));
    const resolved = await reg.resolve("keyboard-actuation");
    expect(resolved?.id).toBe("live-one");
  });

  it("falls back to the first candidate when none are connected", async () => {
    const reg = new ConnectorRegistry();
    reg.register(stub("first", ["keyboard-actuation"], "missing", "T1"));
    reg.register(stub("second", ["keyboard-actuation"], "error"));
    const resolved = await reg.resolve("keyboard-actuation");
    expect(resolved?.id).toBe("first");
  });

  it("honors opts.prefer manual override even when another is connected", async () => {
    const reg = new ConnectorRegistry();
    reg.register(stub("live-one", ["keyboard-actuation"], "connected"));
    reg.register(stub("my-pick", ["keyboard-actuation"], "missing", "T1"));
    const resolved = await reg.resolve("keyboard-actuation", { prefer: "my-pick" });
    expect(resolved?.id).toBe("my-pick");
  });

  it("throws when opts.prefer does not satisfy the capability", async () => {
    const reg = new ConnectorRegistry();
    reg.register(stub("live-one", ["keyboard-actuation"], "connected"));
    await expect(reg.resolve("keyboard-actuation", { prefer: "nope" })).rejects.toThrow(
      /does not satisfy/,
    );
  });
});

describe("ConnectorRegistry.read / healthAll", () => {
  it("read resolves then reads a provenance-tagged reading", async () => {
    const reg = new ConnectorRegistry();
    reg.register(stub("a", ["game-config"], "connected", "T1"));
    const reading = await reg.read("game-config");
    expect(reading.connectorId).toBe("a");
    expect(reading.capability).toBe("game-config");
    expect(reading.capturedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("read throws a clear error when no connector satisfies the capability", async () => {
    const reg = new ConnectorRegistry();
    await expect(reg.read("audio-mix")).rejects.toThrow(/No connector satisfies capability "audio-mix"/);
  });

  it("healthAll reports every connector by id", async () => {
    const reg = new ConnectorRegistry();
    reg.register(stub("a", ["game-config"], "connected", "T1"));
    reg.register(stub("b", ["manual-capture"], "stale"));
    expect(await reg.healthAll()).toEqual({ a: "connected", b: "stale" });
  });
});
