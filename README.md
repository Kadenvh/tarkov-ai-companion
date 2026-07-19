# Tarkov AI Companion — "The Coach"

A **local-first, account-safe progression coach** for Escape from Tarkov. It reconstructs your player state from the game's own logs (and your live TarkovTracker feed), runs a real optimizer over the full task/hideout/story graph, and puts a grounded Claude copilot on top that plans before a raid, debriefs after, and speaks up the moment a choice matters.

Not another tracker, not another wiki mirror. Every existing tool answers a *reference* question — "what exists?" ([tarkov.dev](https://tarkov.dev)), "what have I done?" ([TarkovTracker](https://tarkovtracker.org)), or "what is it worth?" (RatScanner). **This answers "what should I do next?"** — the only question a progression-driven player actually has.

The delta, concretely: per-raid task **batching** from a real solver (not a sorted list), XP/level **simulation** with gate-stall detection, irreversibility **foresight** (fail-chains + story-ending locks), plan-tied **acquisition** (buy/barter/craft/find routing), and event-driven **replanning** — narrated by a copilot that only ever states facts it can cite.

## Safety stance (the line that is never crossed)

This is a public tool for an anti-cheat-protected game, so the boundary is the headline feature, not a footnote:

- **T0 / T1 only.** The suite reads files EFT itself writes — logs, screenshot filenames, `Settings\*.ini` — and talks to public data APIs and your own local tools. That is the same risk class as TarkovMonitor and RatScanner (multi-year, zero-ban track record).
- **It never touches the game.** No process access, no memory reading, no DLL injection, no packet interception, no input automation, no game-file modification — ever, on any account, including "just for testing." BattlEye sees a plain user-mode app that never interacts with the game window.
- **Reads default-on, writes opt-in and reversible.** The only writes are to files the in-game UI itself exposes (e.g. EFT settings), performed **only while the game is closed**, backed up first, and one-click revertible.
- **We read TarkovTracker, we don't fight it.** Your progress is synced *in* from TarkovTracker (which TarkovMonitor already feeds); we never write back, so we never contend on its shared write quota.

Full policy and the reasoning behind the never-list: [SPEC.md §1](SPEC.md).

## Feature tour (by pillar)

- **Progression intelligence** — Raid Director (greedy + lookahead batch solver over the 510-task DAG), XP/level simulator with stall detection (Collector@45, flea and trader gates), Foresight Guard (fail-condition exclusivity + story-decision locks), and a Quartermaster that routes every needed item to its cheapest source with craft-timer scheduling.
- **Player state, automatic** — SQLite store shaped like TarkovTracker, a T1 log watcher (raids, quest transitions, flea sales), historical backfill of every session on disk, screenshot-position tracking, and an XP estimator — with TarkovTracker as the live read-mirror.
- **The Coach (AI copilot)** — a grounded Claude agent (Agent SDK) whose every game fact comes from a tool call against the local service; sub-200-word per-raid briefings, natural-language goal intake, a post-raid debrief, and a raid-end → replan → notify loop. Answers carry tool-call citations.
- **Environment & connectors** — a capability-first connector layer for the tools you already run (EFT config, Wootility, NVIDIA, SteelSeries Sonar, plus manual capture), feeding a settings advisor, NVIDIA driver-profile guidance, PresentMon frame-telemetry ingest, and config-vs-outcome attribution.
- **Insights** — survival by map/hour/duration, session rhythm, flea income and net-worth curves with goal-ETA, config↔outcome attribution, a per-raid highlight index, and a playstyle fingerprint.
- **Sources** — one disciplined client for every remote feed (tarkov.dev JSON, TarkovTracker, EFT wiki): cache-first with TTLs, conditional 304s, a persisted quota ledger, retry/backoff, and a live status surface.
- **Platform** — ships as a single installable Windows app (Electron): one launch spawns the service, agent, and UI behind a tray icon; patch-drift sentinel; structured for auto-update.

The UI is organized **verb-first** — *Operate* (Tonight's Plan · This Raid · Quartermaster), *Understand* (Goals & Foresight · Debrief), *Ask* (Copilot), *Environment* (Settings & Perf · Map · Sources & Connectors) — leading with what to do, not object lists.

## Quick start

**Toolchain:** Node ≥ 22 and **pnpm 10.34.5** (pinned via `packageManager` — pnpm 11.x currently deadlocks resolving `electron-builder`; do not upgrade until fixed upstream).

### Run from source (development)

```bash
pnpm install
pnpm build:web                      # build the UI once
pnpm service                        # daemon on http://localhost:3141 (REST + WS + UI)
pnpm agent                          # AI copilot on :3142 (rides your Claude Code login, or ANTHROPIC_API_KEY)
```

Open `http://localhost:3141`. Onboarding offers three ways to seed your state: a quick quiz, a **TarkovTracker token import**, or **backfill from logs** (reconstructs raids, quest events, and flea history from every session on disk). Take an in-game screenshot at any time to update your Map position (the T1 channel).

To connect your live progress, paste a TarkovTracker API token (from your [TarkovTracker settings](https://tarkovtracker.org)) into onboarding or `POST /api/state/import/tarkovtracker`. Progress syncs **in**; nothing is written back.

### Build the desktop app

```bash
pnpm app:dist                       # builds the web UI + an NSIS .exe installer under apps/desktop/dist
```

The installer bundles the service, agent, a Node 26 runtime, the web UI, and read-only game data into one tray app. (MSI packaging and auto-update are structured but deferred; a personal build ships unsigned — expect a Windows SmartScreen prompt.)

## Architecture (monorepo)

TypeScript end-to-end, strict mode, pnpm workspaces. Cross-package interfaces are pinned in [docs/spec/CONTRACTS.md](docs/spec/CONTRACTS.md) (the binding contract — where a spec and CONTRACTS disagree, CONTRACTS wins).

| Workspace | What it is |
|---|---|
| [`packages/shared`](packages/shared) | shared types, zod schemas, and the provenance/health primitives |
| [`packages/data-core`](packages/data-core) | world model: per-patch json.tarkov.dev snapshots, task graph (510 / 257κ / 102 LK invariants), wiki parser, market loaders, curated + wiki-verified story dataset |
| [`packages/planner`](packages/planner) | **the moat**: Raid Director, XP/level simulator, Foresight Guard, Quartermaster |
| [`packages/state-engine`](packages/state-engine) | player model: SQLite store, log watcher/parsers, historical backfill, screenshot positions, XP estimator, TarkovTracker mirror, raid journal |
| [`packages/environment`](packages/environment) | EFT settings advisor (apply only game-closed, with backups), NVIDIA detection, PresentMon ingest + regression alerts, ammo tiers |
| [`packages/insights`](packages/insights) | raid analytics, economy/net-worth curves + goal-ETA, config↔outcome attribution, highlight index, playstyle fingerprint |
| [`packages/connectors`](packages/connectors) | capability-first local-tool adapters (EFT config, Wootility, NVIDIA, SteelSeries Sonar, manual capture); registry + resolver + provenance envelope; T0/T1 only, opt-in reversible writes |
| [`packages/sources`](packages/sources) | disciplined remote-data client: registry, TTL/ETag cache, quota ledger, retry/backoff, status surface (tarkov.dev JSON, TarkovTracker, EFT wiki) |
| [`apps/service`](apps/service) | Fastify daemon: REST + WS ([CONTRACTS §5](docs/spec/CONTRACTS.md)), watcher host, patch sentinel, serves the UI |
| [`apps/web`](apps/web) | React/Vite UI (verb-first IA; dark, second-monitor glanceable) |
| [`apps/agent`](apps/agent) | Claude copilot: grounded tools, NL goals, briefings, replan pipeline, learned-weights proposer |
| [`apps/monitor`](apps/monitor) | a TarkovMonitor-style live companion that is a pure consumer of the service `/ws` stream (voice/chime alerts, in-raid timers) |
| [`apps/desktop`](apps/desktop) | Electron shell: single installable Windows app that spawns the service/agent as sidecars |

`pnpm test` runs the full suite (many tests replay sanitized excerpts of real session logs); `pnpm typecheck` type-checks every workspace. Specs live in [SPEC.md](SPEC.md) (the contract), [docs/spec/](docs/spec/) (per-unit), and [docs/research/](docs/research/) (the live-verified evidence base). Higher-level intent: [VISION.md](VISION.md) (why) · [NORTH-STAR.md](NORTH-STAR.md) (how we decide) · [docs/DESIGN.md](docs/DESIGN.md) (architecture).

## License, data & attribution

- **Code:** [GPL-3.0-only](LICENSE) — the same license family as [tarkovtracker-org](https://github.com/tarkovtracker-org/TarkovTracker) and [TarkovMonitor](https://github.com/the-hideout/TarkovMonitor). All code here is original; patterns were studied and referenced, nothing was copied.
- **Story / chapter dataset** (`data/story/story.json`): derived from the [EFT Fandom wiki](https://escapefromtarkov.fandom.com) and licensed **CC BY-NC-SA 3.0** (non-commercial, ShareAlike — separate from the code license; per-page sources recorded inside the file).
- **Game data:** [tarkov.dev](https://tarkov.dev) (json.tarkov.dev snapshots, committed per patch — the API is free; consider [supporting them](https://opencollective.com/tarkov-dev)). Progress data flows from [TarkovTracker](https://tarkovtracker.org).
- **Design system:** the UI's design tokens (`apps/web/src/design-system/`) are adapted from the **TarkovTracker Design System** and carry its dark tan-on-gunmetal, PvP/PvE-accented visual language.
- **AI backend:** the copilot's model layer is pluggable; the optional `@anthropic-ai/claude-agent-sdk` dependency is proprietary to Anthropic — users bring their own Claude login or API key.

Your personal state stays in `data/local/` (gitignored) and never leaves the machine.
