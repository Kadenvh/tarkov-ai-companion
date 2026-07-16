import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AlertId, PublicConfig } from "./types.js";
import { ALERT_IDS, defaultAlertToggles } from "./alerts.js";
import { DEFAULT_RUNTHROUGH_SEC, DEFAULT_SCAV_COOLDOWN_SEC } from "./timers.js";

/**
 * Monitor config: timing thresholds, per-alert toggles, and the tarkov.dev
 * submission opt-ins (queue times + goons sightings, both OFF by default).
 * Persisted best-effort to data/local/monitor.json so opt-ins survive restarts.
 * The account id (for goons de-dup) is stored here and never leaves the machine
 * unless the user turns goons submission on.
 * @tier T0
 */

export interface MonitorConfig {
  runthroughSec: number;
  scavCooldownSec: number;
  submitQueueTimes: boolean;
  submitGoons: boolean;
  accountId: string | null;
  alerts: Record<AlertId, boolean>;
}

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

function dataDir(): string {
  return process.env["TAC_DATA_DIR"] ?? resolve(REPO_ROOT, "data", "local");
}

function configPath(): string {
  return resolve(dataDir(), "monitor.json");
}

export function defaultConfig(): MonitorConfig {
  return {
    runthroughSec: Number(process.env["TAC_MONITOR_RUNTHROUGH_SEC"] ?? DEFAULT_RUNTHROUGH_SEC),
    scavCooldownSec: Number(process.env["TAC_MONITOR_SCAV_SEC"] ?? DEFAULT_SCAV_COOLDOWN_SEC),
    submitQueueTimes: false,
    submitGoons: false,
    accountId: process.env["TAC_MONITOR_ACCOUNT_ID"] ?? null,
    alerts: defaultAlertToggles(),
  };
}

/** Coerce arbitrary parsed JSON into a valid config, filling gaps from defaults. */
export function coerceConfig(raw: unknown, base: MonitorConfig = defaultConfig()): MonitorConfig {
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const alerts = { ...base.alerts };
  if (r["alerts"] && typeof r["alerts"] === "object") {
    const a = r["alerts"] as Record<string, unknown>;
    for (const id of ALERT_IDS) if (typeof a[id] === "boolean") alerts[id] = a[id] as boolean;
  }
  return {
    runthroughSec: numOr(r["runthroughSec"], base.runthroughSec),
    scavCooldownSec: numOr(r["scavCooldownSec"], base.scavCooldownSec),
    submitQueueTimes: boolOr(r["submitQueueTimes"], base.submitQueueTimes),
    submitGoons: boolOr(r["submitGoons"], base.submitGoons),
    accountId: typeof r["accountId"] === "string" && r["accountId"] ? (r["accountId"] as string) : base.accountId,
    alerts,
  };
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}
function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

export function loadConfig(): MonitorConfig {
  try {
    const text = readFileSync(configPath(), "utf8");
    return coerceConfig(JSON.parse(text));
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(config: MonitorConfig): void {
  try {
    mkdirSync(dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf8");
  } catch {
    // best-effort — an unwritable data dir must not crash the monitor
  }
}

/** The subset of config exposed to the window (never leaks the raw account id). */
export function toPublicConfig(config: MonitorConfig): PublicConfig {
  return {
    runthroughSec: config.runthroughSec,
    scavCooldownSec: config.scavCooldownSec,
    submitQueueTimes: config.submitQueueTimes,
    submitGoons: config.submitGoons,
    hasAccountId: config.accountId !== null,
    alerts: { ...config.alerts },
  };
}
