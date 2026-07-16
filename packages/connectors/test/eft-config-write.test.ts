import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GameRunningError,
  type ApplyResult,
  type BackupManifest,
  type RecommendationProfile,
  type SettingDiff,
} from "@tac/environment";
import {
  createEftConfigConnector,
  WritesDisabledError,
} from "../src/connectors/eft-config.js";
import { ConnectorRegistry } from "../src/registry.js";

const FIXTURE_DIR = resolve(fileURLToPath(import.meta.url), "../fixtures/settings");

/** A minimal, valid recommendation profile used as the write patch. */
const PATCH: RecommendationProfile = {
  key: "balanced",
  name: "Balanced",
  description: "test patch",
  settings: [{ key: "Graphics.VSync", value: false, why: "test" }],
};

const DIFF: SettingDiff[] = [
  { key: "Graphics.VSync", current: true, recommended: false, why: "test" },
];

/** Fake apply that records its inputs and returns a canned backup id. */
function fakeApply(backupId: string | null = "settings-20260101-000000-abcd") {
  return vi.fn(
    async (_profile: RecommendationProfile, _opts?: unknown): Promise<ApplyResult> => ({
      backupId,
      applied: backupId === null ? [] : DIFF,
    }),
  );
}

/** Fake restore that records its inputs and returns a canned manifest. */
function fakeRestore(id = "settings-20260101-000000-abcd") {
  const manifest: BackupManifest = {
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    settingsDir: FIXTURE_DIR,
    profileKey: "balanced",
    files: ["Graphics.ini"],
  };
  return vi.fn(async (_backupId: string, _opts?: unknown): Promise<BackupManifest> => manifest);
}

describe("eft-config write — opt-in gate", () => {
  it("refuses write with WritesDisabledError when enableWrites is false (default)", async () => {
    const connector = createEftConfigConnector({ settingsDir: FIXTURE_DIR });
    expect(connector.writesEnabled).toBe(false);
    await expect(connector.write("game-config", PATCH)).rejects.toThrow(WritesDisabledError);
  });

  it("refuses revert with WritesDisabledError when writes are disabled", async () => {
    const connector = createEftConfigConnector({ settingsDir: FIXTURE_DIR });
    await expect(connector.revert("some-backup")).rejects.toThrow(WritesDisabledError);
  });

  it("still reads normally regardless of the write gate", async () => {
    const connector = createEftConfigConnector({ settingsDir: FIXTURE_DIR });
    const reading = await connector.read("game-config");
    expect(reading.connectorId).toBe("eft-config");
  });
});

describe("eft-config write — enabled with injected fakes", () => {
  it("calls the injected applyProfile and returns a reversible WriteResult", async () => {
    const apply = fakeApply();
    const restore = fakeRestore();
    const isRunning = vi.fn(async () => false);
    const connector = createEftConfigConnector({
      settingsDir: FIXTURE_DIR,
      enableWrites: true,
      apply,
      restore,
      isRunning,
    });

    expect(connector.writesEnabled).toBe(true);

    const result = await connector.write("game-config", PATCH);

    // applyProfile was called once with the patch and the fixture settings dir.
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[0]).toBe(PATCH);
    expect((apply.mock.calls[0]?.[1] as { settingsDir?: string }).settingsDir).toBe(FIXTURE_DIR);

    // Result carries the backup reference + the applied diff, and is reversible.
    expect(result.applied).toBe(true);
    expect(result.backupId).toBe("settings-20260101-000000-abcd");
    expect(result.diff).toEqual(DIFF);
    expect(typeof result.revert).toBe("function");

    // result.revert() delegates to the injected restoreBackup.
    await result.revert?.();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore.mock.calls[0]?.[0]).toBe("settings-20260101-000000-abcd");
  });

  it("revert(backupId) and revert(writeResult) both wrap the injected restoreBackup", async () => {
    const restore = fakeRestore("settings-xyz");
    const connector = createEftConfigConnector({
      settingsDir: FIXTURE_DIR,
      enableWrites: true,
      apply: fakeApply("settings-xyz"),
      restore,
      isRunning: async () => false,
    });

    const byId = await connector.revert("settings-xyz");
    expect(byId.id).toBe("settings-xyz");

    const writeResult = await connector.write("game-config", PATCH);
    const byResult = await connector.revert(writeResult);
    expect(byResult.id).toBe("settings-xyz");
    expect(restore).toHaveBeenCalledTimes(2);
  });

  it("no-op apply (profile already matched) yields applied:false, no backup, no revert", async () => {
    const connector = createEftConfigConnector({
      settingsDir: FIXTURE_DIR,
      enableWrites: true,
      apply: fakeApply(null),
      restore: fakeRestore(),
      isRunning: async () => false,
    });
    const result = await connector.write("game-config", PATCH);
    expect(result.applied).toBe(false);
    expect(result.backupId).toBeUndefined();
    expect(result.revert).toBeUndefined();
    expect(result.diff).toEqual([]);
  });

  it("surfaces GameRunningError and never attempts apply when the game is running", async () => {
    const apply = fakeApply();
    const connector = createEftConfigConnector({
      settingsDir: FIXTURE_DIR,
      enableWrites: true,
      apply,
      restore: fakeRestore(),
      isRunning: async () => true,
    });
    await expect(connector.write("game-config", PATCH)).rejects.toThrow(GameRunningError);
    expect(apply).not.toHaveBeenCalled();
  });

  it("rejects a capability the connector does not advertise", async () => {
    const connector = createEftConfigConnector({
      settingsDir: FIXTURE_DIR,
      enableWrites: true,
      apply: fakeApply(),
      restore: fakeRestore(),
      isRunning: async () => false,
    });
    await expect(connector.write("audio-mix", PATCH)).rejects.toThrow(/cannot write capability/);
  });
});

describe("ConnectorRegistry.write — dispatch guard", () => {
  it("dispatches to a resolved, write-enabled connector", async () => {
    const apply = fakeApply();
    const reg = new ConnectorRegistry();
    reg.register(
      createEftConfigConnector({
        settingsDir: FIXTURE_DIR,
        enableWrites: true,
        apply,
        restore: fakeRestore(),
        isRunning: async () => false,
      }),
    );
    const result = await reg.write("game-config", PATCH);
    expect(result.applied).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("throws when the resolved connector has writes disabled", async () => {
    const reg = new ConnectorRegistry();
    reg.register(createEftConfigConnector({ settingsDir: FIXTURE_DIR })); // enableWrites: false
    await expect(reg.write("game-config", PATCH)).rejects.toThrow(
      /has writes disabled|advertises no write path/,
    );
  });

  it("throws when the resolved connector has no write path at all", async () => {
    const reg = new ConnectorRegistry();
    reg.register({
      id: "readonly-stub",
      vendor: "test",
      capabilities: ["audio-mix"],
      riskTier: "T1",
      async detect() {
        return { installed: true };
      },
      async read(cap) {
        return {
          connectorId: "readonly-stub",
          capability: cap,
          capturedAt: "2026-01-01T00:00:00.000Z",
          data: {},
        };
      },
      async health() {
        return "connected";
      },
    });
    await expect(reg.write("audio-mix", PATCH)).rejects.toThrow(/advertises no write path/);
  });

  it("throws when no connector satisfies the capability", async () => {
    const reg = new ConnectorRegistry();
    await expect(reg.write("game-config", PATCH)).rejects.toThrow(/No connector satisfies/);
  });
});
