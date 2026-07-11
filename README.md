# Tarkov AI Companion

**An agentic progression copilot for Escape from Tarkov** — it reconstructs your player state from the game's own logs, runs a real optimizer over the full 510-task graph, and puts a grounded Claude copilot on top that briefs, warns, and replans raid by raid.

Nobody else answers *"what should I do next?"* — every existing tool answers "what exists" (tarkov.dev), "what have I done" (TarkovTracker), or "what is it worth" (RatScanner). This does: per-raid task **batching**, XP/level **simulation**, irreversibility **foresight** (fail-chains + story endings), plan-tied **acquisition**, and event-driven **replanning**.

> **Hard safety line (never crossed):** this suite never touches the game process, memory, network traffic, or input — it only reads files EFT itself writes (logs, screenshots, settings), the same T1 risk class as TarkovMonitor/RatScanner (multi-year, zero-ban track record). Full policy: [SPEC.md §1](SPEC.md). BattlEye sees a plain user-mode app that never interacts with the game window.

## Quick start

```bash
pnpm install
pnpm --filter @tac/web build      # build the UI once
pnpm --filter @tac/service start  # daemon on http://localhost:3141 (REST + WS + UI)
pnpm --filter @tac/agent start    # AI copilot on :3142 (rides Claude Code auth)
```

Open `http://localhost:3141` → onboarding offers: quiz, TarkovTracker import, or **"backfill from logs"** (reconstructs raids/quests/flea history from every session on disk). Take an in-game screenshot any time to update the Map position (T1 channel).

## Monorepo

| Workspace | What it is |
|---|---|
| [`packages/data-core`](packages/data-core) | world model: per-patch snapshots of json.tarkov.dev, task graph (510/257κ/102LK invariants), wiki parser, market loaders, curated + wiki-verified story dataset |
| [`packages/planner`](packages/planner) | **the moat**: Raid Director (greedy+criticality batch solver), XP/level sim, Foresight Guard, Quartermaster (cheapest-route acquisition + craft scheduling) |
| [`packages/state-engine`](packages/state-engine) | player model: SQLite store, log watcher/parsers (raids, quests, flea), historical backfill, screenshot positions, XP estimator, TarkovTracker mirror, raid journal |
| [`packages/environment`](packages/environment) | EFT settings advisor (apply only game-closed, with backups), NVIDIA detection, PresentMon ingest + regression alerts, ammo tiers |
| [`packages/insights`](packages/insights) | raid analytics, economy curves, playstyle fingerprint |
| [`apps/service`](apps/service) | Fastify daemon: REST + WS ([CONTRACTS](docs/spec/CONTRACTS.md) §5), watcher host, patch sentinel, serves the UI |
| [`apps/web`](apps/web) | React UI: Tonight's Plan, Goals + story/ending tracker, Quartermaster, Insights, Environment, Map |
| [`apps/agent`](apps/agent) | Claude copilot: grounded tools (zero unsourced game facts), NL goal intake, <200-word briefings, raid-end→replan→notify pipeline, learned-weights proposer |

`pnpm -r test` — 350+ tests, many against sanitized excerpts of real session logs. Specs: [SPEC.md](SPEC.md) (contract) + [docs/spec/](docs/spec/) (per-phase) + [docs/research/](docs/research/) (verified evidence).

## Data & attribution

Game data: [tarkov.dev](https://tarkov.dev) (json.tarkov.dev snapshots, committed per patch). Story/chapter data derived from the [EFT Fandom wiki](https://escapefromtarkov.fandom.com) (CC-BY-SA 3.0), machine-verified 2026-07-11. Local state stays in `data/local/` (gitignored, never leaves the machine).

---

*Legacy note: this repo previously hosted an aim-analysis prototype (`analyze.py`, `src/`, `notebooks/`, `config.yaml`, `requirements.txt` — Python). Those files are unrelated to the companion suite and kept only for reference; the repo is due a rename to `tarkov-ai-companion`.*
