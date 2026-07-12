# @tac/data-core

The world model (SPEC module **M1**). Ingests json.tarkov.dev, snapshots it per patch, parses the EFT wiki, curates the story dataset, and builds the task dependency graph everything else plans against.

## Commands

```bash
pnpm snapshot            # pull all endpoints (regular+pve, en strings) into data/snapshots/<version>/
pnpm snapshot 1.0.7.0    # explicit version label (default: auto-detected from EFT log folders)
pnpm test                # invariants + parsers (requires a snapshot on disk)
```

## Layout

- `src/api.ts` — json.tarkov.dev client (retry, UA). GraphQL API is frozen upstream; JSON API is primary.
- `src/cli/snapshot.ts` — per-patch snapshot writer (gzipped JSON + manifest).
- `src/snapshot.ts` — snapshot loader + `_en` string-table resolution (`tr()`).
- `src/tasks.ts` — zod schemas for the tasks payload (verified against 1.0.6 live data).
- `src/graph.ts` — task graph: progression edges, branch-only unlocks (`failed` prereqs), fail/exclusivity sets, structural validation.
- `src/market.ts` — market loaders for the Quartermaster (M3.5): items with flea prices + per-item flea level gates + rouble-normalized trader offers, barters, crafts (tool inputs flagged), trader loyalty ladders, hideout stations. Lenient zod: bad rows are skipped into `Market.issues`, never fatal. `loyaltyLevelFor()` derives a player's LL from level+rep (ignores `requiredCommerce` — not log-observable, so it's an upper bound).
- `src/wiki/infobox.ts` — `Infobox quest` wikitext parser (CC BY-NC-SA 3.0 — attribution required, non-commercial only when republishing wiki content).
- `src/story/schema.ts` — schema for `data/story/story.json` (10 chapters, 4 decisions, 4 endings; tarkov.dev has zero story coverage — this dataset is ours).

## Data facts worth remembering (verified 2026-07-11, v1.0.6)

- Payload shape: `{data: {tasks: {<id>: Task}}}`; names are translation keys (`"<id> name"`) resolved via `/{mode}/tasks_en` string tables.
- 510 tasks · 257 kappaRequired · 102 lightkeeperRequired · 38 tasks with failConditions · `experience` can be `null` (PvE).
- `taskRequirements[].status` semantics: `["complete"]` hard prereq · `["complete","failed"]` resolved-either-way · `["failed"]` branch-only unlock · `["active"]` parallel availability.
- Market data: 5054 items · 779 barters · 211 crafts · 16 traders · 26 hideout stations. Flea gate = max(global `fleaMarket.minPlayerLevel` = 15, per-item `minLevelForFlea`); 1236 items are `noFlea`. Trader offers live on items as `buyFromTrader`/`sellToTrader` (JSON API naming — NOT GraphQL's `buyFor`/`sellFor`) with `priceRUB` normalizing USD/EUR traders.

## Invariant tests as patch tripwire

`test/graph.invariants.test.ts` pins counts and known branch structures. When a patch (e.g. 1.1.0 "Kord Breach") reshuffles tasks: run `pnpm snapshot`, re-run tests, and every failure is a reviewable diff of what BSG changed — that's the M8.2 sentinel working as designed.
