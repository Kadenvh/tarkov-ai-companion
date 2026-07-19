# NORTH STAR — Tarkov AI Companion

## The star

> **Every raid is planned, and every plan gets smarter.**

## North-star metric

**Plan Hit Rate** — the percentage of raids launched with a companion plan in which the player completes **≥1 planned objective**.

Supporting metrics:
- **Raids-to-goal delta** — solver-projected raids remaining vs. naive baseline (the measurable "time saved")
- **State freshness** — % of player state updated automatically (no manual entry) within 5 min of a raid ending
- **Between-raid cost** — time spent operating the companion between raids (target: **< 2 minutes**; this is a counter-metric — the companion serves the game, not the reverse)

If Plan Hit Rate is high, plans are realistic and grounded. If raids-to-goal keeps dropping, the optimizer works. If state freshness is high, the passive pipeline works. If between-raid cost creeps up, we're building a chore, not a companion.

## Decision filters (in priority order)

When choosing what to build or how to build it, the first filter that discriminates wins:

1. **Does it keep the account safe?** Anything outside the proven external-read risk class is flagged, defaulted off, or refused. No feature is worth the main.
2. **Does it close a gap no one serves?** (Solver, foresight, personalization, replanning.) Build it.
3. **Does something existing do it well?** (Prices, maps, scanning, squad sync.) Integrate, don't rebuild.
4. **Does it reduce raids-to-goal or between-raid cost?** If neither, it's polish — queue it behind anything that does.
5. **Does it survive the next patch without a human?** Data-driven + snapshot-diffed + wiki-cross-validated, or it doesn't ship.

## Horizons

- **H1 — Daily driver (now):** Kaden's second monitor, every session. Planner + auto-state + copilot. Success = the companion is *missed* when it's off.
- **H2 — The Coach (next):** the companion stops being a passive tracker and becomes a *coach* — deepest **account-safe** capture (logs + end-of-raid results OCR + config/perf telemetry + net-worth), structured into a personal model, driving proactive pre-raid plans, post-raid debriefs, and settings/economy/route/ending feedback. The app wraps agentic loops; occasional *assisted-capture* prompts are acceptable, used only to fill gaps the passive pipeline can't reach. Success = measurably better raids and decisions, not just better plans.
- **H3 — Community surface (real track, no SaaS):** shareable plugin + OBS browser-source overlay + published guide/dataset (story-foresight under CC BY-NC-SA, settings-vs-meta audit). Local-first only — **no hosting, no multi-user auth, no cloud state-of-record.** Promoted from "optional" to a real horizon; ships the novel parts without the SaaS tail. (Squad features / Kord Breach racing remain unforced, behind H1/H2 health.)

## Never list (hard non-goals)

- ❌ Memory reading, process injection, packet interception, input automation, game-file modification — **never**, including "just for testing"
- ❌ Cheating adjacency: no ESP-like intelligence the game didn't willingly write to disk
- ❌ Cloud system-of-record for player state
- ❌ Ungrounded AI answers about game facts
- ❌ RMT, boosting, account-sharing adjacency
- ❌ Rebuilding tarkov.dev, TarkovTracker, RatScanner, or Map Genie

## Current standing decisions

| Decision | Choice | Date |
|---|---|---|
| Product name | **tarkov-ai-companion** | 2026-07-11 |
| Stack | **TypeScript end-to-end** (Node service + React/Vite; pnpm monorepo) | 2026-07-11 |
| Target profile | **Main account** (second, unused account available as testbed) | 2026-07-11 |
| State architecture | **Local-first SQLite; TarkovTracker .org as optional mirror** | 2026-07-11 |
| Data sources | **json.tarkov.dev primary + EFT wiki (MediaWiki API) first-class + curated story dataset** | 2026-07-11 |
| Dev method | **Spec-driven** (SPEC.md is the contract; recon precedes build) | 2026-07-11 |
| Product posture | **"The Coach"** — proactive agentic companion, not passive tracker; agentic loops + occasional assisted-capture prompts | 2026-07-16 |
| Community strategy | **Plugin + OBS overlay + guide/dataset (local-first, no SaaS/cloud state)** — H3 promoted to a real track | 2026-07-16 |
| Data-capture depth | **Maximal account-safe:** logs + end-of-raid results OCR + config↔outcome/perf attribution + net-worth/goal ETA | 2026-07-16 |
| Product IA | **Verb-first** (Operate · Understand · Ask · Environment) — lead with *what to do*, not object lists. The deliberate delta vs TarkovTracker's noun-oriented nav (see [research/11](docs/research/11-tarkovtracker-product-recon.md)) | 2026-07-19 |
| State feed | **Read-mostly mirror FROM TarkovTracker** — sync progress *in* (TarkovMonitor already feeds TT); **no writes back** (avoid the shared 100/day write quota + TM cascade conflicts); local log-watcher = enrichment, not a competing writer | 2026-07-19 |
| Design language | **Tactical console** — brass on gunmetal, layered panels w/ inset highlight, monospace data readouts, hazard-stripe signature, **dark-committed** (second-monitor game companion) | 2026-07-19 |
