# SPEC-2 — State Engine (auto-state)

> Phase spec derived from [SPEC.md](../../SPEC.md) module **M2** (M2.1–M2.8) + platform patch detection **M8.1**. Status: **CORE COMPLETE (2026-07-11)**; OCR-assisted capture (M2.6) and the real-account TarkovTracker round-trip pending.

## Objective
Make player state ≥90% automatic: observe everything EFT writes to disk (read-only, tier T1), reconstruct the past from log history, estimate what the logs can't say, and keep the local store — not any web service — as the source of truth.

## Scope (`packages/state-engine`)
Per-profile SQLite store (CONTRACTS §4 DDL, `node:sqlite`), log discovery/tailing/parsing, live watcher + patch detection, historical backfill, screenshot-position watcher, XP estimator, TarkovTracker mirror, raid journal, CONTRACTS §3 typed event emitter.

## Deliverables & status
| ID | Deliverable | Status |
|---|---|---|
| 2.1 | `openProfile()` → `ProfileStore` (tasks, objectives, hideout, traders, meta: level/xpOffset/prestige/faction/progressEpoch/goals/weights/cursor), `toPlayerState()`, lossless TarkovTracker import/export | ✅ |
| 2.2 | Log watcher: registry/known-path install detection, session discovery + mid-run switching, ≥1 s polling tail with byte-offset resume + rotation tolerance, parsers for quest 10/11/12, raid lifecycle, flea sales, mode/profile/map | ✅ |
| 2.3 | Backfill: one command replays all sessions oldest→newest with (profileId, version) breakpoints; idempotent; CLI `src/cli/backfill.ts` | ✅ |
| 2.4 | Screenshot watcher: position + quaternion→yaw from filenames; folder-creation re-arm; positions journaled + emitted | ✅ |
| 2.5 | XP estimator: exact task XP + configurable raid heuristics + calibration anchors → `{level, xp, confidence}` | ✅ |
| 2.6 | Manual/OCR-assisted capture | ⏳ manual setters + calibrations table exist; OCR later (T2) |
| 2.7 | TarkovTracker mirror: config-token, import seed, debounced single-batch writes, epoch guard + re-read reconcile, 401/backoff resilience, injectable fetch | ✅ (mocked; real-account round-trip deferred — no token on this machine) |
| 2.8 | Raid journal (map, mode, queue/duration, source, version) + outcome upgrade API | ✅ |
| 8.1 | `patch.detected` when log-folder version ≠ active snapshot version | ✅ |

## Acceptance (met)
- **43/43 tests green** (typecheck strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`).
- **M2.2 replay on real logs:** fixtures are verbatim sanitized excerpts of four real sessions (1.0.1.1, 1.0.5.0 ×2 — including both 2026-05-25 sessions — and 1.0.6.0). The 2026-05-25 Ground Zero raid and the 2026-07-11 Factory session (3 raids, one clean `userMatchOver`, 2 quest transitions) replay end-to-end into correct journal rows, task state, and §3 events; re-pump produces zero duplicates.
- **M2.3 on the real machine:** backfill over the full install history — 54 sessions, 1.0.1→1.0.6 — reconstructs 104 raids across 11 maps, 91 quest events, 117 flea sales (₽15.49 M); immediate re-run applies 0 of each (idempotent).
- **M2.1 round-trip:** TarkovTracker progress fixture imports and re-exports losslessly (tasks, objective counts, hideout modules via the `<stationId>-<level>` id scheme, level/faction/edition/displayName).
- **M2.5:** calibration ("I am level 4") pins the estimate exactly at the anchor; post-anchor tasks are exact; only raid heuristics widen the band.
- **M2.7:** batching (N queued → one `POST /progress/tasks`), 401 self-disable with queue retention, exponential backoff + recovery, epoch guard dropping stale writes and reconciling via `GET /progress` — all against injected fetch, zero network in tests.

## Design decisions
- **Raid ends are frequently unlogged.** `userMatchOver` appeared in only some real sessions (the game rotates its push websocket); the assembler falls back to the post-raid menu return (`Init: pstrGameVersion`) as an *inferred* end — every raid still gets duration and a journal row.
- **Outcomes stay `unknown` from logs, honestly.** Grep-verified: no survived/died/extract/XP signal exists in any stream. `setRaidOutcome` is the upgrade path for M2.6 manual/OCR. No fake inference.
- **`userMatchCreated`/`userConfirmed` (1.0-only push events, unused by incumbent tools)** drive queue-time measurement and early map/server detection.
- **Reconnects** (same 6-char `shortId` re-confirmed) fold into the existing raid instead of duplicating it.
- **Scav raids** surface under a different per-raid profileid inside the same session; sessions are attributed to the PMC profile (`CompleteSelectedProfile`), scav raids are journaled with the session.
- **Store emits, everything else feeds.** One `EngineEmitter` per store carries the entire §3 vocabulary — the service's WS layer can subscribe to a single object.
- **Idempotency everywhere** (quest events on (task,status,ts), raids on sid, flea on (item,amount,ts)) makes live-tail + backfill + re-runs freely composable.

## Known limitations
- Hideout/trader/skill state has no log signal — seeded by TarkovTracker import or manual setters until OCR (M2.6, tier T2) lands.
- `flea.sale.itemName` is the item **id**; name resolution belongs to data-core consumers.
- Log timestamps are local-time ISO without zone (1.0 dropped the offset); ordering is consistent within a machine, which is the only place logs exist.
- Real-account TarkovTracker sync unverified pending a token; the wire format follows the live OpenAPI-documented v2 endpoints.
