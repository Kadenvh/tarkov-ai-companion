import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname, networkInterfaces } from "node:os";
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
  /**
   * Minutes between scheduled TarkovTracker read syncs (SPEC-8, read-mostly
   * mirror). Default ~10 when absent; `0` disables the scheduled feed (an
   * on-demand sync via the route still works).
   */
  tarkovTrackerSyncMinutes: z.number().min(0).optional(),
  /**
   * Opt-in outbound WRITE mirror (M2.7). OFF by default: the read-mostly stance
   * treats TarkovMonitor as the owner of the write path so the shared 100/day
   * write budget isn't double-spent. Only enable if TarkovMonitor is NOT running.
   */
  tarkovTrackerWrites: z.boolean().optional(),
  eftPath: z.string().optional(),
  agentUrl: z.string().optional(),
  /**
   * Two-PC / LAN exposure (opt-in). OFF by default → the service binds loopback
   * only and rejects any non-local Host header (DNS-rebinding guard). When
   * `enabled`, it binds the LAN (0.0.0.0) and the Host allowlist is widened to
   * this machine's own LAN IPv4s + hostname + `allowHosts`, so a second PC (e.g.
   * a streaming PC) can reach the HUD. Trusted-home-LAN model: no auth, never
   * exposed beyond the LAN. `TAC_BIND_LAN=1` / `TAC_ALLOW_HOSTS=a,b` override.
   */
  lan: z
    .object({
      enabled: z.boolean().default(false),
      allowHosts: z.array(z.string()).default([]),
    })
    .optional(),
});
export type ServiceConfig = z.infer<typeof ServiceConfig>;

export interface NetworkConfig {
  /** address passed to app.listen — loopback by default, 0.0.0.0 when LAN-exposed */
  bindHost: string;
  lanEnabled: boolean;
  /** lowercased Host-header values allowed past the rebinding guard (port stripped) */
  allowedHosts: Set<string>;
}

/** Always-allowed local Host header values (empty = no Host header sent). */
export const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]", ""];

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

/** This machine's non-internal IPv4 addresses (the ones a second PC would use). */
function lanIPv4s(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

/**
 * Resolve bind host + Host-header allowlist. LAN exposure is opt-in via
 * `config.lan.enabled` or `TAC_BIND_LAN=1`; extra hosts via `config.lan.allowHosts`
 * or `TAC_ALLOW_HOSTS` (comma-separated). Loopback-only + local-only otherwise,
 * preserving the original DNS-rebinding guard exactly.
 */
export function resolveNetwork(config?: ServiceConfig): NetworkConfig {
  const lanEnabled = process.env["TAC_BIND_LAN"] === "1" || config?.lan?.enabled === true;
  const allowedHosts = new Set<string>(LOCAL_HOSTS);
  if (lanEnabled) {
    for (const ip of lanIPv4s()) allowedHosts.add(ip.toLowerCase());
    allowedHosts.add(hostname().toLowerCase());
    const extras = [
      ...(config?.lan?.allowHosts ?? []),
      ...String(process.env["TAC_ALLOW_HOSTS"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ];
    for (const h of extras) allowedHosts.add(h.toLowerCase());
  }
  return { bindHost: lanEnabled ? "0.0.0.0" : "127.0.0.1", lanEnabled, allowedHosts };
}
