# TarkovTracker as Progress State Store — Research (2026-07-11)

## Executive summary

The TarkovTracker ecosystem **split in two**. The original (`TarkovTracker/TarkovTracker`, Vue 2/Firebase, **tarkovtracker.io**) is stale — last release Dec 2023, last push Feb 2025, frozen pre-1.0 (site still online). The community successor org **tarkovtracker-org** rebuilt it (Nuxt 4 + Supabase + Cloudflare, GPLv3) at **tarkovtracker.org** and it is extremely active: **v1.55.6 released 2026-07-11 (today)**, 165 releases, ~1,250 commits. Fully 1.0-native: storyline chapters, endings, prestige 1–6, PvP/PvE dual modes, versioned public API (v2.1.0, OpenAPI 3.1). The ecosystem (TarkovMonitor, RatScanner, tarkov.dev) has re-pointed to it.

**Recommendation: own state locally; treat TarkovTracker as an optional sync mirror.**

## 1. API (gateway v2.1.0)

- **Base URL:** `https://api.tarkovtracker.org` (clean paths; `/api/v2/*` accepted). Legacy `tarkovtracker.org/api/v2/*` will 308-redirect — most HTTP stacks **drop the Authorization header on cross-host redirects → 401**; target the subdomain directly.
- **Docs:** Scalar UI at https://api.tarkovtracker.org/ ; spec at `/openapi.json` (verified live, OpenAPI 3.1, v2.1.0). Internal app API: `docs/API.md` in repo.
- **Auth:** `Authorization: Bearer <token>`; tokens from https://tarkovtracker.org/settings. Prefixes `PVP_` / `PVE_` (legacy `tt_`) — **each token bound to one game mode**. SHA-256-hashed server-side, expirable, permissions array.
- **Scopes:** `GP` progress read, `TP` team read, `WP` progress write.

| Method/Path | Scope | Notes |
|---|---|---|
| `GET /token` | GP | Token metadata |
| `GET /progress` | GP | `tasksProgress[]`, `taskObjectivesProgress[]` (with `count`), `hideoutModulesProgress[]`, `hideoutPartsProgress[]` (with `count`), `playerLevel`, `gameEdition`, `pmcFaction`, `displayName` |
| `GET /team/progress` | TP | Member array + `hiddenTeammates` (RatScanner-shaped) |
| `POST /progress/level/{1-79}` | WP | Set level |
| `POST /progress/task/{taskId}` | WP | `{state: completed\|uncompleted\|failed}`. **Server cascades**: unlocks/relocks dependents, auto-fails alternatives |
| `POST /progress/tasks` | WP | Batch (counts as ONE write vs quota) |
| `POST /progress/task/objective/{objectiveId}` | WP | `{state?, count?}` — partial counts supported |

**External tools CAN write task + objective-level progress (incl. counts).** Writes go through an atomic merge RPC (`merge_progress_data`) — concurrent writers don't clobber.

**NOT writable via public API:** hideout modules/parts (read-only!), trader levels/rep, skills, prestige level, storyline chapters, faction, any inventory/FIR store. The public API doesn't even RETURN storyline or prestigeLevel.

**Rate limits** (per account, shared across all the user's tools):

| Tier | Reads/day | Writes/day | Burst/min |
|---|---|---|---|
| Free | 1,000 | 100 | 30 |
| Paid tiers | 2,000–5,000 | 250–600 | 60–120 |

Daily reset 00:00 UTC; `X-RateLimit-*` + `Retry-After` headers. A wipe-to-Kappa run ≈ 400 task writes total.

## 2. Maintenance status

- **tarkovtracker-org/TarkovTracker**: commits merged the morning of 2026-07-11; near-daily releases; CI/Codecov/Crowdin. Storyline first-class: `storyline.vue`, `useStorylineChapters.ts` with chapter route choices, endings, optional objectives, map/trader unlocks; chapter art. Prestige 1–6 with per-level requirement checklists (tarkov.dev + community overlay + wiki fallback).
- **Original repo**: stale; `TarkovTrackerNext` rewrite also abandoned in old org. RatScanner and tarkov.dev still list .io as selectable legacy backend. Migration path imports from .io or .org profiles. tarkovtracker-org also maintains **forks of TarkovMonitor and RatScanner**.

## 3. Data model

- **IDs: canonical tarkov.dev IDs everywhere** (BSG Mongo-style 24-hex). Game data proxied from `json.tarkov.dev` + corrections from https://github.com/tarkovtracker-org/tarkov-data-overlay.
- **Storage:** Supabase `user_progress` row: `current_game_mode`, `game_edition`, JSON blobs `pvp_data`/`pve_data`: `level, pmcFaction, displayName, xpOffset, taskCompletions{id:{complete,failed,timestamp}}, taskObjectives{id:{complete,count,timestamp}}, hideoutModules, hideoutParts, traders{level,reputation}, skills, skillOffsets, prestigeLevel, lastApiUpdate` + storyline chapter progress.
- **Prestige:** modeled natively — `buildPrestigeResetData` wipes mode data, keeps displayName/faction, bumps `prestigeLevel` (max 6), increments **`progressEpoch`** to fence stale syncs. Completed runs archived as `PrestigeRunRecord`s. Per-prestige rules define which story chapters carry ("Tour", "Falling Skies", "Blue Fire", "They Are Already Here", "The Ticket").
- **Teams:** per-mode team IDs, Supabase Realtime, `GET /team/progress`.
- **Level:** per-mode 1–79 + `xpOffset` calibration.

## 4. Integrations

- **TarkovMonitor** (the-hideout, v1.11.1.0 Jun 2026): log-reader auto-sync; on quest turn-in POSTs task completion; batch endpoint for "Read Past Logs" backfill. **Does not write objective counts.** Token needs GP+WP. Per-EFT-profile token mapping (PvP/PvE separate).
- **tarkov.dev settings**: per-mode token fields + tracker domain dropdown (.org default). Polls `GET /progress`; consumes task status, objective counts, playerLevel, faction, hideout modules to filter quest/hideout views.
- **RatScanner** (v3.9.2): token → highlights items needed for your (and teammates') remaining quests/hideout. Backend switch .io/.org.
- Legacy .io integrations mostly work against .org because the gateway mirrors legacy v2 response shapes.

## 5. Alternatives (none have a write API)

TarkovBuddy (closed, no API), kappas.pages.dev, Tracking Tarkov, db4tarkov, tarkovkappa.com, TarkovAdvisor — checklist sites, no external APIs. tarkov.guru effectively defunct. Blitz.gg EFT = raid stats only. Mobalytics: no Tarkov. Overwolf Tarkov Companion: overlay tracker, own local state. **BSG official: no public progress API** (tarkov.dev/players scrapes an undocumented profile endpoint — level/stats/achievements only, no task state).

## 6. Architecture verdict: local-first, mirror outbound

1. **API coverage gaps kill it as primary store** — no writes (or reads!) for hideout, storyline, prestige, traders, skills, inventory. A log-reader pipeline observes events it can't persist there.
2. **Free-tier write quota (100/day, shared with TarkovMonitor)** is tight for objective-count streams; batch writes mitigate.
3. **Failure modes:** revocable/expirable mode-bound tokens (expect 401/403 anytime); community-run infra (assume outages; queue + retry with idempotent merges); URL churn history (.io→.org→api subdomain — pin `api.tarkovtracker.org`, validate `/openapi.json` in CI); **server-side cascades mutate other tasks** (replicate their GPL cascade rules from `progress.ts`, or re-read `GET /progress` after writes to reconcile); **prestige resets have no API signal** (detect via mass-uncompletion diffs; gate writes on local epoch); ID churn tolerated via `invalid` flag.
4. **What the mirror buys:** free manual-correction UI, team visibility, and interop — one token lights up tarkov.dev and RatScanner for the user. Model local store on their schema (tarkov.dev IDs, `{complete,failed,timestamp}` + counts + epoch) so sync is near-identity.

### Key URLs
- App: https://tarkovtracker.org · tokens: /settings
- API: https://api.tarkovtracker.org/ · spec: /openapi.json
- Source: https://github.com/tarkovtracker-org/TarkovTracker · overlay: tarkovtracker-org/tarkov-data-overlay
- Legacy: https://tarkovtracker.io · TarkovTracker/TarkovTracker
