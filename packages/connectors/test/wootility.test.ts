import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWootilityConnector, WootilityProfile } from "../src/connectors/wootility.js";

const FIXTURE = resolve(fileURLToPath(import.meta.url), "../fixtures/wootility-profile.json");
const FIXED = "2026-01-01T00:00:00.000Z";

describe("wootility connector (fixture profile export)", () => {
  const connector = createWootilityConnector({ profilePath: FIXTURE, clock: () => FIXED });

  it("advertises keyboard-actuation at riskTier T1, read-only", () => {
    expect(connector.id).toBe("wootility");
    expect(connector.capabilities).toEqual(["keyboard-actuation"]);
    expect(connector.riskTier).toBe("T1");
    expect(connector.write).toBeUndefined();
  });

  it("parses actuation + rapid-trigger fields into a provenance-tagged reading", async () => {
    const reading = await connector.read("keyboard-actuation");
    expect(reading.connectorId).toBe("wootility");
    expect(reading.capability).toBe("keyboard-actuation");
    expect(reading.capturedAt).toBe(FIXED);
    expect(reading.settingsHash).toMatch(/^[0-9a-f]{16}$/);

    const profile = reading.data as WootilityProfile;
    expect(profile.name).toBe("Tarkov");
    expect(profile.globalActuationPoint).toBe(1.5);
    expect(profile.rapidTrigger).toBe(true);
    expect(profile.rapidTriggerSensitivity).toBe(0.4);
    expect(profile.keys?.[0]).toMatchObject({
      key: "W",
      actuationPoint: 1.2,
      rapidTrigger: true,
    });
  });

  it("tolerates extra keys (passthrough) and missing typed keys", () => {
    // Extra top-level keys survive; a sparse profile still parses.
    const full = WootilityProfile.parse({
      globalActuationPoint: 1.0,
      device: "Wooting 80HE",
      somethingNew: 42,
    });
    expect(full["device"]).toBe("Wooting 80HE");
    expect(full["somethingNew"]).toBe(42);

    const sparse = WootilityProfile.parse({});
    expect(sparse.keys).toBeUndefined();
    expect(sparse.globalActuationPoint).toBeUndefined();
  });

  it("health is connected with a real profile path, missing without a config dir", async () => {
    expect(await connector.health()).toBe("connected");

    const noProfile = createWootilityConnector({ configDir: resolve(FIXTURE, "../nope-dir") });
    expect(await noProfile.health()).toBe("missing");
    const detect = await noProfile.detect();
    expect(detect.installed).toBe(false);
  });

  it("read throws a clear error when no profile path is configured", async () => {
    const bare = createWootilityConnector({ configDir: resolve(FIXTURE, "../nope-dir") });
    await expect(bare.read("keyboard-actuation")).rejects.toThrow(/no profile path configured/);
  });

  it("read rejects a capability the connector does not advertise", async () => {
    await expect(connector.read("game-config")).rejects.toThrow(/cannot read capability/);
  });
});
