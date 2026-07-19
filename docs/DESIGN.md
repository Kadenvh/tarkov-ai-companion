# Tarkov AI Companion — Architecture & Course of Action
### Design Document · v1.2 · 2026-07-16

> **Renamed:** product is now **tarkov-ai-companion** (was working-name "Sherpa"). This doc is the architecture deep-dive beneath the foundation trio: [VISION.md](../VISION.md) · [NORTH-STAR.md](../NORTH-STAR.md) · [SPEC.md](../SPEC.md) (the build contract — supersedes §6/§8 below where they differ).
> Full research backing this doc: [`docs/research/`](research/) (verified reports, live-checked 2026-07-11 / refreshed 2026-07-16).
>
> **v1.2 (2026-07-16):** product reframed as **"The Coach"** (proactive, not passive); three structural layers added — **Connectors (M9)**, **Sources (M10)**, **Desktop shell (M11)**. See §3.1. The five planes below still hold; §3.1 layers *front* and *package* them.

---

## 1. Thesis

Every Tarkov tool answers **"what exists?"** (tarkov.dev), **"what have I done?"** (TarkovTracker), or **"what is this worth?"** (RatScanner, tarkov-market). **Nobody answers "what should I do next?"** — and that's the only question a progression-driven player actually has.

The verified gap (see [gap analysis](research/04-competitive-gap-analysis.md)): every shipped "optimizer" is a filtered topological sort. No per-raid task batching, no XP/level simulation, no irreversibility foresight, no plan-tied acquisition lists, no adaptive replanning. The one AI product (tarkov.ai) is metered chat with zero grounding in player state. The data to build all of this exists, free, in one API. **The solver and the AI layer are simply unbuilt. We build them.**

Tarkov AI Companion = **a local-first companion service** that (a) passively reconstructs your player state from game logs, (b) runs a real optimizer over the full task/hideout/story graph, and (c) puts an AI copilot on top that briefs, explains, and replans — raid by raid.

## 2. Product pillars (the five unserved capabilities)

1. **Raid Director** — constraint optimization over the 510-task DAG producing *per-raid batches*: "Next 5 raids: Customs [Debut §3, Shootout Picnic, grab FIR Bronze pocket watch @ trailer x2 keys needed], Woods [...]". Objective = minimize raids/hours to goal-set, respecting level gates, trader LL, keys owned, FIR flags, faction, mutually-exclusive branches, story locks.
2. **State Engine** — passive log watcher (raid detection, quest transitions, flea sales, mode/profile) + screenshot position + backfill of historical logs + XP accrual model estimating level between manual calibrations. Local SQLite as system of record; TarkovTracker as optional sync mirror (lights up tarkov.dev + RatScanner for free).
3. **Foresight Guard** — irreversibility warnings encoded from failConditions + curated story data: "Accepting *Big Customer* fails *Chemical Part 4* forever"; "This Ticket choice locks you out of Savior"; "Advance Mechanic's main line and your LK alternate expires."
4. **Quartermaster** — plan-tied acquisition: for the next N raids' needs, the cheapest path per item (flea @ level gate vs trader vs 779 barters vs 211 crafts), craft-timer scheduling, FIR-only flags routed to "find it on planned raid #3, here's the coordinate."
5. **AI Copilot** — Claude on top of the solver: natural-language goals ("Kappa + Savior before I prestige, I hate Lighthouse"), per-raid briefings, post-raid replans triggered by log events, explanations with receipts. The solver provides ground truth; the LLM narrates, adapts, interfaces. **Grounded, never guessing.**

## 3. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  DATA PLANE (world knowledge, refreshed per patch + 5-min prices)  │
│  • json.tarkov.dev (primary; GraphQL frozen/maintenance)           │
│  • Curated story dataset (wiki MediaWiki API + prior tsx artifact) │
│  • Patch snapshots (diff on 1.1.0!) + corrections overlay          │
└──────────────┬─────────────────────────────────────────────────────┘
┌──────────────▼─────────────────────────────────────────────────────┐
│  STATE PLANE (player knowledge, local-first, per profile PvP/PvE)  │
│  • SQLite modeled on TarkovTracker schema (tarkov.dev IDs,         │
│    {complete,failed,timestamp}, counts, progressEpoch)             │
│  • Watcher service: log tail (quest 10/11/12 events, raids, flea)  │
│    + screenshot position + "read past logs" backfill               │
│  • XP estimator (task XP + raid heuristics + manual calibration)   │
│  • Manual/OCR capture for the log-invisible: hideout, trader rep   │
│  • Optional sync: TarkovTracker .org API (import seed + debounced  │
│    batched writes) → free tarkov.dev/RatScanner interop            │
└──────────────┬─────────────────────────────────────────────────────┘
┌──────────────▼─────────────────────────────────────────────────────┐
│  PLANNING PLANE (the moat)                                         │
│  • Graph solver: goal-set → per-raid batches (see §5)              │
│  • XP/level simulator: predicted level curve, gate-stall detection │
│  • Irreversibility guard: failConditions + story decision graph    │
│  • Acquisition planner: buy/barter/craft/FIR-find w/ timers        │
└──────────────┬─────────────────────────────────────────────────────┘
┌──────────────▼─────────────────────────────────────────────────────┐
│  AI PLANE                                                          │
│  • Claude (Agent SDK service or API): briefings, NL goal setting,  │
│    post-raid replan narration, "why this order" explanations       │
│  • Event-driven: raid-end log event → replan → notify              │
└──────────────┬─────────────────────────────────────────────────────┘
┌──────────────▼─────────────────────────────────────────────────────┐
│  SURFACES                                                          │
│  • Local web app (React/Vite, served by the service; 2nd monitor) │
│    – Tonight's Plan (raid cards) – Goals dashboard (Kappa %/story │
│      tracker ported from tsx) – Quartermaster list – Map view      │
│  • tarkov.dev map remote-control socket (live position, no overlay │
│    risk) · optional Discord/phone push via n8n                     │
└────────────────────────────────────────────────────────────────────┘
```

**ToS stance (non-negotiable):** read-only on logs/screenshots/configs; no process access, no injection, no input automation, no game-file modification; overlays only as separate windows if ever; in-raid info gated behind the user's own screenshot keypress. This is the RatScanner/TarkovMonitor risk class — 5+ years, zero proven bans.

## 3.1 Layers added in the Coach foundation (2026-07-16)

Since v1.1 the product was reframed as **"The Coach"** — proactive, not passive — and three structural layers were added ([SPEC-8](spec/SPEC-8.md) / [SPEC-9](spec/SPEC-9.md) / [SPEC-10](spec/SPEC-10.md); wired per [CONTRACTS](spec/CONTRACTS.md) §5.6/§5.7). They *front* and *package* the five planes above rather than replace them.

- **Sources (`@tac/sources`, M10)** — one disciplined client fronting the DATA PLANE: cache-first TTL + conditional 304s, a quota ledger, retry/backoff, and a live status surface (`GET /api/sources/status`, WS `source.status`). **TarkovTracker-read pivot:** since the user runs TarkovMonitor→TarkovTracker, TT is *read* as the live progress source (GP scope), not written — so the STATE PLANE's log watcher becomes enrichment (objective counts, perf, story) rather than a competing writer, and we never contend on TT's shared 100/day write quota.
- **Connectors (`@tac/connectors`, M9)** — a sibling I/O layer for the user's *local* tools, capability-first (`game-config`, `keyboard-actuation`, `audio-mix`, `gpu-3d-profile`, `perf-telemetry`, `manual-capture`). Registration refuses anything above T1; reads default-on, writes opt-in + reversible (backup-first, game-closed). Generalizes the old hard-wired M6 environment adapters and is the plugin seam for the H3 community track. Provenance-tagged readings feed config↔outcome attribution (M6.3).
- **Desktop shell (`apps/desktop`, M11)** — Electron packaging: one installable Windows app (`.exe`/`.msi`) whose main process spawns the existing service+agent as sidecars and renders the service's own web UI. The AI PLANE is now framed as *coaching* (plan → debrief → speak up when a choice matters), fed by connector/source provenance.

Connectors and Sources share a provenance envelope + health/registry pattern (to be hoisted to `@tac/shared`). Everything here stays **T0/T1 — no game-process contact.**

## 4. What we do NOT build (leverage list)

| Don't build | Use instead |
|---|---|
| Item/price/task database | tarkov.dev JSON API (free, 5-min prices, verified complete) |
| Interactive maps | tarkov.dev maps + remote-control socket; Map Genie Pro as personal reference |
| In-raid item scanner | RatScanner (reads our progress via TarkovTracker mirror) |
| Progress-tracking UI basics + squad sync | TarkovTracker .org (mirror target) |
| Log-parsing patterns | Port TarkovMonitor's proven regexes/architecture (GPL — reference the patterns, write our own code) |
| Story wiki content | Fandom MediaWiki API (CC BY-NC-SA 3.0, attribute, non-commercial) + our tsx dataset as seed |

## 5. The solver (core design sketch)

- **Model:** tasks = nodes with gates (minPlayerLevel, trader LL, prereq status incl. `failed`, faction, prestige, keys); objectives = geo-tagged work units (318 have x/y/z zones); maps = bins with fixed overhead (queue+load+raid time); hideout levels = nodes gated on items/traders/skills feeding back bonuses (Intel Center → quest money/XP boost matters!).
- **Objective function:** minimize expected raids (or hours) to reach goal-set G ⊆ {Kappa-257, ending E, LK-102, hideout-max, level L}, subject to batching preference weights (user's "I hate Lighthouse" = map cost multiplier).
- **Approach:** exact optimization is NP-hard (this is close to a precedence-constrained orienteering problem); a **greedy + lookahead heuristic with simulated XP** gets 90% of the value: score each (map, available-task-subset) by tasks-closed + XP + unlock-criticality per expected hour, plan a rolling horizon of ~5 raids, replan after every raid event. Deterministic solver in TypeScript or Python; property-test against KappaQuests' known-good counts (257 kappa, 102 LK).
- **Critical-path analytics:** identify bottleneck chains (e.g., level-45 Collector gate, Jaeger rep repair after Chemical −0.01 choices), surface "XP surplus/deficit vs gate" continuously.

## 6. Phased course of action

### Phase 0 — Foundation (1–2 sessions) ✅ *research done*
- Scaffold repo (TypeScript monorepo or Python service + React app — decide at kickoff).
- Data ingestion: json.tarkov.dev → local cache; **snapshot current 1.0.6 data immediately** (1.1.0 reshuffle diffing).
- Build the task graph in code; validate: 510 tasks, 257 kappa, 102 LK, failCondition branch sets.
- Curate story dataset v1: wiki API pull + merge the tsx artifact's chapters/decisions/endings; add Boreas.

### Phase 1 — Planner MVP (the "wow" moment, ~2–4 sessions)
- Solver v1 (greedy+lookahead, XP sim) + **"Tonight's Plan"** web view.
- State seed WITHOUT the watcher: import from TarkovTracker token if you have one, else a fast onboarding quiz (level, trader LLs, last tasks per chain) — usable day one.
- Foresight Guard v1 from failConditions + curated story decisions.
- CLI/API access so Claude can call the solver.

### Phase 2 — Auto-state (2–3 sessions)
- Watcher service: log tail (quests 10/11/12, raids, flea, profile/mode), screenshot watcher, historical backfill; use the unused `UserMatchCreated`/`UserConfirmed` events.
- XP estimator + calibration UX; hideout/trader manual capture screens (OCR assist later).
- TarkovTracker sync (import + debounced batch writes, epoch guards).

### Phase 3 — AI copilot (2–3 sessions)
- Claude service: NL goal intake, per-raid briefings ("On Customs: Dorms first — room 110 key from Foresight cache, then marked circle for chapter 5..."), post-raid replan notifications.
- Event pipeline: raid-end → replan → push (local UI toast; optional n8n → Discord/phone).

### Phase 4 — Polish & edge (ongoing)
- OCR assists (hideout screen, stash value, level readout), live position map (drive tarkov.dev maps), squad awareness, Kord Breach seasonal mode support, patch-diff alerting (tarkov-changes), keep/sell advisor (the original auto-tracker idea — now plan-aware).

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **1.1.0 (weeks away): task unlock reshuffle, insurance rework, Season 1** | Zero hardcoded task data; snapshot 1.0.6 now; diff on patch; seasonal = separate profile in schema (already modeled) |
| Story data has no API source | Curated dataset is small (~10 chapters, 4 endings), static per patch; wiki + tsx seed; version it in-repo |
| Logs can't see hideout/level/kills | Design honestly: XP estimator + calibration, manual/OCR capture; never promise what incumbents can't do either |
| TarkovTracker quota/downtime/cascades | Local-first; batch writes; reconcile reads; epoch guards |
| tarkov.dev burst limits / partial errors | 5-min cache alignment, retries, tolerate `errors`+`data` |
| BSG policy shift on gray-zone tools | Stay in the proven risk class; feature-flag anything in-raid-informative |
| Solo-dev scope creep | Phase gates above; Phase 1 delivers standalone value without the watcher |

## 8. Immediate next actions (kickoff checklist)

1. Decide stack (recommend: **TypeScript end-to-end** — Node service + React/Vite UI; shares types with tarkov.dev data shapes) and scaffold.
2. Pull + snapshot json.tarkov.dev (both `regular` and `pve`).
3. Write graph loader + invariants tests (257/102/branch sets).
4. Curate `data/story/*.json` from wiki + tsx.
5. (You) Create a TarkovTracker .org account + `PVP_`/`PVE_` token — instant Phase 1 state seed, and decide: keep playing on main, or planning around a future prestige run?
