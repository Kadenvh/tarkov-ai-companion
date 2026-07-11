# SPEC-7 — Web UI (M5.2–M5.5 + Insights/Environment surfaces)

> Phase spec derived from [SPEC.md](../../SPEC.md) module **M5** rows M5.2–M5.5 and the surface rows of M6/M7, per [CONTRACTS.md §6](CONTRACTS.md). Status: **COMPLETE (2026-07-11)** — `apps/web` built, tested, production build green. Live-data acceptance (against a running `apps/service`) lands in the integration wave.

## Objective
The second-monitor surface: everything the planner/state/insights stack knows, glanceable between raids. Dark, high-contrast, large type on raid cards; plain CSS (no component libs, no tailwind, no chart libs); production bundle ≈ 80 kB gzip.

## Scope (`apps/web`)
React 19 + Vite 7, TypeScript strict. Consumes **only** the service HTTP/WS API (CONTRACTS §5 + the documented extensions `GET /api/insights/fingerprint`, `POST /api/state/backfill`, `GET /api/metrics`*). Builds standalone — zero workspace imports; all response types declared locally in `src/api/types.ts`. **@tier T0** (never touches game files/process; positions arrive via the service's T1 screenshot channel).

\* `/api/metrics` is not consumed by any view this wave (M5.6 between-raid instrumentation is a service-side counter); listed for completeness.

## Deliverables & status

| ID | Deliverable | SPEC row | Status |
|---|---|---|---|
| 7.1 | App shell: left nav, top status bar (profile, level ± xp confidence, faction/prestige, snapshot version, live WS badge), raid started/ended banner, toast stack | M5.2 | ✅ |
| 7.2 | **Tonight's Plan**: raid cards (map, batch w/ per-task reasons + `anyMap` badge, level before→after, red foresight warnings w/ consequence text, prep list = quartermaster items bucketed to the raid they're needed by), free-tasks strip, level-stall strip, horizon control, replan-freshness indicator (fetched-at + plan hash + STALE flag between `raid.ended` and `plan.updated`) | M5.2 | ✅ |
| 7.3 | **Goals dashboard**: goal picker (Kappa / Lightkeeper / level N / custom tasks), weights editor (map-aversion sliders ×0.25–×4 incl. "Hate Lighthouse" preset ×4), Kappa/LK progress bars from `/api/graph/summary` (+ `/api/state` task counts), pending `/api/foresight` warnings | M5.3 | ✅ |
| 7.4 | **Story tracker** ported from `auto-tracker/tarkov-story-tracker.tsx` onto live `/api/story`: chapter progress + next-stage highlight, ending probability grid + LOCKED badge, decision-point modal w/ per-option consequences, imminent-decision warnings, branch-conditional stage visibility, reset | M5.3 | ✅ |
| 7.5 | **Quartermaster view**: route-kind groups (flea/trader/barter/craft/FIR) w/ group costs, totals header (₽ / lines / units / FIR / crafts), craft schedule w/ startBy, per-item "why" expander (machine reasons → readable lines + alternatives) | M5.4 | ✅ |
| 7.6 | **Map view v1**: latest position + history (WS `position` events, `/api/state` fallback), tarkov.dev deep links (`/map/<normalizedName>`), empty state explaining the screenshot keybind | M5.5 (v1) | ✅ |
| 7.7 | **Insights view**: survival by map/hour/duration tables, session rhythm, flea-income inline-SVG sparkline + net-worth caveat line, fingerprint card (features + explanations + sample sizes); "low n" badges everywhere the package flags `lowConfidence` | M7 surface | ✅ |
| 7.8 | **Environment view**: per-profile settings diff table (current vs recommended + why), apply button w/ inline 409 "game running" handling, NVIDIA card, per-map perf percentiles + regression badge (hover = reasons), ammo tier lookup by caliber (datalist of common calibers) | M6 surface | ✅ |
| 7.9 | **Onboarding modal** on untouched profile (level ≤1, 0 completed): quiz → `POST /api/state/manual`; TarkovTracker token → `POST /api/state/import/tarkovtracker`; historical backfill → `POST /api/state/backfill` w/ result summary | M2.6 surface | ✅ |
| 7.10 | Infra: typed fetch client w/ error→toast mapping, reconnecting WS hook (1 s→10 s backoff) over a pure frame router, context store (no redux), client-local story progress per profile | — | ✅ |

## Acceptance evidence
- **69/69 vitest cases green**; `tsc --noEmit` clean (src + test); `vite build` produces `dist/` (build gate for Wave-4 serving).
- Smoke-tested the production build in a browser with **no service running**: all six views + shell render well-formed empty states, zero console errors, error toasts fire for failed fetches, WS badge shows OFFLINE and reconnects on backoff. The UI must never crash on a dead daemon — verified.
- M5.2 "usable at glance distance": raid map name 26 px/800 weight, batch lines 17 px, warnings red-on-dark boxes.
- M5.3 "story tracker feature-parity with artifact v2": chapter progress ✅, ending compatibility matrix + prediction ✅ (8 prediction tests at parity), decision-point warnings + modal ✅, next-task highlight ✅, reset ✅. See deviation on probability priors below.
- Live acceptance (plan renders from a real profile, position <2 s after screenshot, WS replan loop) is an integration-wave item — requires `apps/service`.

## Test map (`apps/web/test/`, node env, no jsdom / network / game files)
| File | Covers | Cases |
|---|---|---|
| `client.test.ts` | URL building, `{error}` body mapping, non-JSON errors, network→status 0, 409 `isConflict`, onError hook, POST headers | 9 |
| `frames.test.ts` | WS frame parse (malformed included), routing of all §3 events + `plan.updated`/`hello`/unknown, notice normalization | 9 |
| `planView.test.ts` | `neededByRaid` (FIR raidIndex / `needed-by:raid-N` / default), warning attachment (embedded / array-by-completing-task / record-by-index), consequence text w/ Kappa-LK tags, VM merging (prep buckets, levelUps, filler, null-safety) | 12 |
| `story.test.ts` | **8 ending-compatibility predictions** (artifact parity: refuse-Kerman→Survivor 100 · work-with→Survivor locked · refuse-evidence→Fallen 100 · gather→50/50 · deliver-all→Savior 100 · withhold→Debtor 100 · no-decisions→25×4 · case-choice locks nothing), branch visibility, chapter/overall progress, decision warnings + imminence, consequence strings | 15 |
| `quartermasterView.test.ts` | route grouping/order, group + header totals, machine-reason translation, unknown-reason passthrough | 7 |
| `normalize.test.ts` | tolerant readers for `/api/state`, `/api/graph/summary` (SPEC-invariant fallbacks 257/102), settings diffs, perf rows, insights raids/economy | 10 |
| `maps.test.ts` | map key resolution (id/nameId/name), `any`/unknown-hex display, tarkov.dev deep links, sparkline path, formatters | 7 |

## Design decisions
- **Standalone types + tolerant normalizers.** CONTRACTS pins semantics but not every field name for `/api/state`, `/api/graph/summary`, `/api/environment/settings`, `/api/insights/*`. `src/lib/normalize.ts` accepts the plausible shapes (documented below) and degrades to well-formed empties — shape drift between parallel-built apps shows an empty state, never a crash. Where totals are missing, Kappa/LK fall back to the SPEC M1.6 invariants (257/102).
- **Pure logic out of React.** Frame routing, plan view-model, story predictor, quartermaster grouping, normalizers and the client are plain functions — that is where the tests live; DOM render tests were skipped (jsdom not preinstalled, low marginal value over the VM tests).
- **Story progress is client-local for now** (localStorage keyed per profileKey, merged under any server-provided `playerStatus`). The service does not yet expose story-progress writes; when it does, the store swaps `setStageDone/setDecision` to POSTs without touching the views.
- **Prep-list bucketing contract:** an acquisition item belongs to raid N when `route.raidIndex === N` (find-in-raid) or a machine reason `needed-by:raid-N` is present; otherwise raid 1 ("have it before the session"). Documented for the quartermaster/service builders.
- **Plan staleness model:** `raid.ended` sets STALE immediately (banner + indicator); `plan.updated` (or the store's own refetch) clears it. The freshness line always shows fetched-at + the plan hash from §5.2.
- **409 handling is view-local, not a toast:** the Environment apply button renders the "game running — nothing was changed" box inline; the shared client's toast hook deliberately skips `isConflict`.
- **Map registry is static** (16 maps from the committed 1.0.6 snapshot incl. nameIds like `bigmap`/`sandbox`): resolves planner ids, log nameIds, and display names; unknown keys degrade to a readable handle so a new patch never crashes the UI.

## Deviations (documented)
1. **Story ending probabilities are data-derived, not the artifact's hand-tuned priors.** The artifact guessed (e.g. "kept the case → Savior 40%"); this port computes the outlook from the verified decision graph (`locksEndings`/`setsOnlyEnding`): reachable endings split 100% evenly, locked endings are 0%. Consequence: the armored-case choice shows 25×4 (it verifiably locks nothing) where the artifact showed 40/10/25/25, and gather-evidence shows Savior/Debtor 50/50 where the artifact jumped to Savior 100 (the real game still has the final hand-over decision). Same predictive surface, grounded instead of vibes — and the artifact's *decided-path* predictions (rows 2, 4, 6, 7 in the test table) agree exactly.
2. **M5.5 route overlay not in v1** (per SPEC.md §4.1 open question — no navmesh data). v1 = position, history, deep links; overlay lands with the waypoint-graph decision in P4.
3. **NL goal box → agent** (CONTRACTS §6 wording) is not wired: the agent chat endpoint is proxied by the service, but goal intake UX belongs with the agent-chat surface (integration wave). The structured picker covers M3.1 goal composition.
4. **Optional route probe:** the Goals custom-task search tries `GET /api/graph/tasks?q=` — **not a contracted route**; on 404 it permanently falls back to manual task-id entry. Service builder may implement it as a documented extension (`[{ id, name }]`, ≤50 hits); nothing breaks if absent.

## Assumed shapes for service-defined payloads (integration-wave arbitration list)
The normalizers accept, in order of preference:
- `/api/state`: `{ level | xp.level, faction|pmcFaction, prestige, gameMode|mode, progressEpoch|epoch, tasks: rows[]|record, completedTasks[]/failedTasks[], xp: { xp, confidence: { low, high } }, positions|positionHistory: [{ map,x,y,z,filename,ts }] }`.
- `/api/graph/summary`: `{ taskCount|tasks|totalTasks, kappa: { total, remaining, done? } | kappaTotal/kappaRemaining/kappaDone, lightkeeper likewise }`.
- `/api/environment/settings`: `{ profiles|diffs: { <profile>: SettingDiff[] } }` or the bare `diffAllProfiles()` record `{ <profile>: SettingDiff[] }`.
- `/api/environment/perf`: `PerfMapRow[]` or `{ maps|rows: [...] }`, regression as `regressed: boolean` or `{ regression: { regressed, reasons[] } }`.
- `/api/environment/ammo`: `AmmoEntry[]` or `{ table|ammo: [...] }`.
- `/api/insights/raids`: `{ survivalByMap|byMap, survivalByHour|byHour (rows/excluded), survivalByDuration|byDuration, queuePatterns|queues|queue, sessionRhythm|rhythm }` (insights-package shapes).
- `/api/insights/economy`: `{ income|fleaIncome, netWorth|netWorthEstimate }`.
- `/api/plan` warnings: embedded per-raid `warnings[]` (preferred), a plan-level array matched by `completing.id ∈ batch`, or a record keyed by raid index.
- WS `notice`: object `{ message|text, title?, level? }` or bare string.

## Notes for the integration wave
- Serve `apps/web/dist` at `/` (CONTRACTS §1); SPA has no client-side routes — a plain static mount with `index.html` fallback is enough.
- The UI reads `hash`, per-raid `warnings`, and `generatedAt` from `GET /api/plan` if present — attach them (§5.2 "foresight warnings attached per raid + plan hash").
- `POST /api/environment/settings/apply` success payload: `{ backupId?, applied? }` is displayed; 409 body message is not shown verbatim (fixed friendly copy) so any `{ error }` shape is fine.
- Consider implementing `GET /api/graph/tasks?q=` (deviation 4) — the picker upgrades itself automatically.
- Story-progress persistence endpoint (future): swap points marked in `src/store.tsx`.
