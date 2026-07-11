# SPEC-0 — Foundation (Data Core)

> Phase spec derived from [SPEC.md](../../SPEC.md) module **M1** + platform sentinel **M8.2**. Status: **COMPLETE (2026-07-11).**

## Objective
A typed, tested world model built from live data that survives every patch without a human, so nothing downstream ever hardcodes game facts.

## Scope
- pnpm/TypeScript monorepo scaffold (`packages/shared`, `packages/data-core`).
- json.tarkov.dev ingestion + per-patch snapshotting (both game modes, EN string tables).
- Task dependency graph with progression/branch/exclusivity semantics.
- EFT wiki `Infobox quest` parser.
- Curated story dataset (10 chapters, 4 decisions, 4 endings).
- Invariant test suite as the patch-drift tripwire.

## Deliverables & status
| ID | Deliverable | Status |
|---|---|---|
| 0.1 | Monorepo + strict TS + shared ID/GameMode types | ✅ |
| 0.2 | `snapshot` CLI → `data/snapshots/<version>/` (gzip + manifest, auto-detect version from EFT logs) | ✅ 1.0.6.0.46010 committed |
| 0.3 | Snapshot loader + `_en` translation resolution (`tr`) | ✅ |
| 0.4 | Tasks zod schema (verified vs live shape) | ✅ (`experience` nullable in PvE) |
| 0.5 | Task graph: unlocks, requires, fails, branch-only, exclusivity sets, acyclicity/dangling validation | ✅ |
| 0.6 | Wiki infobox parser (trader, prev/leads-to, kappa) | ✅ Debut fixture |
| 0.7 | Story dataset + schema (Boreas conditional branches encoded) | ✅ ending maps wiki-verified 2026-07-11 (see [research/07](../research/07-story-verification.md)) |
| 0.8 | `loadWorld()` convenience loader (names + map names + XP curve) | ✅ |

## Acceptance (all met)
- **15/15 tests green.** Invariants: 510 tasks / 257 Kappa / 102 Lightkeeper; graph acyclic, zero dangling refs; Chemical Part 4 exclusivity triad resolves; branch-only tasks detected; every task name resolves; PvE parses.
- All three packages typecheck under strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.

## Known follow-ups (tracked, not blocking)
- ~~Story ending mappings need wiki re-verification~~ **Done 2026-07-11**: all 4 decisions `verified`, 20/20 ending claims confirmed ([research/07](../research/07-story-verification.md)).
- Wiki batch-fetch + wiki⟷API cross-validation drift report (M1.4) not yet automated — infobox parser is ready for it.
- Snapshot is committed as gzip; a `diff` CLI (M1.2) between two versions is the next data-core add, needed before 1.1.0.
