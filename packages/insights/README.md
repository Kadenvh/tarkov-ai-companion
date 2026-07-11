# @tac/insights

Personal insights (SPEC module **M7**): raid analytics, economy tracking, and the playstyle fingerprint that feeds the agent's learned weights (M4.5). Pure, deterministic computation over the per-profile SQLite journal — no watchers, no game files, no network.

**Risk tier: T0.** Every function takes a `node:sqlite` `DatabaseSync` handle opened by the caller and only ever reads it. `@tac/state-engine` owns the schema and all writes; the boundary is the DDL in [docs/spec/CONTRACTS.md §4](../../docs/spec/CONTRACTS.md) (copied verbatim into `test/fixtures/schema.sql`).

## How to test

```bash
pnpm --filter @tac/insights typecheck
pnpm --filter @tac/insights test    # 31 tests over a hand-computed synthetic fixture DB
```

## Small-n honesty (applies to everything)

Every metric carries its sample size `n` and a `lowConfidence: true` flag when `n < 5` (`LOW_CONFIDENCE_N`). Consumers (web UI, agent) must surface the flag rather than hide thin data. Rows the metric had to skip (NULL columns, unparseable timestamps) are counted in an `excluded` field — nothing disappears silently.

## Timestamp semantics

DB timestamps are ISO-8601 TEXT as written by the log watcher. Hour-of-day and calendar-day are extracted **lexically** (the wall-clock time as recorded) — never timezone-converted — so the same DB yields identical analytics on any machine. Epoch parsing is used only for *differences* (session gaps/lengths), where the timezone cancels. A raid's representative timestamp is `started_at ?? queued_at ?? ended_at`; its end-of-activity is `ended_at ?? started_at ?? queued_at`.

## M7.1 — Raid analytics (`src/raids.ts`)

| Metric | What it is | Caveats |
|---|---|---|
| `survivalByMap(db)` | Per-map `{n, survived, died, unknown, survivalRate}` | Rate = survived/(survived+died); `unknown` outcomes count toward `n` but not the rate (rate `null` when nothing decided). NULL maps group under `"(unknown)"`. |
| `survivalByHour(db)` | Same stat per wall-clock start hour (0–23) | Raids with no parseable timestamp are `excluded`. |
| `survivalByDuration(db)` | Same stat per duration bucket (0–10m, 10–20m, 20–30m, 30–40m, 40m+) | Buckets on `duration_sec` (in-raid time; queue/load excluded), inclusive lower / exclusive upper. NULL or negative durations `excluded`. |
| `queuePatterns(db)` | Avg + median `queue_sec` by map and by hour | Only raids with a recorded `queue_sec`; the rest `excluded`. |
| `sessionRhythm(db, {gapMinutes?})` | Groups raids into play sessions; per-session raid count, length, maps, survival; summary with mean/median raids-per-session and session length, best/worst session | New session when the gap from previous raid's **end** to this raid's **start** is *strictly greater than* the threshold (default 90 min — a gap of exactly 90 stays together). Session length = first start → last end, so it includes between-raid downtime. Best/worst tie-break → earliest session; all-unknown sessions never win either slot. |

## M7.2 — Economy tracking (`src/economy.ts`)

| Metric | What it is | Caveats |
|---|---|---|
| `fleaIncome(db, "daily"\|"weekly")` | Income per period + running cumulative curve | **Flea income only** — the logs never show trader sales, insurance returns, loot value, or spending. Weekly buckets key on the ISO-week Monday. Periods with zero sales are omitted from `points` (the cumulative value carries). |
| `netWorthEstimate(db, config?)` | Day-by-day curve: `startingRubles + cumulative flea income − dailySpendRubles × daysElapsed` | **An ESTIMATE, permanently labeled** (`isEstimate: true` + `caveats[]` in every payload). The spend side is a flat user-configurable heuristic, not observed data. Directional shape only, not an accounting statement. Real stash valuation arrives with the OCR capture channel (M2.6) and supersedes this. Config is zod-validated (`dailySpendRubles ≥ 0`). |

## M7.3 — Playstyle fingerprint (`src/fingerprint.ts`)

`playstyleFingerprint(db, {sessionGapMinutes?})` → `{ features, explanations, sampleSizes, lowConfidence }`.

Guarantees: **deterministic** (same DB → byte-identical JSON; keys sorted, values rounded to 4 decimals) and **inspectable** (every feature key has a same-key human-readable explanation — enforced by test). This is the input to the M4.5 learned-weights pipeline in `apps/agent`, which proposes `PlannerWeights` deltas the user must confirm.

| Feature | Definition |
|---|---|
| `map_share_<slug>` | Share (0–1) of all journaled raids on that map — revealed map preference (one feature per map seen; `mapSlug()` slugs names). |
| `survival_rate` | survived/(survived+died); 0 when nothing decided yet. |
| `median_raid_duration_sec` | Median `duration_sec` — pace proxy (low = rusher/task-rat, high = slow looter). |
| `raids_per_session` | Mean raids per session — informs plan-horizon sizing. |
| `session_length_median_min` | Median session length (first start → last end). |
| `task_focus_ratio` | `quest_events` rows per raid — task-focused vs loot/PvP play. |
| `peak_hour` | Modal wall-clock start hour (ties → earliest). |
| `night_owl_share` | Share of raids started 22:00–05:59 — schedule pattern. |

Missing data degrades to 0 (never NaN/null in the vector) with `sampleSizes` telling the consumer how much to trust it.

## Fixtures

`test/fixtures/build.ts` seeds an in-memory DB (24 raids / 6 sessions / 6 days / 4 flea sales / 36 quest events) whose every expectation is hand-computed in a table in the file's docstring. All ids are fake 24-hex values; no real profile/account/session ids anywhere.
