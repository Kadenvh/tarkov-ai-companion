# SPEC-1 — Planner MVP (the moat)

> Phase spec derived from [SPEC.md](../../SPEC.md) modules **M3.1–M3.5**. Status: **CORE + QUARTERMASTER COMPLETE (2026-07-11)**; surfacing (web UI) pending.

## Objective
Turn the world model into *decisions*: given player state + goals, output per-raid task batches, an XP/level projection, and irreversibility warnings — the capability no existing tool ships.

## Scope (`packages/planner`)
Player-state model, availability engine, goal resolution, the Raid Director solver, XP simulation, and the Foresight Guard.

## Deliverables & status
| ID | Deliverable | Status |
|---|---|---|
| 1.1 | `PlayerState` schema (TarkovTracker-shaped) + `SimState` | ✅ |
| 1.2 | `LevelCurve` (XP↔level over 79-row curve) | ✅ |
| 1.3 | Availability engine: level/faction/prereq(complete·failed·active)/lock-out semantics | ✅ |
| 1.4 | Goal model (kappa · lightkeeper · level · tasks) + prerequisite closure | ✅ |
| 1.5 | **Raid Director**: free/any-map/pinned classification, map batching, criticality scoring, rolling horizon, XP-driven relevel | ✅ |
| 1.6 | Level-stall diagnostics (goal tasks blocked only by level) | ✅ |
| 1.7 | **Foresight Guard**: task exclusivity warnings + story ending reachability | ✅ |
| 1.8 | Demo CLI (`tsx src/cli/demo.ts <level>`) | ✅ |
| 1.9 | Web "Tonight's Plan" surface | ⏳ next |
| 1.10 | **Quartermaster** (acquisition planner, M3.5) + market loaders in data-core | ✅ |
| 1.11 | Quartermaster demo CLI (`tsx src/cli/quartermaster-demo.ts <level>`) | ✅ |

## Acceptance (met for core)
- **7/7 planner tests green** on the real 1.0.6 snapshot: level curve round-trips (flea gate @15), kappa closure ⊇ 257, fresh-account availability respects level gates, Director produces multi-task map batches toward Kappa with XP-driven leveling, map-aversion weights honored, exclusivity + ending-reachability warnings fire.
- Demo produces a coherent Kappa route from level 1: Ground Zero starters (Saving the Mole first — it unlocks 95 downstream goal tasks) → Woods (Debut/Shortage/Introduction) with any-map Jaeger shooter quests folded in as fillers → map-by-map thereafter.

## Design decisions
- **Greedy + criticality**, not exact optimization. Precedence-constrained orienteering is NP-hard; greedy with downstream-goal criticality scoring + rolling-horizon replanning captures ~90% of the value and stays explainable. Lookahead/beam search is a later upgrade.
- **Three task classes** because `map: null` ≠ "no raid": `free` (no in-raid objective → drained for unlock cascade), `anyMap` (in-raid, unpinned → folded into any raid as fillers), `pinned` (batch anchor).
- **Criticality = downstream goal-task count** via memoized reverse reachability — this is why the solver front-loads unlock-heavy tasks automatically.

## Quartermaster (M3.5) — `src/quartermaster.ts` + `data-core/src/market.ts`

`buildAcquisitionPlan(graph, market, plan, state, opts?)` → **CONTRACTS §7 `AcquisitionPlan`** (binding shape, followed exactly).

**Market loaders** (`@tac/data-core` `loadMarket(mode, ref?)`): items (flea avg/low prices, per-item flea level gate = max(global 15, `minLevelForFlea`), `noFlea` ban flag, rouble-normalized trader buy/sell offers), 779 barters, 211 crafts (tool inputs flagged as returned-not-consumed), 16 traders with loyalty ladders, 26 hideout stations with FIR-flagged item requirements. Lenient zod — bad rows skipped into `Market.issues`, never fatal. All shapes verified against the committed 1.0.6.0.46010 snapshot.

**Need collection.** For the plan's first N raids + free hand-ins: `giveItem` / `plantItem` / `findItem` objectives (counts, FIR flags, any-of candidate lists collapsed to the cheapest candidate). `findItem` paired with a same-task `giveItem` (131 occurrences in 1.0.6) counts once. Optional objectives excluded by default.

**Route enumeration & selection.**
- *flea* — gated on `max(global unlock 15, per-item gate)` read from data; banned items excluded.
- *trader cash* — best offer per trader; gated on derived LL (level+rep via snapshot ladders; `requiredCommerce` ignored — not observable) and `taskUnlock` vs completed tasks.
- *barter* — cost = Σ input purchase prices × ceil(count/outputCount); one recursion level (inputs priced by direct purchase only); unbuyable inputs flag "must be found in raid" and block feasibility; 3 cheapest kept.
- *craft* — station+level gate (strict when `opts.hideoutLevels` given, else assumed-built with `assumed:hideout-built` reason), input costs excluding tools, duration in minutes.
- *find-in-raid* — the ONLY route for FIR needs (purchases aren't FIR; crafts are, so feasible crafts appear as FIR alternatives); routed to a planned raid whose map matches a find location (task map / objective zones), else the earliest raid, with `raidIndex`.

Primary = cheapest **feasible** route at current player state; everything else lands in `alternatives`. Every item carries machine-readable `reasons` (M3.6): `needed-by:raid-N`, `route:<kind>:cheapest-feasible`, `skipped-cheaper:<kind>:<gate>`, `blocked:<kind>:<gate>`, `fir-required`, …

**Craft schedule.** Crafts ordered so outputs are ready before the raid that needs them: `startBy: "before raid N"`, earlier raids first, longest crafts first within a raid.

**Acceptance (met).** 13 quartermaster tests + 12 market tests green: real-snapshot floors (>500 barters, ≥200 crafts), level-5-vs-40 + LL gate fixtures, FIR-never-flea/trader, barter arithmetic (ceil batching), craft-schedule ordering, hideout gating, findItem dedupe, and a real Kappa-plan smoke test asserting internal consistency (`totalRubles` = Σ parts, resolved names, raidIndex bounds).

**Known deviations/limits (documented):** trader LL is an upper bound (commerce spend unobservable until state-engine tracks it); `taskUnlock` checks use current `completedTasks`, not tasks completed mid-plan (conservative); currency hand-ins get a synthetic cash route at face value; barter/craft input FIR status of the *inputs themselves* is not modeled beyond the unbuyable flag.

## Known limitation (documented, not a bug)
- **XP projection is an optimistic upper bound.** Free-task draining completes entire no-raid chains (esp. Gunsmith) the instant their level gate is met, ignoring that they require specific parts + trader money + rep the player may not have. So the projected level climbs faster than reality and level-gated tasks may appear reachable early. Fix arrives with the **Quartermaster (M3.5)**: modeling item/money/rep acquisition converts "instantly free" into "free once you have the inputs," and trader-rep simulation gates the chains correctly. Ordering and batching (the moat) are unaffected — only the level *timeline* is optimistic.
