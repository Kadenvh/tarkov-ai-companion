import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isPortFree, selectPorts } from "./lib/ports.js";
import { waitForHealth } from "./lib/health.js";
import {
  buildSidecarSpawn,
  restartDelay,
  terminateAll,
  type SidecarConfig,
  type SidecarName,
} from "./lib/sidecar.js";

/**
 * @tac/desktop — Electron app shell (SPEC-9 M11.1). The main process is a
 * lifecycle manager: it spawns the existing @tac/service (:3141) and
 * @tac/agent (:3142) as child processes on the system Node 26 runtime,
 * health-gates the window on `GET /api/health`, renders the web UI the service
 * already serves, and owns the tray + single-instance + clean-shutdown +
 * crash-restart lifecycle.
 *
 * It supervises OUR Node services only. No code path here contacts the EFT game
 * process. @tier T0.
 */

const __dirname = dirname(fileURLToPath(import.meta.url)); // apps/desktop/dist-electron
const REPO_ROOT = resolve(__dirname, "..", "..", ".."); // -> repo root
const RESOURCES = resolve(__dirname, "..", "resources");
const PRELOAD = resolve(__dirname, "preload.cjs");
const ICON = resolve(RESOURCES, "icon.png");

const DEFAULT_SERVICE_PORT = Number(process.env["TAC_PORT"]) || 3141;
const DEFAULT_AGENT_PORT = Number(process.env["TAC_AGENT_PORT"]) || 3142;

interface Sidecar {
  readonly name: SidecarName;
  child: ChildProcess | null;
  restarts: number;
  startedAt: number;
  restartTimer: NodeJS.Timeout | null;
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let servicePort = DEFAULT_SERVICE_PORT;
let shuttingDown = false;
const sidecars = new Map<SidecarName, Sidecar>();

function log(msg: string): void {
  console.log(`[shell] ${msg}`);
}

function sidecarConfigs(ports: { service: number; agent: number }): SidecarConfig[] {
  return [
    {
      name: "service",
      filter: "@tac/service",
      portEnv: "TAC_PORT",
      port: ports.service,
      cwd: resolve(REPO_ROOT, "apps", "service"),
    },
    {
      name: "agent",
      filter: "@tac/agent",
      portEnv: "TAC_AGENT_PORT",
      port: ports.agent,
      cwd: resolve(REPO_ROOT, "apps", "agent"),
      // Point the agent at the (possibly relocated) service port.
      extraEnv: { TAC_SERVICE_URL: `http://127.0.0.1:${ports.service}` },
    },
  ];
}

/**
 * Packaged-mode env pointing the sidecars at the installed layout: read-only
 * snapshots/story + the built web UI ship under `resources/` (electron-builder
 * `extraResources`), the writable data-local root lives under the app's userData
 * dir (never Program Files). Empty in dev, so the sidecars keep their
 * REPO_ROOT-based defaults.
 *
 * `TAC_WEB_DIR` is the one the service serves at `/` — without it the packaged
 * service resolves `web/dist` relative to its bundled location and finds nothing
 * (the "Cannot GET /" symptom). The web build is staged at
 * `<resources>/sidecars/web/dist`.
 */
function packagedDataEnv(): Record<string, string> {
  if (!app.isPackaged) return {};
  return {
    TAC_SNAPSHOT_DIR: resolve(process.resourcesPath, "data", "snapshots"),
    TAC_STORY_DIR: resolve(process.resourcesPath, "data", "story"),
    TAC_DATA_DIR: resolve(app.getPath("userData"), "data"),
    TAC_WEB_DIR: resolve(process.resourcesPath, "sidecars", "web", "dist"),
  };
}

function launch(cfg: SidecarConfig): void {
  const plan = buildSidecarSpawn(cfg, {
    baseEnv: process.env,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    packagedEnv: packagedDataEnv(),
  });
  log(`spawning ${cfg.name}: ${plan.command} ${plan.args.join(" ")} (port ${cfg.port})`);

  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });

  const entry = sidecars.get(cfg.name);
  const state: Sidecar = entry ?? {
    name: cfg.name,
    child: null,
    restarts: 0,
    startedAt: 0,
    restartTimer: null,
  };
  state.child = child;
  state.startedAt = Date.now();
  sidecars.set(cfg.name, state);

  child.on("exit", (code, signal) => {
    log(`${cfg.name} exited (code ${code ?? "null"}, signal ${signal ?? "null"})`);
    state.child = null;
    if (shuttingDown) return;

    // Reset the restart counter after a stable run (>30s uptime).
    if (Date.now() - state.startedAt > 30_000) state.restarts = 0;
    state.restarts += 1;
    const delay = restartDelay(state.restarts);
    if (delay === null) {
      log(`${cfg.name} crashed too many times — giving up`);
      return;
    }
    log(`restarting ${cfg.name} in ${delay}ms (attempt ${state.restarts})`);
    state.restartTimer = setTimeout(() => launch(cfg), delay);
  });

  child.on("error", (err) => log(`${cfg.name} spawn error: ${err.message}`));
}

async function healthCheck(url: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(url);
  return { ok: res.ok, status: res.status };
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: ICON,
    backgroundColor: "#0e0f12",
    title: "Tarkov AI Companion",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (e) => {
    // First close hides to tray; real quit goes through app.quit().
    if (!shuttingDown) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Route target=_blank / external links to the OS browser, never a new window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void safeOpenExternal(url);
    return { action: "deny" };
  });

  void mainWindow.loadURL(`http://127.0.0.1:${servicePort}`);
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray(): void {
  const image = nativeImage.createFromPath(ICON);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
  tray.setToolTip("Tarkov AI Companion");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show", click: () => showWindow() },
      { label: "Hide", click: () => mainWindow?.hide() },
      { type: "separator" },
      { label: "Restart services", click: () => void restartServices() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => showWindow());
}

async function restartServices(): Promise<void> {
  log("restart requested");
  shuttingDown = true;
  terminateAll(trackedChildren());
  await delay(500);
  shuttingDown = false;
  for (const s of sidecars.values()) s.restarts = 0;
  await bootSidecars();
}

function trackedChildren(): ChildProcess[] {
  const out: ChildProcess[] = [];
  for (const s of sidecars.values()) {
    if (s.restartTimer) {
      clearTimeout(s.restartTimer);
      s.restartTimer = null;
    }
    if (s.child) out.push(s.child);
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeOpenExternal(url: string): Promise<void> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      await shell.openExternal(url);
    } else {
      log(`refused to open non-http(s) url: ${url}`);
    }
  } catch {
    log(`refused to open malformed url: ${url}`);
  }
}

async function bootSidecars(): Promise<void> {
  const [service, agent] = await selectPorts([DEFAULT_SERVICE_PORT, DEFAULT_AGENT_PORT], isPortFree);
  servicePort = service ?? DEFAULT_SERVICE_PORT;
  const agentPort = agent ?? DEFAULT_AGENT_PORT;
  log(`ports selected — service ${servicePort}, agent ${agentPort}`);

  const configs = sidecarConfigs({ service: servicePort, agent: agentPort });
  for (const cfg of configs) launch(cfg);
}

function registerIpc(): void {
  ipcMain.on("app:version", (event) => {
    event.returnValue = app.getVersion();
  });
  ipcMain.handle("app:openExternal", (_e, url: unknown) => {
    if (typeof url === "string") return safeOpenExternal(url);
    return undefined;
  });
  ipcMain.handle("app:restartServices", () => restartServices());
}

async function main(): Promise<void> {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on("second-instance", () => showWindow());

  await app.whenReady();
  registerIpc();
  createTray();

  await bootSidecars();

  const healthUrl = `http://127.0.0.1:${servicePort}/api/health`;
  log(`waiting for service health at ${healthUrl}`);
  try {
    const attempts = await waitForHealth({ url: healthUrl, fetchImpl: healthCheck, timeoutMs: 60_000 });
    log(`service healthy after ${attempts} attempt(s)`);
  } catch (err) {
    log(`service failed to become healthy: ${(err as Error).message} — opening window anyway`);
  }

  createWindow();

  app.on("activate", () => showWindow());
}

app.on("window-all-closed", () => {
  // Stay resident in the tray; only an explicit Quit ends the app.
});

app.on("before-quit", () => {
  shuttingDown = true;
  const children = trackedChildren();
  log(`quitting — terminating ${children.length} sidecar(s)`);
  const result = terminateAll(children);
  log(`signalled pids: ${result.signalled.join(", ") || "none"}`);
  // Escalate to SIGKILL for anything still alive shortly after.
  setTimeout(() => terminateAll(trackedChildren(), "SIGKILL"), 3_000).unref();
});

main().catch((err) => {
  console.error("[shell] fatal:", err);
  app.quit();
});
