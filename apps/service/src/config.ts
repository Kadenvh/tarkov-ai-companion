import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { GameMode } from "@tac/shared";
import { dataLocalDir } from "@tac/data-core";

/**
 * Service configuration (M8.3) — `data/local/config.json`, created with
 * defaults on first boot. Every path/port is overridable via env:
 *   TAC_DATA_DIR    data/local root (config.json, profiles/, backups/)
 *   TAC_PORT        service port (default 3141, CONTRACTS §2)
 *   TAC_AGENT_URL   full agent base URL (wins over TAC_AGENT_PORT)
 *   TAC_AGENT_PORT  agent port (default 3142)
 *   TAC_NO_WATCH=1  disable log/screenshot watchers
 *   TAC_EFT_PATH    game install override (consumed by @tac/data-core /
 *                   @tac/state-engine discovery; config.eftPath seeds it)
 */

export const ProfileEntry = z.object({
  /** `<accountLabel>-<gameMode>` (CONTRACTS §2), e.g. `main-regular` */
  key: z.string().regex(/^[\w.-]+$/),
  label: z.string(),
  gameMode: GameMode,
});
export type ProfileEntry = z.infer<typeof ProfileEntry>;

export const ServiceConfig = z.object({
  profiles: z.array(ProfileEntry).min(1),
  activeProfile: z.string(),
  tarkovTrackerToken: z.string().optional(),
  eftPath: z.string().optional(),
  agentUrl: z.string().optional(),
});
export type ServiceConfig = z.infer<typeof ServiceConfig>;

export const DEFAULT_PORT = 3141;
export const DEFAULT_AGENT_PORT = 3142;

export function defaultConfig(): ServiceConfig {
  return {
    profiles: [{ key: "main-regular", label: "Main (PvP)", gameMode: "regular" }],
    activeProfile: "main-regular",
  };
}

/** data/local root — TAC_DATA_DIR override for tests and relocated installs. */
export function defaultDataDir(): string {
  return dataLocalDir();
}

export function configPath(dataDir: string = defaultDataDir()): string {
  return join(dataDir, "config.json");
}

/**
 * Load `config.json` under `dataDir`, creating it with defaults on first boot.
 * An `activeProfile` that names no profile entry falls back to the first
 * profile (and is persisted back) rather than crashing the boot.
 */
export function loadConfig(dataDir: string = defaultDataDir()): ServiceConfig {
  const file = configPath(dataDir);
  if (!existsSync(file)) {
    const config = defaultConfig();
    saveConfig(config, dataDir);
    return config;
  }
  const config = ServiceConfig.parse(JSON.parse(readFileSync(file, "utf8")));
  if (!config.profiles.some((p) => p.key === config.activeProfile)) {
    config.activeProfile = config.profiles[0]!.key;
    saveConfig(config, dataDir);
  }
  return config;
}

export function saveConfig(config: ServiceConfig, dataDir: string = defaultDataDir()): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(configPath(dataDir), JSON.stringify(ServiceConfig.parse(config), null, 2) + "\n");
}

export function servicePort(): number {
  const raw = Number(process.env["TAC_PORT"]);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_PORT;
}

/** Agent base URL: TAC_AGENT_URL > config.agentUrl > localhost:TAC_AGENT_PORT. */
export function resolveAgentUrl(config?: ServiceConfig): string {
  const env = process.env["TAC_AGENT_URL"];
  if (env) return env.replace(/\/+$/, "");
  if (config?.agentUrl) return config.agentUrl.replace(/\/+$/, "");
  const port = Number(process.env["TAC_AGENT_PORT"]);
  return `http://localhost:${Number.isInteger(port) && port > 0 ? port : DEFAULT_AGENT_PORT}`;
}

export function watchDisabled(): boolean {
  return process.env["TAC_NO_WATCH"] === "1";
}
