import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configPath,
  defaultConfig,
  loadConfig,
  resolveAgentUrl,
  saveConfig,
  servicePort,
  DEFAULT_AGENT_PORT,
  DEFAULT_PORT,
} from "../src/config.js";
import { tempDir } from "./helpers.js";

describe("config (M8.3)", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    delete process.env["TAC_PORT"];
    delete process.env["TAC_AGENT_URL"];
    delete process.env["TAC_AGENT_PORT"];
    if (savedEnv["TAC_PORT"]) process.env["TAC_PORT"] = savedEnv["TAC_PORT"];
    if (savedEnv["TAC_AGENT_URL"]) process.env["TAC_AGENT_URL"] = savedEnv["TAC_AGENT_URL"];
    if (savedEnv["TAC_AGENT_PORT"]) process.env["TAC_AGENT_PORT"] = savedEnv["TAC_AGENT_PORT"];
  });

  it("creates config.json with main-regular defaults on first boot", () => {
    const dir = tempDir();
    expect(existsSync(configPath(dir))).toBe(false);
    const config = loadConfig(dir);
    expect(config).toEqual(defaultConfig());
    expect(config.activeProfile).toBe("main-regular");
    expect(config.profiles[0]!.gameMode).toBe("regular");
    expect(existsSync(configPath(dir))).toBe(true);
  });

  it("round-trips through saveConfig/loadConfig", () => {
    const dir = tempDir();
    const config = defaultConfig();
    config.profiles.push({ key: "main-pve", label: "PvE", gameMode: "pve" });
    config.tarkovTrackerToken = "tok-123";
    config.agentUrl = "http://127.0.0.1:4000";
    saveConfig(config, dir);
    expect(loadConfig(dir)).toEqual(config);
  });

  it("falls back to the first profile when activeProfile names no entry, and persists the fix", () => {
    const dir = tempDir();
    const broken = { ...defaultConfig(), activeProfile: "ghost-profile" };
    writeFileSync(join(dir, "config.json"), JSON.stringify(broken));
    const config = loadConfig(dir);
    expect(config.activeProfile).toBe("main-regular");
    expect(JSON.parse(readFileSync(configPath(dir), "utf8")).activeProfile).toBe("main-regular");
  });

  it("rejects a malformed config file loudly", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ profiles: [] }));
    expect(() => loadConfig(dir)).toThrow();
  });

  it("resolveAgentUrl: TAC_AGENT_URL > config.agentUrl > localhost:TAC_AGENT_PORT > default", () => {
    expect(resolveAgentUrl()).toBe(`http://localhost:${DEFAULT_AGENT_PORT}`);
    process.env["TAC_AGENT_PORT"] = "4100";
    expect(resolveAgentUrl()).toBe("http://localhost:4100");
    const config = { ...defaultConfig(), agentUrl: "http://10.0.0.5:9999/" };
    expect(resolveAgentUrl(config)).toBe("http://10.0.0.5:9999");
    process.env["TAC_AGENT_URL"] = "http://127.0.0.1:5555/";
    expect(resolveAgentUrl(config)).toBe("http://127.0.0.1:5555");
  });

  it("servicePort honors TAC_PORT and rejects garbage", () => {
    expect(servicePort()).toBe(DEFAULT_PORT);
    process.env["TAC_PORT"] = "4141";
    expect(servicePort()).toBe(4141);
    process.env["TAC_PORT"] = "not-a-port";
    expect(servicePort()).toBe(DEFAULT_PORT);
  });
});
