import { afterEach, describe, expect, it } from "vitest";
import {
  DATA_LOCAL_DIR,
  SNAPSHOT_DIR,
  STORY_DIR,
  dataLocalDir,
  snapshotDir,
  storyDir,
} from "../src/paths.js";

/**
 * Data-directory resolution (env-configurable for the packaged Electron layout).
 * Each resolver honours its env var and otherwise falls back to the REPO_ROOT
 * dev constant — the fallback is what dev + the existing suites exercise.
 */

const ENV_KEYS = ["TAC_SNAPSHOT_DIR", "TAC_STORY_DIR", "TAC_DATA_DIR"] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("data-dir resolution", () => {
  it("falls back to the REPO_ROOT dev constants when env is unset", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(snapshotDir()).toBe(SNAPSHOT_DIR);
    expect(storyDir()).toBe(STORY_DIR);
    expect(dataLocalDir()).toBe(DATA_LOCAL_DIR);
  });

  it("snapshotDir honours TAC_SNAPSHOT_DIR", () => {
    process.env["TAC_SNAPSHOT_DIR"] = "C:/app/resources/data/snapshots";
    expect(snapshotDir()).toBe("C:/app/resources/data/snapshots");
    // The other resolvers are unaffected by an unrelated override.
    expect(storyDir()).toBe(STORY_DIR);
    expect(dataLocalDir()).toBe(DATA_LOCAL_DIR);
  });

  it("storyDir honours TAC_STORY_DIR", () => {
    process.env["TAC_STORY_DIR"] = "C:/app/resources/data/story";
    expect(storyDir()).toBe("C:/app/resources/data/story");
    expect(snapshotDir()).toBe(SNAPSHOT_DIR);
  });

  it("dataLocalDir honours TAC_DATA_DIR (writable userData root)", () => {
    process.env["TAC_DATA_DIR"] = "C:/Users/x/AppData/Roaming/Tarkov AI Companion/data";
    expect(dataLocalDir()).toBe("C:/Users/x/AppData/Roaming/Tarkov AI Companion/data");
    expect(snapshotDir()).toBe(SNAPSHOT_DIR);
  });

  it("re-reads env each call (resolution is not frozen at import)", () => {
    expect(snapshotDir()).toBe(SNAPSHOT_DIR);
    process.env["TAC_SNAPSHOT_DIR"] = "D:/relocated/snapshots";
    expect(snapshotDir()).toBe("D:/relocated/snapshots");
    delete process.env["TAC_SNAPSHOT_DIR"];
    expect(snapshotDir()).toBe(SNAPSHOT_DIR);
  });
});
