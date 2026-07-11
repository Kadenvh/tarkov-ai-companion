# @tac/service

The local daemon (SPEC M5.1): one Fastify process that hosts the watchers, exposes the REST + WebSocket API from [CONTRACTS §5](../../docs/spec/CONTRACTS.md), rebuilds the plan on state changes, proxies the AI agent, and serves the web build. Everything the UI and agent know arrives through this process.

**Tier:** T1 — passively reads game logs/screenshots via `@tac/state-engine` watchers; the only environment *write* is the settings apply route, which delegates to `@tac/environment`'s game-closed + backup-first path (409 while EFT runs). It never touches the EFT process, memory, or input.

## Run

```powershell
pnpm --filter @tac/service start     # boot on http://127.0.0.1:3141 (REST + /ws)
pnpm --filter @tac/service dev       # tsx watch mode
```

First boot creates `data/local/config.json` (profiles, active profile, tokens) with a `main-regular` default. One SQLite file per profile appears under `data/local/profiles/`.

Env overrides:

| Var | Effect |
|---|---|
| `TAC_DATA_DIR` | relocate `data/local` (config, profile DBs, settings backups) |
| `TAC_PORT` | service port (default 3141) |
| `TAC_AGENT_URL` / `TAC_AGENT_PORT` | where the agent proxy forwards (default `http://localhost:3142`) |
| `TAC_NO_WATCH=1` | skip the log + screenshot watchers |
| `TAC_EFT_PATH` | EFT install override for log discovery / patch detection |

Boot logs one line per subsystem (config, store, world, story, watchers, agent proxy, plan) and measures a cold plan build — the M3.2 "< 2 s replan" budget is checked and printed at every startup (currently ~5 ms on the 1.0.6 snapshot).

### Windows auto-start

Run it as a logon task so the watchers are already tailing when the game launches:

```powershell
schtasks /Create /TN "TarkovCompanionService" /SC ONLOGON /RL LIMITED `
  /TR "pwsh -WindowStyle Hidden -Command \"cd C:\Users\Kaden\tarkov-aim-lab; pnpm --filter @tac/service start\""
```

(or drop a shortcut with that command into `shell:startup`). The daemon survives sleep/wake and game restarts: watchers poll and re-arm on new log sessions/screenshot folders, and `SIGINT`/`SIGTERM` shut down cleanly (watchers stopped, metrics flushed, DB closed).

## Surface

- **REST** — CONTRACTS §5.1–§5.5 verbatim, plus documented extensions (see [SPEC-6](../../docs/spec/SPEC-6.md)): `POST /api/state/backfill`, `POST /api/environment/perf/import`, `GET /api/insights/fingerprint`, `POST /api/notify`, `GET /api/metrics`, `POST /api/story/progress`.
- **WS `/ws`** — hello frame `{type:"hello",payload:{profileKey}}`, then every state-engine event (§3 names verbatim) plus `plan.updated` and `notice`.
- **Plan pipeline** — `state.changed` → 1.5 s debounce → rebuild → `plan.updated` broadcast (hash-gated, so no-op churn stays silent).
- **Patch sentinel (M8.2)** — `patch.detected` from the log watcher → WS notice + `patchDetected` flag in `/api/health`.
- **Static** — serves `apps/web/dist` at `/` (SPA fallback) when the build exists.

## Test

```powershell
pnpm --filter @tac/service typecheck
pnpm --filter @tac/service test      # 51 tests, all inject/ephemeral-port based
```

Tests run against the real on-disk snapshot world, an in-memory profile DB, a temp data dir, and injected process-check/nvidia/agent/settings-dir fakes. Watchers are never started; nothing touches the real EFT install, Documents, or `data/local`.
