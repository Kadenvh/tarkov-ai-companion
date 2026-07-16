import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSteelSeriesSonarConnector,
  SonarConfig,
} from "../src/connectors/steelseries-sonar.js";

const FIXTURE = resolve(fileURLToPath(import.meta.url), "../fixtures/sonar-config.json");
const MISSING = resolve(fileURLToPath(import.meta.url), "../fixtures/nope-sonar.json");
const FIXED = "2026-01-01T00:00:00.000Z";

describe("steelseries-sonar connector (fixture config export)", () => {
  const connector = createSteelSeriesSonarConnector({ configPath: FIXTURE, clock: () => FIXED });

  it("advertises audio-mix at riskTier T1, read-only", () => {
    expect(connector.id).toBe("steelseries-sonar");
    expect(connector.capabilities).toEqual(["audio-mix"]);
    expect(connector.riskTier).toBe("T1");
    expect(connector.write).toBeUndefined();
  });

  it("parses routing + per-band EQ + ChatMix into a provenance-tagged reading", async () => {
    const reading = await connector.read("audio-mix");
    expect(reading.connectorId).toBe("steelseries-sonar");
    expect(reading.capability).toBe("audio-mix");
    expect(reading.capturedAt).toBe(FIXED);
    expect(reading.settingsHash).toMatch(/^[0-9a-f]{16}$/);

    const cfg = reading.data as SonarConfig;
    expect(cfg.chatMix?.enabled).toBe(true);
    expect(cfg.chatMix?.balance).toBe(-0.2);

    const game = cfg.channels?.find((c) => c.name === "Game");
    expect(game?.volume).toBe(0.85);
    expect(game?.devices).toEqual(["Speakers (Sonar Gaming)"]);
    expect(game?.eq?.[1]).toMatchObject({ frequency: 2200, gain: 4.5, type: "peak" });

    expect(cfg.routing?.["chat"]).toBe("Discord");
  });

  it("tolerates extra + missing keys (partial/passthrough)", () => {
    // Extra top-level and nested keys survive.
    const full = SonarConfig.parse({
      version: 2,
      newTopLevel: "x",
      chatMix: { balance: 0.5, futureField: true },
    });
    expect(full["newTopLevel"]).toBe("x");
    expect(full.chatMix?.["futureField"]).toBe(true);

    // A near-empty config still parses (all fields optional).
    const sparse = SonarConfig.parse({});
    expect(sparse.channels).toBeUndefined();
    expect(sparse.chatMix).toBeUndefined();

    // A channel with only a name (no volume/eq) is fine.
    const oneChannel = SonarConfig.parse({ channels: [{ name: "Media" }] });
    expect(oneChannel.channels?.[0]?.name).toBe("Media");
  });

  it("detect/health report connected with a real path", async () => {
    expect(await connector.detect()).toEqual({ installed: true, configPath: FIXTURE });
    expect(await connector.health()).toBe("connected");
  });

  it("detect/health report missing when the path is absent", async () => {
    const absent = createSteelSeriesSonarConnector({ configPath: MISSING });
    expect(await absent.detect()).toEqual({ installed: false });
    expect(await absent.health()).toBe("missing");
  });
});
