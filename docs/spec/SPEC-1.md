# SPEC-1 — Planner MVP (the moat)

> Phase spec derived from [SPEC.md](../../SPEC.md) modules **M3.1–M3.4** (+ seed of M3.5). Status: **CORE COMPLETE (2026-07-11)**; surfacing (web UI) and acquisition planner pending.

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
| 1.10 | Quartermaster (acquisition planner, M3.5) | ⏳ next phase |

## Acceptance (met for core)
- **7/7 planner tests green** on the real 1.0.6 snapshot: level curve round-trips (flea gate @15), kappa closure ⊇ 257, fresh-account availability respects level gates, Director produces multi-task map batches toward Kappa with XP-driven leveling, map-aversion weights honored, exclusivity + ending-reachability warnings fire.
- Demo produces a coherent Kappa route from level 1: Ground Zero starters (Saving the Mole first — it unlocks 95 downstream goal tasks) → Woods (Debut/Shortage/Introduction) with any-map Jaeger shooter quests folded in as fillers → map-by-map thereafter.

## Design decisions
- **Greedy + criticality**, not exact optimization. Precedence-constrained orienteering is NP-hard; greedy with downstream-goal criticality scoring + rolling-horizon replanning captures ~90% of the value and stays explainable. Lookahead/beam search is a later upgrade.
- **Three task classes** because `map: null` ≠ "no raid": `free` (no in-raid objective → drained for unlock cascade), `anyMap` (in-raid, unpinned → folded into any raid as fillers), `pinned` (batch anchor).
- **Criticality = downstream goal-task count** via memoized reverse reachability — this is why the solver front-loads unlock-heavy tasks automatically.

## Known limitation (documented, not a bug)
- **XP projection is an optimistic upper bound.** Free-task draining completes entire no-raid chains (esp. Gunsmith) the instant their level gate is met, ignoring that they require specific parts + trader money + rep the player may not have. So the projected level climbs faster than reality and level-gated tasks may appear reachable early. Fix arrives with the **Quartermaster (M3.5)**: modeling item/money/rep acquisition converts "instantly free" into "free once you have the inputs," and trader-rep simulation gates the chains correctly. Ordering and batching (the moat) are unaffected — only the level *timeline* is optimistic.
