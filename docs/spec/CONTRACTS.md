# CONTRACTS — cross-package interface contract
### v1.0 · 2026-07-11 · binding for P2–P4 build waves

> Every package/app builder follows this document exactly. Where a SPEC-n doc and this file disagree, **this file wins** (update both if a change is negotiated). Conventions inherited from existing packages: ESM (`"type": "module"`), strict TS extending [tsconfig.base.json](../../tsconfig.base.json), `exports: { ".": "./src/index.ts" }` (no build step — tsx/vitest consume TS directly), zod at boundaries, vitest tests in `test/`, fixtures in `test/fixtures/`, risk tiers declared as `@tier T0..T4` JSDoc on modules that touch the environment.

## 1. Package map & ownership

| Package | npm name | Owns | Depends on |
|---|---|---|---|
| `packages/shared` | `@tac/shared` | TarkovId, GameMode, shared zod utils | — |
| `packages/data-core` | `@tac/data-core` | snapshots, task graph, wiki, story, **market loaders (items/barters/crafts/traders — added by quartermaster builder)** | shared |
| `packages/planner` | `@tac/planner` | solver, availability, levels, foresight, **quartermaster.ts (M3.5)** | shared, data-core |
| `packages/state-engine` | `@tac/state-engine` | SQLite store, log watcher/parser, backfill, screenshot watcher, XP estimator, TarkovTracker mirror, raid journal, patch detection | shared, data-core |
| `packages/environment` | `@tac/environment` | EFT settings advisor, NVIDIA advisor, PresentMon ingest, ammo/meta tiers | shared, data-core |
| `packages/insights` | `@tac/insights` | raid analytics, economy tracking, playstyle fingerprint | shared (reads DB via SQL contract §4) |
| `apps/service` | `@tac/service` | Fastify daemon: REST+WS (§5), watcher host, serves web build, patch sentinel | all packages |
| `apps/web` | `@tac/web` | React/Vite UI (§6) | service API only (HTTP) |
| `apps/agent` | `@tac/agent` | Claude copilot: tools over service API, briefings, replan pipeline, learned weights | service API only (HTTP/WS) |

## 2. Cross-cutting decisions (recorded deviations)

- **SQLite driver: `node:sqlite` (`DatabaseSync`), NOT better-sqlite3.** Node 26 ships it built-in; zero native-compile risk on this machine; same synchronous embedded class. This supersedes SPEC.md §0 "better-sqlite3". No new native deps anywhere.
- **Local mutable data lives in `data/local/`** (gitignored): `data/local/config.json` (profiles, active profile, tokens), `data/local/profiles/<profileKey>.sqlite` (one DB per profile). `profileKey = "<accountLabel>-<gameMode>"`, e.g. `main-regular`, `main-pve`, `alt-regular`.
- **Ports:** service `3141` (env `TAC_PORT`), agent `3142` (env `TAC_AGENT_PORT`), vite dev `5173` (proxies `/api` + `/ws` → 3141).
- **Node WebSocket:** use the global `WebSocket` (Node ≥22) for clients; `@fastify/websocket` server-side.
- **Committed fixtures never contain real profile ids / account ids** — replace with fake 24-hex ids when excerpting real logs.
- **Nothing ever touches the EFT process/memory/input (T4)**; settings writes only game-closed with timestamped backups (T1-write).

## 3. Shared event vocabulary

`@tac/state-engine` exports a typed emitter. Event names and payloads (also the WS wire format, §5.3):

| Event | Payload |
|---|---|
| `raid.created` | `{ sid, ts }` (queue entered) |
| `raid.confirmed` | `{ sid, map, mode, ts }` |
| `raid.started` | `{ sid, map, mode, ts }` |
| `raid.ended` | `{ sid, map, mode, ts, durationSec, outcome }` outcome: `survived\|died\|unknown` |
| `quest.changed` | `{ taskId, status, ts }` status: `started\|completed\|failed` (log types 10/11/12) |
| `flea.sale` | `{ itemName, amount, ts }` |
| `position` | `{ map, x, y, z, filename, ts }` |
| `profile.detected` | `{ profileId, mode, ts }` |
| `patch.detected` | `{ version, ts }` (log-folder version differs from snapshot) |
| `state.changed` | `{ reason, ts }` (any store mutation — UI refresh signal) |

## 4. SQLite schema contract (DDL — the insights/state boundary)

`@tac/state-engine` owns migrations; `@tac/insights` queries the same file read-only via `node:sqlite`. Tables (per-profile DB, so no profile column):

```sql
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- keys: level, xpOffset, prestige, faction, progressEpoch, gameMode,
--       goals (JSON Goal[]), weights (JSON PlannerWeights), learnedWeights (JSON),
--       tarkovTrackerToken? (config.json preferred), lastLogCursor (JSON)
CREATE TABLE IF NOT EXISTS task_state (
  task_id TEXT PRIMARY KEY, complete INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0, ts TEXT);
CREATE TABLE IF NOT EXISTS objective_state (
  objective_id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0, ts TEXT);
CREATE TABLE IF NOT EXISTS hideout_state (station_id TEXT PRIMARY KEY, level INTEGER NOT NULL, ts TEXT);
CREATE TABLE IF NOT EXISTS trader_state (trader_id TEXT PRIMARY KEY, level INTEGER NOT NULL DEFAULT 1, rep REAL NOT NULL DEFAULT 0, ts TEXT);
CREATE TABLE IF NOT EXISTS raids (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT, map TEXT, mode TEXT,
  queued_at TEXT, started_at TEXT, ended_at TEXT,
  queue_sec REAL, duration_sec REAL,
  outcome TEXT NOT NULL DEFAULT 'unknown',   -- survived|died|unknown
  source TEXT NOT NULL DEFAULT 'live',       -- live|backfill
  version TEXT);
CREATE TABLE IF NOT EXISTS quest_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
  status TEXT NOT NULL, ts TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'live');
CREATE TABLE IF NOT EXISTS flea_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_name TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, raid_id INTEGER, map TEXT,
  x REAL, y REAL, z REAL, filename TEXT, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calibrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, -- level|xp
  value REAL NOT NULL, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS perf_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT, raid_id INTEGER, map TEXT, ts TEXT NOT NULL,
  fps_avg REAL, fps_p1 REAL, frametime_p50 REAL, frametime_p95 REAL, frametime_p99 REAL,
  source TEXT NOT NULL DEFAULT 'presentmon');
```

Store API (state-engine exports): `openProfile(profileKey, opts?) → ProfileStore` with typed getters/setters over the above, `toPlayerState(): PlayerState` (the planner input, already defined in `@tac/planner` state.ts), `importTarkovTracker(progressJson)`, event emitter per §3.

## 5. Service REST + WS API (`apps/service`)

All routes JSON; zod-validated; errors `{ error: string }` with proper status.

### 5.1 Core
- `GET /api/health` → `{ ok, version, snapshotVersion, profileKey, gameMode }`
- `GET /api/profiles` / `POST /api/profiles/select { profileKey }`
- `GET /api/state` → full store dump (level, xp estimate + confidence, tasks, hideout, traders, prestige, epoch)
- `POST /api/state/manual` → partial updates `{ level?, faction?, prestige?, hideout?, traders?, tasks? }` (M2.6 quiz/manual)
- `POST /api/state/import/tarkovtracker { token }` → seed from .org (M2.1/M2.7)
- `GET /api/story` → story dataset + per-chapter player status
- `GET /api/graph/summary` → task counts, kappa/LK remaining

### 5.2 Planning
- `GET /api/goals` / `POST /api/goals { goals: Goal[], weights?: PlannerWeights }`
- `GET /api/plan?horizon=10` → `Plan` (planner) + foresight warnings attached per raid + plan hash + `mapNames` (map id → display name for every planned raid; consumers never render raw ids)
- `GET /api/quartermaster?raids=5` → `AcquisitionPlan` (§7)
- `GET /api/foresight` → all pending irreversibility warnings for current goals

### 5.3 Events
- `GET /ws` (WebSocket): server pushes `{ type: <event name §3> | "plan.updated", payload, ts }`. On connect, sends `{ type: "hello", payload: { profileKey } }`.

### 5.4 Environment & insights
- `GET /api/environment/settings` → current EFT settings + diffs vs recommended profiles
- `POST /api/environment/settings/apply { profile }` → 409 if game running; backs up first
- `GET /api/environment/nvidia` → detected GPU/driver + recommendations
- `GET /api/environment/perf` → per-map FPS percentiles, regressions
- `GET /api/environment/ammo?caliber=` → ammo tier table (from snapshot)
- `GET /api/insights/raids` → survival by map/hour/duration, session rhythm
- `GET /api/insights/economy` → flea income curve, net-worth estimates

### 5.5 Agent proxy
- Service does **not** embed the LLM. `apps/agent` runs on 3142; service proxies `POST /api/agent/chat`, `POST /api/agent/briefing { raidIndex }`, `GET /api/agent/health` to it (503 with helpful message if agent down).

## 6. Web app (`apps/web`)

Vite + React 19, TS. Dev: proxy `/api` + `/ws` to 3141. Build output `apps/web/dist` served by service at `/`. Views (left-nav shell, dark, second-monitor glance-readable): **Tonight's Plan** (raid cards: map, batch with reasons, prep list from quartermaster, foresight warnings, level before/after), **Goals** (goal picker incl. NL box → agent; Kappa/LK %; story chapter tracker ported from `auto-tracker/tarkov-story-tracker.tsx`), **Quartermaster** (buy/barter/craft/FIR table w/ costs), **Insights**, **Environment** (settings advisor + perf), **Map** (position trail from `position` events over tarkov.dev map links). Live WS badge for raid state.

## 7. Quartermaster output shape (M3.5, `@tac/planner`)

```ts
interface AcquisitionItem {
  itemId: string; name: string; count: number; fir: boolean;
  forTasks: { id: string; name: string }[];
  route: { kind: "flea"|"trader"|"barter"|"craft"|"find-in-raid";
           detail: string; unitCost?: number; totalCost?: number;
           levelGate?: number; traderGate?: string;
           craftStation?: string; craftMinutes?: number;
           raidIndex?: number /* find-in-raid: which planned raid */ };
  alternatives: AcquisitionItem["route"][];
  reasons: string[];
}
interface AcquisitionPlan {
  raids: number; items: AcquisitionItem[];
  totalRubles: number; craftSchedule: { itemId: string; station: string; startBy: string; minutes: number }[];
}
```

## 8. Agent (`apps/agent`) contract

- Uses `@anthropic-ai/claude-agent-sdk` (rides Claude Code auth on this machine; honors `ANTHROPIC_API_KEY` when set). Every game fact must come from a tool call (service API); system prompt forbids unsourced game claims.
- Tools: `get_state`, `get_plan`, `get_quartermaster`, `get_story`, `get_foresight`, `set_goals`, `lookup_task`, `wiki_cite`.
- `POST /chat { message, sessionId? }` → `{ reply, toolCalls[] }`; `POST /briefing { raidIndex }` → `{ briefing }` (<200 words).
- Replan pipeline: subscribes to service `/ws`; on `raid.ended` → refetch plan → generate briefing for next raid → POST notification back to service (`POST /api/notify` broadcast as WS `notice`).
- **Mock mode** (`TAC_AGENT_MOCK=1`): deterministic canned model layer so tests run without any Claude auth.
- Learned weights (M4.5): pure, deterministic proposer in the agent (fingerprint + journal outcomes → proposed `PlannerWeights` delta with per-change rationale, `mapCost` clamped to [0.5, 3]), surfaced via `GET /propose-weights`. The agent persists nothing (it stays stateless; single-writer rule on the profile DB) — weights become active only when the user confirms, via `POST /api/goals` (optionally mirrored to `meta.learnedWeights` by the service). Always inspectable. *(Amended 2026-07-11 to match SPEC-3 — the original draft said the agent persists to `meta.learnedWeights`.)*

## 9. Environment package facts (from research/06)

Builder must read [docs/research/06-environment-paths.md](../research/06-environment-paths.md) for verified paths: EFT install (registry `HKLM\SOFTWARE\WOW6432Node\...\EscapeFromTarkov` `InstallLocation` — verified live; launcher-config fallback), `<install>\Logs\log_<date>_<version>\*` streams, EFT graphics/game settings files (plain JSON on disk), NVIDIA DRS store, screenshots folder `%USERPROFILE%\Documents\Escape From Tarkov\Screenshots` (filename encodes position+quaternion — may not exist until first screenshot; watcher must re-arm on folder creation). PresentMon: ingest CSV if the user runs it; never bundle binaries.

## 10. Definition of done (every wave)

`pnpm -r typecheck` and `pnpm -r test` green · new logic ≥80% covered where practical · README.md per package (what/why/tier/how-to-test) · SPEC-n doc updated to match reality · no root-file edits beyond declared ones · no new native/node-gyp dependencies.
