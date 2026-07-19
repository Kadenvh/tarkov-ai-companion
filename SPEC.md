# SPEC — Tarkov AI Companion
### v1.1 · 2026-07-16 · the build contract

> Governs spec-driven development. [VISION.md](VISION.md) says why; [NORTH-STAR.md](NORTH-STAR.md) says how we decide; this says **what, exactly**. Architecture deep-dive: [docs/DESIGN.md](docs/DESIGN.md). Evidence: [docs/research/](docs/research/) (all claims live-verified 2026-07-11).
>
> **v1.1 (2026-07-16):** "The Coach" reframe; new modules **M9 Connectors** ([SPEC-8](docs/spec/SPEC-8.md)), **M10 Sources** ([SPEC-10](docs/spec/SPEC-10.md)), **M11 Desktop app shell** ([SPEC-9](docs/spec/SPEC-9.md)); new phase **P6 Coach & Distribution**. Toolchain pinned to **pnpm 10.34.5** (11.x deadlocks resolving electron-builder — do not upgrade until fixed upstream).

---

## 0. Stack & repo decision record

- **Language:** TypeScript end-to-end (strict mode).
- **Monorepo:** pnpm workspaces.
  ```
  tarkov-ai-companion/
  ├─ packages/
  │  ├─ data-core/      # M1 — ingestion, snapshots, wiki parser, story dataset, ID registry
  │  ├─ state-engine/   # M2 — SQLite store, watchers, estimators, mirrors
  │  ├─ planner/        # M3 — solver, XP sim, foresight, quartermaster
  │  ├─ environment/    # M6 — EFT settings advisor, NVIDIA, PresentMon, ammo tiers
  │  ├─ insights/       # M7 — raid analytics, economy, playstyle fingerprint
  │  ├─ connectors/     # M9 — capability-first local-tool adapters (SPEC-8)
  │  ├─ sources/        # M10 — remote-source monitoring: cache/quota/status (SPEC-10)
  │  └─ shared/         # types, zod schemas, utilities
  ├─ apps/
  │  ├─ service/        # Fastify daemon: watchers host, REST+WS API, agent endpoint
  │  ├─ web/            # React/Vite UI (served by service; second-monitor first)
  │  ├─ agent/          # M4 — Claude copilot service (Agent SDK)
  │  ├─ monitor/        # TarkovMonitor-style live WS consumer (T0)
  │  └─ desktop/        # M11 — Electron shell: single installable app (SPEC-9)
  ├─ data/
  │  ├─ snapshots/      # per-patch json.tarkov.dev pulls (committed)
  │  ├─ story/          # curated chapters/endings/decisions (committed, versioned)
  │  └─ overlay/        # manual corrections layered over upstream data
  └─ docs/
  ```
- **Key deps:** **`node:sqlite`** (Node 26 builtin — supersedes better-sqlite3; see [CONTRACTS §2](docs/spec/CONTRACTS.md)), zod, fastify (+ @fastify/websocket), react, vite, vitest, @anthropic-ai/claude-agent-sdk (agent), chokidar (FS events) + polling tails (logs), electron + electron-builder (desktop shell, M11).
- **Package manager:** pnpm **10.34.5**, pinned via `packageManager` (11.x deadlocks resolving electron-builder — do not upgrade until fixed upstream).
- **Repo rename:** working dir stays `tarkov-aim-lab` until scaffold; scaffold under this repo root, rename repo to `tarkov-ai-companion` at first commit.

## 1. Risk-tier policy (governs every feature; see research/03)

| Tier | Definition | Policy | Examples |
|---|---|---|---|
| **T0 — Outside game** | Never touches EFT files/process/screen | Unrestricted | tarkov.dev/wiki ingestion, solver, UI, NVIDIA driver profiles, ETW frame telemetry (PresentMon-class), auto-update |
| **T1 — Passive read of game-written files** | Read-only; files EFT itself writes | Default-on; proven class (TarkovMonitor, 4+ yrs, zero bans) | Log tailing, screenshot-filename position, reading Settings/*.ini, registry install detection |
| **T2 — User-initiated capture** | Screen capture/OCR triggered by explicit user action | Default-on with disclosure; proven class (RatScanner, 5+ yrs) | Hotkey OCR of hideout/stash/level screens; settings-screen capture |
| **T3 — Continuous/automated capture** | Ongoing screen vision without per-event user action | **PARKED indefinitely** (decision 2026-07-11): perf cost on a CPU-bound game + BattlEye optics not worth it. Spawn-frame vision explicitly rejected — spawn-aware features ride the T1 screenshot-position channel instead | Auto spawn recognition via vision model, continuous position estimation |
| **T4 — Forbidden against live servers** | Anything inside the game's process/memory/net/input on the LIVE game | **Never in this product, on any account.** | Memory reads, DLL/process injection, packet interception, input automation, game-file modification, reading BattlEye's own data |

Additional rules: writes to EFT `Settings\*.ini` only while game is **closed**, only values the in-game UI itself exposes, with automatic backup/restore (classified T1-write; player-normal behavior, still disclosed). In-raid-informative features are always tied to the player's own action (their screenshot keybind).

**OCR scope rule (2026-07-11):** T2 capture targets **out-of-raid surfaces only** — stash, hideout, character, trader, settings screens — where the game idles in menus (CPU headroom) and the surface is the RatScanner-proven class. No in-raid capture of any kind beyond the player's own screenshot keybind.

**BattlEye posture (why we won't get flagged):** we are a plain user-mode application that reads files the game writes. We never inject, hook, load DLLs into, read memory of, send input to, draw over, or otherwise interact with the game process or window — so there is no "unknown process interacting with the game" for kernel AC to flag. UI lives in its own window (second monitor). The known BattlEye failure mode for legit tools is soft-block/kick of processes that touch the game window (TarkovRPC precedent) — our architecture never crosses that line, matching the profile of tools with multi-year zero-ban records (TarkovMonitor, TarkovPilot). Performance budget: watcher idle CPU < 1%, no polling faster than 1 s, zero GPU use while the game runs.

### Why injection / memory-reading / anti-cheat-data access stays forbidden (decision, 2026-07-11)

This was raised as a reversal request. It is not reverted, and the reasoning is deliberately recorded here because it is the single most consequential architecture decision in the project.

1. **It is the definition of a bannable offense.** EFT runs BattlEye, a kernel-mode anti-cheat whose entire job is to detect processes that read the game's memory, inject code, or touch its process — because that is exactly what ESP/radar/aimbot cheats do. BattlEye cannot distinguish "benign companion reading memory" from "cheat reading memory"; it detects the *mechanism*, not the intent. Read-only `ReadProcessMemory` against EscapeFromTarkov.exe is detected and banned the same as a full cheat.
2. **It directly contradicts the owner's #1 requirement.** The stated non-negotiable, repeated across every planning session, is "never get my main account banned." Building injection into a product that logs into the main account guarantees the outcome it exists to prevent — typically a permanent account **and hardware (HWID)** ban, non-appealable.
3. **There is no whitelist for it.** BSG operates no partner/approval/registration program that would sanction third-party memory access to the live client. "Get our tool whitelisted so injection is safe" is not an available path — the safe path is to not touch the process at all (see the de-facto-safe tools above).
4. **Reading BattlEye's own data is worse, not a shortcut.** Accessing the anti-cheat's files/memory/telemetry is itself tampering with the anti-cheat — the fastest possible route to a ban, not a "performance optimization."
5. **Against live servers it also harms other players.** Any in-raid information advantage derived from memory in a live PvP raid is cheating against real opponents, independent of the ban question.

**What "maximum access and control" actually means here, and it is a lot:** total control over the *environment and data* around the game — every on-disk config (read/write, game closed), the full log event stream, screenshots, the entire Windows/NVIDIA/telemetry surface, and the tarkov.dev + TarkovTracker + wiki data planes. EFT stores an unusual amount in plain JSON on disk (see [docs/research/06-environment-paths.md](docs/research/06-environment-paths.md)), so the legitimate surface is far larger than for most games. We take all of it. We just never take the one thing that trades the main account for it.

**The only non-bannable context for memory-structure exploration** is fully offline / single-player (SPT-style), against no live server and no real opponents. That is a separate research sandbox, out of scope for this product, and nothing learned there is wired into anything that connects to live servers on any account (main or the spare).

## 2. Module registry

### M1 — Data Core `packages/data-core`
The world model. **Everything downstream keys on tarkov.dev 24-hex IDs.**

| Req | Requirement | Acceptance |
|---|---|---|
| M1.1 | Ingest `json.tarkov.dev` `/{regular,pve}/{tasks,items,maps,hideout,barters,crafts,traders}` into typed, zod-validated models | Full pull < 60 s; validation failures reported, not fatal |
| M1.2 | **Snapshot per patch** into `data/snapshots/<version>/`; diff report between any two snapshots | 1.0.6 snapshot committed before any other work; `diff` CLI names added/removed/changed tasks |
| M1.3 | **Wiki ingestion** via MediaWiki API (`action=parse&prop=wikitext`): parse `Infobox quest` (given by, previous, leads to, reqkappa, location, requirements) + Objectives/Rewards sections (incl. Intel-Center-scaled rewards wiki-only data); polite rate limiting + on-disk cache; CC BY-NC-SA 3.0 attribution (non-commercial) | Parses ≥95% of quest pages without manual fixes; per-page parse fallback logs, never crashes |
| M1.4 | **Cross-validation:** wiki ⟷ tarkov.dev diff (prereqs, kappa flags, trader) → drift report | Known-good on 1.0.6: discrepancy list reviewed & triaged into `data/overlay/` |
| M1.5 | Curated **story dataset** `data/story/*.json`: 10 chapters, stages, 4 endings, decision points w/ consequences, chapter↔trader-task links; seeded from wiki + prior `auto-tracker/tarkov-story-tracker.tsx` | Schema-validated; every decision has `locks[]`/`unlocks[]` ending effects |
| M1.6 | Graph builder: task DAG w/ gates (level, trader LL, prereq status incl. `failed`, faction, prestige, keys) + failCondition exclusivity sets | **Invariant tests: 510 tasks, 257 kappa, 102 lightkeeper**, known branch triads resolve |

### M2 — State Engine `packages/state-engine`
The player model. Local-first, per profile (PvP/PvE × account).

| Req | Requirement | Acceptance |
|---|---|---|
| M2.1 | SQLite store, TarkovTracker-shaped: `{taskId: {complete, failed, timestamp}}`, objective counts, hideout, traders {level, rep}, level + xpOffset, prestige, **progressEpoch** | Round-trips a full TarkovTracker `GET /progress` import losslessly |
| M2.2 | **Log watcher** (T1): session-folder discovery (registry → `<install>\Logs`), polling tail w/ `FileShare.ReadWrite` semantics + byte-offset resume; parse quest events (types 10/11/12), raid lifecycle (`UserMatchCreated`/`UserConfirmed`/`GameStarting`/`GameStarted`/`UserMatchOver`), map, mode, profile, flea sales, group events | Replays my real 2026-05-25 session logs correctly (Factory raid detected end-to-end); quest transition applied < 5 s from log write |
| M2.3 | **Historical backfill**: scan all log folders with (profileId, version) breakpoints | Reconstructs task state from available history in one command |
| M2.4 | **Screenshot watcher** (T1): position+quaternion from filename; folder-creation re-arm (folder doesn't exist yet on this machine) | Emits position events paired with current map |
| M2.5 | **XP estimator**: task XP (data) + raid-outcome heuristics + manual calibration points; confidence interval surfaced | Level estimate within ±1 level after calibration in test scenarios |
| M2.6 | Manual + OCR-assisted capture (T2) for log-invisible state: hideout levels, trader rep, exact level | Hideout state updatable in < 60 s of user effort |
| M2.7 | **TarkovTracker mirror** (optional): token import seed; debounced batched writes; epoch guards vs prestige resets; tolerate 401/outage/cascade divergence (reconcile via re-read) | Sync round-trip verified against a real .org account; zero data loss when API is down |
| M2.8 | Raid journal: every raid (map, mode, duration, queue, outcome inference) persisted → feeds M7 insights | Journal row per raid in replay tests |

### M3 — Planner `packages/planner`
The moat. Deterministic, testable, explainable.

| Req | Requirement | Acceptance |
|---|---|---|
| M3.1 | Goal model: any subset of {Kappa, ending E, Lightkeeper, hideout targets, level N, custom task sets} | Goals compose without conflict; infeasible goals explained |
| M3.2 | **Raid Director**: rolling ~5-raid horizon; each raid = (map, task batch, prep list); greedy + lookahead scored on tasks-closed + XP + unlock-criticality per expected hour; user weights (map preference/aversion, session length, risk) | Given a mid-game fixture profile, produces batches a strong player judges sane; **replan < 2 s** |
| M3.3 | **XP/level simulator** along the plan; gate-stall detection (Collector@45, flea 25/30/35/40, trader LLs) | Correctly predicts stall in a constructed stall fixture |
| M3.4 | **Foresight Guard**: warnings from failConditions exclusivity + story decision graph; blocking confirmations on irreversible choices | Every mutually-exclusive branch + every story decision emits a warning with consequence text |
| M3.5 | **Quartermaster**: per-item cheapest acquisition (flea @ level-gate vs trader vs barter vs craft) with task-unlock awareness; craft-timer schedule; FIR-needs routed to planned raids w/ coordinates | Shopping list for next-N-raids with total cost; craft starts scheduled against plan timeline |
| M3.6 | Explainability: every recommendation carries machine-readable reasons | UI/agent can render "why" for any line item |

### M4 — AI Copilot `apps/agent`
Claude over ground truth. Grounded, never guessing.

| Req | Requirement | Acceptance |
|---|---|---|
| M4.1 | Tool-armed agent (Agent SDK): tools = state queries, solver calls, data lookups, wiki citations | Agent answers cite state/data; zero unsourced game facts in eval set |
| M4.2 | NL goal intake → M3.1 goal model ("Kappa + Savior before prestige, hate Lighthouse") | Round-trips to correct goal + weights config |
| M4.3 | **Per-raid briefing**: map, batch order, keys/items to bring, decision warnings | Briefing < 200 words, generated < 10 s, factually consistent with plan |
| M4.4 | **Event-driven replan**: raid-end log event → replan → notify (UI toast; optional n8n → Discord/phone) | Fires end-to-end on replayed logs |
| M4.5 | **Learned weights**: adjust user weight vector from raid journal outcomes (accepted/completed/abandoned batches) | Weights drift toward observed behavior in simulation; always user-inspectable/overridable |

### M5 — Surfaces `apps/web` + `apps/service`
| Req | Requirement | Acceptance |
|---|---|---|
| M5.1 | Service daemon: hosts watchers, REST+WS API, serves web | Survives sleep/wake + game restarts; auto-starts option |
| M5.2 | **Tonight's Plan** view (raid cards: batch, prep, warnings) | Primary screen usable at second-monitor glance distance |
| M5.3 | Goals dashboard: Kappa %, story/ending tracker (port tsx artifact), LK, hideout | Story tracker feature-parity with prior artifact v2 |
| M5.4 | Quartermaster view (buy/barter/craft/FIR w/ prices) | One-screen pre-session shopping run |
| M5.5 | Map view: live position (screenshot events) on tarkov.dev-style map; **spawn-aware route overlay** for tonight's batch (v1: waypoint straight-line/hand-authored graphs; navmesh = open question) | Position marker < 2 s after screenshot; route renders for batch objectives |
| M5.6 | Between-raid cost instrumented (NSM counter-metric) | Time-in-app metric visible to us |

### M6 — Environment & Meta (expanded scope)
| Req | Requirement | Tier | Acceptance |
|---|---|---|---|
| M6.1 | Settings advisor: read current `Settings\*.ini` + in-log settings dump; recommend vs curated meta profiles (sourced/updated from community metas); one-click apply **game-closed** w/ backup | T1/T1-write | Apply→launch→verify loop leaves game identical to hand-set |
| M6.2 | NVIDIA optimization: per-game driver profile (DRS) recommendations + apply; Reflex/DLSS guidance | T0 | Profile applied & verified via nvidia-smi/NVAPI query |
| M6.3 | **Performance monitor**: frame telemetry (PresentMon-class ETW), per map/settings/patch; regression alerts | T0 | FPS percentiles per raid stored in journal; patch regression flagged |
| M6.4 | Trending-meta feeds: ammo tiers, loadout metas (tarkov.dev data + curated sources) surfaced in briefings | T0 | Ammo recommendations match current-patch data |

### M7 — Personal Insights
| Req | Requirement | Acceptance |
|---|---|---|
| M7.1 | Raid analytics: survival by map/time-of-day/duration; queue-time patterns; session rhythm | Dashboards over ≥30 journaled raids |
| M7.2 | Economy tracking: flea sales (logs) + snapshot-based net-worth estimates | Weekly net-worth curve |
| M7.3 | Playstyle fingerprint feeding M4.5 weights | Documented feature vector, inspectable |

### M8 — Platform
| Req | Requirement | Acceptance |
|---|---|---|
| M8.1 | **Auto-update**: app self-update channel + data refresh cadence (prices 5-min-aligned; static on patch detect via version-in-log-path change) | New EFT version detected from log folder name → snapshot+diff prompted automatically |
| M8.2 | Patch-drift sentinel: on new patch, run M1.4 wiki⟷API cross-validation + failing-invariant report | **Kord Breach readiness**: reshuffle surfaces as reviewable diff, not silent breakage |
| M8.3 | Config, secrets (tokens), profiles (main + second account slot), logging | Fresh-machine setup < 10 min |

### M9 — Connectors `packages/connectors` (SPEC-8)
Capability-first pluggable adapters for the user's *local* tools; T0/T1 only (registration refuses > T1). The plugin seam for H3.
| Req | Requirement | Acceptance |
|---|---|---|
| M9.1 | Registry + capability resolver + provenance envelope | ✅ built (32 tests) |
| M9.2 | First-party connectors: `eft-config` (game-config), tracker read | ✅ eft-config built |
| M9.3 | Vendor adapters: Wootility (keyboard-actuation), SteelSeries Sonar (audio-mix), NVIDIA (gpu-3d-profile/perf-telemetry) | 🚧 Wootility built; Sonar/NVIDIA open |
| M9.4 | Assisted-capture fallback (manual-capture) | ✅ built |
| M9.5 | Orchestration writes — opt-in, reversible, backup-first (unblocks M6.2 DRS write) | ⏳ open |
| M9.6 | Plugin seam: out-of-tree connector loader (H3) | ⏳ open |

### M10 — Sources `packages/sources` (SPEC-10)
Efficient monitoring of *remote* data sources; sibling to M9. Cache + quota ledger + retry + status. **TarkovTracker read-pivot** (TM→TT is the live state source; we read, not write).
| Req | Requirement | Acceptance |
|---|---|---|
| M10.1 | Registry + TTL/ETag cache + quota ledger + retry/backoff | 🚧 building |
| M10.2 | First sources: tarkov-dev JSON (game-data/prices), TarkovTracker read (progress-read, GP) | 🚧 building |
| M10.3 | Status surface: `/api/sources/status` + `source.status` WS + UI view | ⏳ open |
| M10.4 | EFT wiki (MediaWiki, story) + tarkov.dev manager submit (opt-in, off) | ⏳ open |

### M11 — Desktop App Shell `apps/desktop` (SPEC-9)
Single installable Windows app (Electron): main spawns service+agent sidecars on bundled Node 26, renderer = the service's web UI.
| Req | Requirement | Acceptance |
|---|---|---|
| M11.1 | Shell + sidecar lifecycle (health-gate, tray, single-instance, clean shutdown) | ✅ built (32 tests; bundled service boots to /api/health) |
| M11.2 | Installer: `pnpm --filter @tac/desktop dist` → NSIS `.exe` (137MB, signed) | ✅ built (MSI deferred — WiX needs .ico + author) |
| M11.3 | Auto-update channel (electron-updater; ties to M8.1) | ⏳ deferred |

## 3. Phase mapping (build order)

| Phase | Modules | Exit criterion | Status |
|---|---|---|---|
| **P0 Foundation** | M1 complete; M8.2 skeleton | Invariants green on 1.0.6 snapshot; story dataset v1; wiki pipeline parsing | ✅ 2026-07-11 |
| **P1 Planner MVP** | M3.1–M3.4; M5.1–M5.3 (seed state via M2.1 import/quiz) | **"Tonight's Plan" drives a real session** | ✅ 2026-07-11 (built + verified live; first real session pending) |
| **P2 Auto-state** | M2.2–M2.8; M3.5; M5.4 | State freshness ≥ 90% automatic | ✅ 2026-07-11 (58 real sessions backfilled: 118 raids / 115 quest events / 119 flea sales) |
| **P3 Copilot** | M4.1–M4.4 | Raid-end → replan → briefing loop live | ✅ 2026-07-11 (live grounded briefing verified over agent-sdk) |
| **P4 Environment** | M6, M7, M4.5, M5.5 | Settings/NVIDIA/perf + insights daily-driver | ✅ 2026-07-11 (M6.2 DRS *writes* deferred, recorded in SPEC-4) |
| **P5 Edge** | T3 experiments (spawn vision — only after ToS re-validation), squad, seasonal, map route overlay, wiki⟷API drift automation (M1.4), snapshot `diff` CLI (M1.2) | Feature-flagged, individually approved | ⏳ open |
| **P6 Coach & Distribution** | M9 connectors, M10 sources, M11 desktop shell/installer, "The Coach" data streams, UI elevation | Single installable app + efficient source layer + proactive coaching | 🚧 in progress (2026-07-16) |

## 4. Open questions (tracked, non-blocking)

1. **Pathing data**: no public navmesh. Options: hand-authored waypoint graphs per map (start with your main maps), walkable-mask extraction from map tiles, or community data. Decide in P4/M5.5.
2. ~~**Spawn recognition** (T3)~~ **RESOLVED 2026-07-11: parked.** Spawn-aware routing uses the first in-raid screenshot (T1) + tarkov.dev spawn-point matching. No vision models near the running game.
3. **Second account** use: safe testbed for watcher/backfill QA and fresh-profile fixtures (T4 rules still absolute). Never for anything BSG could read as account misuse.
4. Collector 41 vs 43 items / kappa 257 vs 261 — resolve during M1.4 cross-validation.
5. Kord Breach seasonal profiles — schema slot exists (M2.1 per-profile); build when season mechanics are observable.
6. n8n vs built-in notifier for M4.4 push — decide at P3.

## 5. Definition of done (per feature)

Typed + zod-validated boundaries · vitest coverage on logic (solver/parsers ≥ 80%) · risk tier declared in code (`@tier` annotation) · explainability payload present (M3/M4 features) · works against replayed real logs where applicable · documented in module README.
