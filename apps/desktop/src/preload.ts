import { contextBridge, ipcRenderer } from "electron";

/**
 * Minimal, sandbox-safe preload bridge (SPEC-9 M11.1). Runs with
 * contextIsolation + sandbox, so it exposes ONLY three narrow capabilities to
 * the renderer — no Node, no ipcRenderer, no filesystem. Compiled to CommonJS
 * (`preload.cjs`) because sandboxed preload scripts cannot be ES modules.
 *
 * @tier T0
 */

export interface DesktopBridge {
  /** App version from the Electron main process (synchronous, read-only). */
  readonly appVersion: string;
  /** Open an http(s) URL in the user's default browser (validated in main). */
  openExternal(url: string): Promise<void>;
  /** Restart the supervised @tac/service + @tac/agent sidecars. */
  restartServices(): Promise<void>;
}

const bridge: DesktopBridge = {
  appVersion: ipcRenderer.sendSync("app:version") as string,
  openExternal: (url: string) => ipcRenderer.invoke("app:openExternal", url),
  restartServices: () => ipcRenderer.invoke("app:restartServices"),
};

contextBridge.exposeInMainWorld("tacDesktop", bridge);
