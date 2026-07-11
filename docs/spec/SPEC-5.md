# SPEC-5 — Insights (M7)

> Phase spec derived from [SPEC.md](../../SPEC.md) module **M7** (M7.1 raid analytics · M7.2 economy tracking · M7.3 playstyle fingerprint). Status: **COMPLETE (2026-07-11).**

## Objective
Turn the raid journal the state engine accumulates into personal analytics the player (and the agent) can act on: where and when you actually survive, what your flea economy looks like, and a quantified fingerprint of how you play — the input for M4.5 learned planner weights.

## Scope (`packages/insights`)
Pure read-only analytics over the per-profile SQLite. No watchers, no game-file access, no network, no writes. **@tier T0.**

## Contract boundary (deliberate decoupling)
Insights does **not** import `@tac/state-engine` (they build in parallel). The contract is the SQLite DDL in [CONTRACTS.md §4](CONTRACTS.md): every public function takes a `node:sqlite` `DatabaseSync` opened by the caller (`apps/service` passes the live profile DB). Tests execute the DDL verbatim (`test/fixtures/schema.sql`) and seed synthetic rows — if state-engine drifts from the contracted schema, the shared DDL doc is the arbitration point.

## Deliverables & status
| ID | Deliverable | Status |
|---|---|---|
| 5.1 | `raids.ts` — survival by map / wall-clock hour / duration bucket (0–10/10–20/20–30/30–40/40m+) | ✅ |
| 5.2 | `raids.ts` — queue-time patterns: avg + median `queue_sec` by map and by hour | ✅ |
| 5.3 | `raids.ts` — session rhythm: >90-min-gap grouping (configurable), raids/session, session lengths, best/worst session by survival | ✅ |
| 5.4 | `economy.ts` — flea income daily/weekly sums + cumulative curve | ✅ |
| 5.5 | `economy.ts` — net-worth **estimate** (labeled, caveated, zod-validated config) | ✅ |
| 5.6 | `fingerprint.ts` — documented feature vector + per-feature explanations, deterministic | ✅ |
| 5.7 | Small-n honesty: every metric carries `n`, `lowConfidence` (n<5), and `excluded` counts | ✅ |
| 5.8 | Package README documenting every metric + caveats | ✅ |
| 5.9 | Service surfacing (`GET /api/insights/raids`, `/api/insights/economy` per CONTRACTS §5.4) + web Insights view | ⏳ apps wave |

## Acceptance (met)
- **31/31 tests green**; `tsc --noEmit` clean under strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- Fixture DB (24 synthetic raids across 4 maps / 3 start hours / 6 sessions / 6 days, 4 flea sales, 36 quest events) built by executing the CONTRACTS §4 DDL verbatim; **every expectation hand-computed** and documented in a table inside `test/fixtures/build.ts`.
- Session-grouping edge cases proven: single raid = one session; gap of **exactly** the 90-min threshold stays in the same session, 91 min splits; missing `started_at` falls back to `queued_at`; empty journal yields an empty-but-well-formed rhythm.
- Fingerprint: byte-identical JSON across repeated calls (determinism), sorted keys, and a test asserting `Object.keys(explanations) === Object.keys(features)` (explanation coverage).
- SPEC M7.1 "dashboards over ≥30 journaled raids" is a UI acceptance — the analytics side is done and flagged honest below n=5; M7.2 "weekly net-worth curve" ships as the labeled estimate; M7.3 "documented feature vector, inspectable" met via explanations + README table.
- No real profile/account/session ids in fixtures (fake 24-hex only).

## Design decisions
- **Wall-clock, lexical time.** Hour/day are cut from the ISO strings as recorded (no timezone conversion) so analytics are machine-independent; epoch math is used only where timezones cancel (gaps, lengths).
- **`duration_sec` is authoritative for in-raid time**; timestamps only feed hours/days/sessions. Queue/load time is never mixed into duration buckets.
- **Survival denominator excludes `unknown`** (rate = survived/(survived+died), `null` when nothing is decided) — outcome inference from logs is imperfect and unknowns must not dilute the rate; they still count in `n`.
- **Session gap is strictly-greater-than** the threshold (exact-90 stays together): a documented, tested tie rule instead of an ambiguous one.
- **Net worth is a heuristic and says so in-band**: `isEstimate: true` + `caveats[]` ride in every payload so no consumer can accidentally present it as fact. Flea income is the only observed side; spending is a flat configurable rate. OCR stash valuation (M2.6) supersedes later.
- **Fingerprint degrades to 0, never NaN/null**, with `sampleSizes` carrying the trust signal — M4.5 consumes a fixed-shape numeric vector plus map-share features keyed by slug.

## Known limitations (documented, not bugs)
- Economy sees **flea income only** — trader sales, insurance, loot value, and all spending are invisible to the logs.
- Session "length" spans first raid start → last raid end, so it includes between-raid stash time (that is the point — it measures the sitting, not the raiding).
- Hour analytics assume the machine's clock/timezone was stable across the journal; a mid-journal timezone move would smear hour buckets (accepted for a single-PC local-first tool).
