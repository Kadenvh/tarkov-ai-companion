# @tac/web — Tarkov AI Companion UI

React 19 + Vite 7 web app (CONTRACTS §6, SPEC.md M5.2–M5.5). Dark, high-contrast,
sized for second-monitor glance distance — the raid cards on Tonight's Plan are the
primary surface during a session.

**Tier: T0.** The web app never touches the game, its files, or its process. It talks
only to the local service (`apps/service`, port 3141) over HTTP + WebSocket.

## Views

| View | What it shows |
|---|---|
| **Tonight's Plan** (default) | Raid cards (map, task batch + reasons, level before/after, red foresight warnings with consequence text, per-raid prep list from the quartermaster), free-tasks strip, level-stall strip, replan-freshness indicator. Live: `plan.updated` refetches, `raid.started/ended` banner. |
| **Goals** | Goal picker (Kappa / Lightkeeper / level N / custom tasks), map-aversion sliders (incl. the "Hate Lighthouse" preset) + horizon, Kappa/LK progress bars, pending foresight warnings, and the **story & ending tracker** (chapters, decision-point modals, ending probability grid — ported from the auto-tracker artifact). |
| **Quartermaster** | Acquisition table grouped by route (flea / trader / barter / craft / find-in-raid), totals header, craft schedule with start-by times, per-item "why" expander (reasons + alternatives). |
| **Insights** | Survival by map / hour / duration, session rhythm, flea-income sparkline (inline SVG), playstyle fingerprint with per-feature explanations. Small-n metrics carry a "low n" badge. |
| **Environment** | Settings diff vs curated profiles + apply button (409 "game running" handled inline — nothing is written while the game runs), NVIDIA advisor card, per-map FPS percentiles + regression badges, ammo tier lookup by caliber. |
| **Map** | Latest position + history from the T1 screenshot channel, tarkov.dev deep links per map. Empty state explains the screenshot keybind. |

An onboarding modal appears for untouched profiles (level 1, nothing completed):
quiz → `POST /api/state/manual`, TarkovTracker token import, and a historical log
backfill with a result summary.

## Run

```sh
pnpm --filter @tac/web dev        # vite on 5173, proxies /api + /ws → localhost:3141
pnpm --filter @tac/web build      # production build → dist/ (served by the service at /)
pnpm --filter @tac/web test       # vitest (pure-logic unit tests, node env)
pnpm --filter @tac/web typecheck
```

Start `apps/service` first for live data; without it every view renders a
well-formed empty state (verified — the UI must never crash on a dead daemon).

**Windows auto-start:** the web app has no process of its own — it is static files
served by the service. Auto-starting the *service* (see `apps/service/README.md`,
Task Scheduler / `shell:startup`) makes the UI available at `http://localhost:3141`
on boot; keep a pinned browser tab on the second monitor.

## Architecture notes

- **Standalone build:** no workspace imports. API/WS response types are declared
  locally in `src/api/types.ts` from CONTRACTS §3/§5/§7; service-defined shapes are
  read through tolerant normalizers (`src/lib/normalize.ts`) that degrade to empty
  results instead of crashing on shape drift.
- **Pure logic is separated from React** and unit-tested in `test/`:
  `api/client.ts` (typed fetch + error mapping), `api/frames.ts` (WS frame router),
  `lib/planView.ts` (raid-card view-model incl. warning/prep merging),
  `lib/quartermasterView.ts` (grouping/totals/why-lines), `lib/story.ts`
  (chapter progress, ending outlook, decision warnings), `lib/maps.ts` (map key
  resolution + tarkov.dev deep links).
- **State:** one React context (`src/store.tsx`) over `useState` — no redux. Owns the
  API client, the reconnecting WS hook, cached responses, toasts, and client-local
  story progress (localStorage per profile until the service persists it).
- **No component libraries, no tailwind, no chart libs** — one plain stylesheet,
  inline SVG sparkline. Production bundle ≈ 80 kB gzip.

## Tests

`test/` — 69 vitest cases over the pure modules (client URL/error mapping, WS frame
routing, plan view-model, story ending-compatibility predictions at artifact parity,
quartermaster grouping/totals, normalizers, map registry, formatting). Node
environment; no jsdom, no network, no game files.
