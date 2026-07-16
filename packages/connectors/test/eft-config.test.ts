import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSettingsDir, type EftSettings } from "@tac/environment";
import { createEftConfigConnector } from "../src/connectors/eft-config.js";

const FIXTURE_DIR = resolve(fileURLToPath(import.meta.url), "../fixtures/settings");
const FIXED = "2026-01-01T00:00:00.000Z";

describe("eft-config connector (fixture settings dir)", () => {
  const connector = createEftConfigConnector({ settingsDir: FIXTURE_DIR, clock: () => FIXED });

  it("advertises game-config at riskTier T1, read-only", () => {
    expect(connector.id).toBe("eft-config");
    expect(connector.capabilities).toEqual(["game-config"]);
    expect(connector.riskTier).toBe("T1");
    expect(connector.write).toBeUndefined();
  });

  it("detect finds the fixture config dir", async () => {
    const result = await connector.detect();
    expect(result.installed).toBe(true);
    expect(result.configPath).toBe(FIXTURE_DIR);
  });

  it("read returns a well-formed provenance-tagged reading with a deterministic clock", async () => {
    const reading = await connector.read("game-config");
    expect(reading.connectorId).toBe("eft-config");
    expect(reading.capability).toBe("game-config");
    expect(reading.capturedAt).toBe(FIXED);
    expect(typeof reading.settingsHash).toBe("string");
    expect(reading.settingsHash).toMatch(/^[0-9a-f]{16}$/);

    const data = reading.data as EftSettings;
    expect(data.dir).toBe(FIXTURE_DIR);
    expect(data.present.sort()).toEqual(["Game", "Graphics", "PostFx"]);
    expect(data.graphics.VSync).toBe(false);
    expect(data.graphics.GameFramerate).toBe(120);
    expect(data.game.FieldOfView).toBe(67);
    expect(data.postfx.EnablePostFx).toBe(true);
  });

  it("settingsHash is stable across reads of the same dir", async () => {
    const a = await connector.read("game-config");
    const b = await connector.read("game-config");
    expect(a.settingsHash).toBe(b.settingsHash);
  });

  it("read rejects a capability the connector does not advertise", async () => {
    await expect(connector.read("audio-mix")).rejects.toThrow(/cannot read capability/);
  });

  it("health is connected when settings files are present", async () => {
    expect(await connector.health()).toBe("connected");
  });

  it("detect/health report missing for a non-existent dir", async () => {
    const absent = createEftConfigConnector({ settingsDir: resolve(FIXTURE_DIR, "../nope") });
    expect((await absent.detect()).installed).toBe(false);
    expect(await absent.health()).toBe("missing");
  });
});

describe("eft-config connector (real machine, skipped when EFT absent)", () => {
  const realDir = defaultSettingsDir();
  it.skipIf(!existsSync(realDir))("reads the live settings dir without throwing", async () => {
    const connector = createEftConfigConnector();
    const reading = await connector.read("game-config");
    expect((reading.data as EftSettings).present.length).toBeGreaterThan(0);
    expect(reading.settingsHash).toMatch(/^[0-9a-f]{16}$/);
  });
});
