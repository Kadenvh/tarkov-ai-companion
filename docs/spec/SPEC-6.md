# SPEC-6 — Service daemon (M5.1, M5.6, M8.1–M8.3 glue)

> Phase spec derived from [SPEC.md](../../SPEC.md) modules **M5.1** (daemon), **M5.6** (counter-metric) and the **M8** platform rows, bound by [CONTRACTS.md](CONTRACTS.md) §5. Status: **COMPLETE (2026-07-11)** — `apps/service` built and tested (51/51).

## Objective
One always-on local process that owns the machine-facing half of the product: watcher hosting, the REST/WS contract every other surface (web, agent) consumes, plan rebuilding, patch sentinel, and the app's own cost accounting.

## Scope (`apps/service`)

| File | Owns |
|---|---|
| `src/config.ts` | `data/local/config.json` (zod `ServiceConfig`): `{ profiles[{key,label,gameMode}], activeProfile, tarkovTrackerToken?, eftPath?, agentUrl? }`; created with `main-regular` defaults on first boot; env overrides `TAC_DATA_DIR` / `TAC_PORT` / `TAC_AGENT_URL` / `TAC_AGENT_PORT` / `TAC_NO_WATCH` (M8.3) |
| `src/app.ts` | `buildApp(opts)` Fastify factory **without** listen — inject-testable; registers WS, all route groups, static hosting, metrics hook, onClose teardown |
| `src/runtime.ts` | `ServiceRuntime`: active `ProfileStore`, per-mode lazy world/market caches, story dataset, WS hub, plan pipeline, metrics, watcher lifecycle, patch sentinel, profile switching. Every environment touchpoint (process check, nvidia-smi, agent fetch, logs/screenshots/settings dirs, game-version probe) is constructor-injectable |
| `src/main.ts` | boot: config → store → world/market/story → watchers (skipped under `TAC_NO_WATCH=1`) → listen 3141 → graceful SIGINT/SIGTERM shutdown; one startup line per subsystem; measures + logs a cold plan build against the M3.2 < 2 s budget |
| `src/ws.ts` | `/ws` hub (`@fastify/websocket`): bridges all CONTRACTS §3 emitter events verbatim + `plan.updated` + `notice`; hello frame `{type:"hello",payload:{profileKey}}` on connect |
| `src/plan.ts` | pipeline `toPlayerState() → resolveGoalTasks(meta goals) → buildPlan(horizon, weights)` + per-raid foresight warnings + 16-hex content hash; per-horizon cache; `state.changed` → ~1.5 s debounce → rebuild → `plan.updated` (hash-gated) |
| `src/metrics.ts` | M5.6 counter-metric: request counts by route + WS-connected seconds, in-memory session counters folded into `meta.metrics` lifetime totals (flush every 30 s; persistence writes bypass the emitter so bookkeeping never triggers a replan) |
| `src/routes/*` | core / planning / environment / insights / agent-proxy / platform route groups |

## API — CONTRACTS §5 verbatim, plus documented extensions

Contracted routes implemented exactly: `GET /api/health`, `GET /api/profiles`, `POST /api/profiles/select`, `GET /api/state`, `POST /api/state/manual`, `POST /api/state/import/tarkovtracker`, `GET /api/story`, `GET /api/graph/summary` (§5.1); `GET|POST /api/goals`, `GET /api/plan?horizon=`, `GET /api/quartermaster?raids=`, `GET /api/foresight` (§5.2); `GET /ws` (§5.3); `GET /api/environment/settings`, `POST /api/environment/settings/apply` (409 while game runs), `GET /api/environment/nvidia`, `GET /api/environment/perf`, `GET /api/environment/ammo?caliber=`, `GET /api/insights/raids`, `GET /api/insights/economy` (§5.4); `POST /api/agent/chat`, `POST /api/agent/briefing`, `GET /api/agent/health` proxied to 3142 with 503-when-down (§5.5).

**Documented extensions** (additive; nothing contracted was changed or removed):

| Route | Purpose |
|---|---|
| `POST /api/state/backfill { logsDir? }` | run historical log backfill (M2.3 surface), returns `BackfillResult` counts |
| `POST /api/environment/perf/import { csv \| path, map?, raidId?, ts? }` | PresentMon CSV → one `perf_samples` row in the profile DB (M6.3 wiring) |
| `GET /api/insights/fingerprint` | M7.3 playstyle fingerprint (feeds agent learned weights M4.5) |
| `POST /api/notify { title, body }` | broadcast a WS `notice` frame — the agent's M4.4 notification path |
| `GET /api/metrics` | M5.6 session + lifetime time-in-app counters |
| `POST /api/story/progress { stages?, decisions? }` | persist story-tracker progress (web Goals view); `GET /api/story` and `/api/foresight` reflect it via `endingReachability` |
| `/api/health` extra fields | `gameVersion` + `patchDetected` (M8.2 sentinel flag) alongside the contracted shape |

## Acceptance

- **M5.1** *"survives sleep/wake + game restarts; auto-starts option"* — watchers are polling + self-re-arming (state-engine); daemon holds no game handles, so sleep/wake and game restarts are non-events; graceful shutdown verified; Windows auto-start documented in the README (`schtasks` ONLOGON). **Met** (long-run soak is operational, not testable in CI).
- **M5.6** *"time-in-app metric visible to us"* — `GET /api/metrics` (requests by route, WS-connected seconds, lifetime totals persisted per profile). **Met.**
- **M3.2 latency** *"replan < 2 s"* — measured and logged at every boot; ~5 ms cold on the real 1.0.6 snapshot; test asserts `buildMs < 2000`. **Met.**
- **M8.1 (glue)** — patch detection consumes the log-folder version via the watcher's `patch.detected`; on mismatch the service broadcasts a "run `pnpm snapshot`" notice and flags `/api/health`. The snapshot/diff pipeline itself is data-core's (SPEC-0). **Glue met.**
- **M8.2** — sentinel live end-to-end: emitter event → WS notice + health flag (tested). The wiki⟷API cross-validation report remains data-core's invariant suite, triggered manually post-snapshot. **Met at service level.**
- **M8.3** *"fresh-machine setup < 10 min"* — first boot self-creates config + profile DB; zero manual steps beyond `pnpm install && pnpm --filter @tac/service start`. **Met.**

## Test evidence
**51/51 green** (`pnpm --filter @tac/service test`), all through `buildApp()` + `app.inject()` or a real ephemeral-port listen with the global `WebSocket` client: every contracted route + every extension, patch-sentinel health flag + WS notice, plan.updated debounce (two rapid writes → exactly one broadcast, last write wins), multi-client WS fan-out, settings-apply 409 via injected process check and real backup-then-write via temp dirs, TarkovTracker import via injected fetch (success/401-path/unreachable-502), agent proxy 503 + forward + error-mirroring, SPA fallback (never for `/api`), config first-boot/fallback/round-trip. Tests use the real on-disk snapshot world, in-memory profile DBs, and temp data dirs — no network, no real EFT/Documents/data-local writes. Boot smoke-tested live on this machine (port 3199, temp data dir): all subsystem lines clean, real installed version 1.0.6.0.46010 detected, `patchDetected:false`.

## Design decisions
- **Runtime object over Fastify decoration sprawl.** One `ServiceRuntime` carries store/hub/planner/metrics/config; routes take `(app, rt)`. Profile switching swaps the store and rebinds hub + planner + sentinel atomically, flushing metrics to the outgoing store first.
- **Plan cache is hash-gated.** `plan.updated` only broadcasts when the rebuilt bundle's hash differs from the last one seen, so watcher noise that doesn't change the plan stays silent on the wire. (Fixed a salvage bug where `get()` recorded the hash before the debounce comparison, making the broadcast unreachable.)
- **Metrics writes bypass the store emitter** — otherwise every 30 s flush would `state.changed` → debounce → rebuild → forever.
- **Fail-honest agent proxy.** Upstream statuses are mirrored, not masked; only transport failure maps to 503 with the exact start command in the message. 120 s timeout for chat/briefing (LLM latency), 2 s for health.
- **World/market/story loaded once per game mode, lazily** — switching to the PvE profile loads PvE data on first touch; the regular-mode caches stay warm.
- **`exactOptionalPropertyTypes` bridging** at the story boundary (`decisionsForReachability`) rather than loosening planner types.

## Deviations from CONTRACTS/SPEC
- None against §5 shapes/paths/status codes. Extensions above are additive and documented here (allowed per the build brief).
- `GET /api/health` carries two extra fields (`gameVersion`, `patchDetected`) — additive.
- M8.1's *automatic* snapshot+diff prompt is a notice + health flag, not an auto-run of `pnpm snapshot` (a network fetch should stay user-triggered on a gaming box mid-session).

## Notes for the integration wave
- `apps/web`: dev-proxy `/api` + `/ws` → 3141; `plan.updated` frames carry `{hash, builtAt, horizon, raids, remainingGoalTasks}` — refetch `GET /api/plan` on hash change. `GET /api/story` already merges player progress; POST `/api/story/progress` from the chapter tracker.
- `apps/agent`: subscribe to `/ws`, act on `raid.ended`, post results to `POST /api/notify`; all eight contracted tools map 1:1 onto routes above; `GET /api/insights/fingerprint` is the M4.5 input.
- `buildApp` accepts `staticDir` — point it at `apps/web/dist` output; SPA fallback is already wired.
- Windows auto-start command lives in `apps/service/README.md`.
