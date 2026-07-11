# @tac/planner

The moat (SPEC module **M3**). Turns the world model + player state into per-raid decisions. Deterministic, tested, explainable — the solver is ground truth; the AI copilot (M4) only narrates it.

## Try it

```bash
pnpm --filter @tac/planner exec tsx src/cli/demo.ts 1                  # Kappa plan from a fresh level-1 account
pnpm --filter @tac/planner exec tsx src/cli/quartermaster-demo.ts 15   # shopping list for the next 5 Kappa raids
pnpm --filter @tac/planner test
```

## Pieces

- `state.ts` — `PlayerState` (persisted, TarkovTracker-shaped) + `SimState` (solver working set).
- `levels.ts` — `LevelCurve`: XP↔level over the 79-row tarkov.dev curve.
- `availability.ts` — is a task doable now? Honors level/faction/prereqs (`complete`·`failed`·`active`)/lock-out. `blockedOnlyByLevel` powers stall detection.
- `goals.ts` — goal → target tasks → full prerequisite closure. Goals: `kappa`, `lightkeeper`, `level`, `tasks`.
- `director.ts` — **Raid Director**: classifies tasks (free / any-map / pinned), batches by map, scores by value/cost where value = tasks + XP + **criticality** (downstream goal tasks a task unlocks), replans over a rolling horizon.
- `foresight.ts` — **Foresight Guard**: task-exclusivity warnings (completing X fails Y — escalates to `critical` when Y is a goal/Kappa/LK task) + story `endingReachability`.
- `quartermaster.ts` — **Quartermaster (M3.5)**: collects every item the planned raids hand in / plant (giveItem, plantItem, non-duplicate findItem), enumerates routes (flea / trader cash / barter / craft / find-in-raid), picks the cheapest route FEASIBLE at the current level + trader LLs, and schedules crafts so outputs are ready before the raid that needs them. Output is CONTRACTS §7 `AcquisitionPlan`; every item carries machine-readable `reasons` (M3.6).

## Quartermaster rules (grounded in 1.0.6 data)

- **FIR needs are never routed to flea/trader/barter** — purchases aren't found-in-raid. Crafts ARE offered as FIR alternatives (hideout outputs count as FIR). Find-in-raid routes point at a planned raid whose map matches a known find location (task map / objective zones), else the earliest raid.
- **findItem/giveItem pairs count once** — 131 tasks say "find N FIR, hand over N"; the findItem is skipped when a same-task giveItem shares a candidate item.
- **Any-of item lists** (e.g. "any 3 USEC dogtags") collapse to the cheapest candidate by reference price.
- **Barter/craft costing** is one level deep: inputs are priced by direct purchase (flea at level, trader at LL), never by their own barters. Unbuyable inputs flag the route ("input must be found in raid") and block feasibility.
- **Trader LL** derives from level+rep via the snapshot ladders (`requiredCommerce` ignored — not observable). Hideout station levels gate crafts when provided (`opts.hideoutLevels`); absent, stations are assumed built and the item carries `assumed:hideout-built`.
- **Roubles handed in directly** (a few tasks) become a synthetic cash route at face value so `totalRubles` stays meaningful.

## Task classification (important)

`map: null` does **not** mean "no raid" in tarkov.dev data. We classify by objective type:
- **free** — no in-raid objective (trader hand-in, gunsmith, skill/rep): drained between raids, cascades unlocks.
- **any-map** — in-raid objective, no pinned map (kill/find "anywhere"): folded into any raid as fillers.
- **pinned** — in-raid objective on a specific map: the batch anchor.

## Known limitation — XP projection is optimistic

Draining free tasks completes entire no-raid chains (esp. Gunsmith) the moment their level gate is met, ignoring the parts/money/rep they actually require. So the projected **level timeline climbs faster than reality** and some level-gated tasks look reachable earlier than they are. The **ordering and batching are unaffected** — only the level *timeline*. The fix is the Quartermaster (M3.5): once acquisition (items/money/rep) is modeled, "instantly free" becomes "free once you have the inputs." Treat `reachedLevel` and per-raid levels as an upper bound until then.
