# SPEC-9 — Desktop App Shell & Packaging (M11)

> Status: **M11.1 + M11.2 shipped** (2026-07-16) — `apps/desktop` produces a 137 MB signed **NSIS `.exe`** (`Tarkov AI Companion-0.1.0-x64.exe`) bundling the shell + service/agent sidecars + a Node 26 runtime + web UI + read-only data. The bundled service is verified booting to a 200 `/api/health` with the real snapshot loaded. **MSI deferred** (WiX needs a committed `.ico` + author). M11.3 auto-update still open. Where this and [CONTRACTS.md](CONTRACTS.md) disagree, CONTRACTS wins. Module **M11**.

## Decision: **Electron**, not Tauri

The runtime is Node all the way down — `@tac/service` uses **`node:sqlite`** (Node 26 builtin), `@tac/agent` uses `@anthropic-ai/claude-agent-sdk`, and the watchers are Node fs/child_process. Tauri's Rust backend + OS webview would fight every one of those. Electron bundles Node + Chromium, and `electron-builder` emits both **NSIS `.exe`** and **`.msi`** — matching the installable tray-app UX Kaden wants (the TarkovMonitor parallel). **Call: Electron.**

## Architecture — shell wraps, does not rewrite

The Electron **main process is a lifecycle manager**, not a new backend:

- **Sidecars, not in-process.** Main spawns the *existing* `@tac/service` (`3141`) and `@tac/agent` (`3142`) as child processes on a **bundled Node 26 runtime**. This is deliberate: Electron's own bundled Node may not expose the experimental `node:sqlite`, so the service must run on real Node 26 — running it as a sidecar preserves the DB layer with **zero rewrite**. `@tac/monitor` (`3143`) is spawned optionally.
- **Renderer = the existing web app.** A `BrowserWindow` points at `http://127.0.0.1:3141` — the service already serves `apps/web/dist` + `/api` + `/ws` (CONTRACTS §5/§6). No separate renderer build pipeline.
- **Tray + lifecycle.** Tray icon (show/hide, quit), single-instance lock, optional launch-on-startup, health wait (don't open the window until `/api/health` is 200), graceful shutdown that kills sidecars, crash-restart with backoff.
- **Ports stay env-driven** (`TAC_PORT` etc., CONTRACTS §2); shell picks free ports if the defaults are taken and passes them to the renderer.

```
apps/desktop  (@tac/desktop, Electron main + preload)
  main.ts       spawn service/agent sidecars, tray, window, single-instance, lifecycle
  preload.ts    minimal contextBridge (app version, open-external, restart-service)
  resources/    bundled Node 26 runtime + packaged service/agent + icons
  electron-builder.yml   nsis + msi targets, appId, version from root package.json
```

## Deliverables (testable)

- **M11.1 Shell + sidecars.** Spawn/supervise service (+agent), health-gate the window, tray, single-instance, clean shutdown. Test: launching the built app serves the UI and `/api/health` is green; quitting leaves no orphan Node processes.
- **M11.2 Installer.** `pnpm app:dist` → signed-or-unsigned NSIS `.exe` + `.msi` under `dist/`. Test: installer runs, app launches, uninstall removes cleanly. (Code-signing deferred — personal/unsigned first; document SmartScreen prompt.)
- **M11.3 Auto-update (deferred, reserved).** electron-updater feed — out of scope for v1, noted so the app is structured for it (versioned artifacts, update channel).

## UI elevation sub-track (the "humiliating UI" fix)

Separate from packaging, tracked here so it ships *with* the app: the renderer stays React/Vite but gets a coherent design system pass to reach the tarkovtracker.org / tarkov.dev bar and the glance-readable second-monitor goal (NORTH-STAR H1). Not fully specced yet — a design pass precedes it (leverage the `dataviz` + `artifact-design` guidance for the stat/plan surfaces). Explicitly **not** a rebuild of what tarkov.dev/TarkovTracker do well (Never-list); it re-skins *our* unique surfaces (Tonight's Plan, Coach debrief, foresight).

## Open questions
- Code-signing cert (SmartScreen) — personal use can ship unsigned; revisit if distributed (H3).
- Does the shell embed the `@tac/monitor` window (3143) or launch it on demand? (Default: on-demand.)
- Bundled Node 26 runtime sourcing for `electron-builder` extraResources (pin the version that ships `node:sqlite`).
