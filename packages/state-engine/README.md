# @tac/state-engine

The player model (SPEC **M2**): a local-first, per-profile SQLite store fed by
passive, read-only observation of what Escape from Tarkov writes to disk —
log streams, screenshot filenames — plus an optional TarkovTracker mirror.
Downstream, `@tac/planner` consumes `toPlayerState()` and `@tac/insights`
queries the same SQLite file read-only (schema contract: CONTRACTS §4).

## Risk tier

- **T1 (passive read of game-written files):** log discovery/tailing
  (`src/logs/*`), historical backfill, screenshot watcher. Read-only on
  everything under the game install and Documents; never touches the EFT
  process, memory, input, or window; polling never faster than 1 s.
- **T0 (outside the game):** store, XP estimator, TarkovTracker mirror, journal.

## What's inside

| Module | Purpose |
|---|---|
| `db.ts` | `node:sqlite` open + migrations — exact CONTRACTS §4 DDL |
| `store.ts` | `openProfile(profileKey, {dir\|memory})` → `ProfileStore`: tasks/objectives/hideout/traders/meta (level, xpOffset, prestige, faction, progressEpoch, goals, weights), `toPlayerState()`, `importTarkovTracker()` / `exportTarkovTracker()`, typed CONTRACTS §3 emitter |
| `logs/discover.ts` | install detection (registry → known path → `TAC_EFT_PATH`), session-folder enumeration/ordering, version extraction, per-stream file mapping (substring, rotation-aware) |
| `logs/parse.ts` | pure parsers: line framing + multi-line JSON payloads; quest types 10/11/12, flea sales (type 4), raid notifications (`userMatchCreated`/`userConfirmed`/`userMatchOver`), session mode, profile, map bundles, GameStarting/Started, menu returns |
| `logs/raids.ts` | `RaidAssembler`: event stream → raid lifecycle (queue/confirm/start/end, reconnect via shortId, inferred ends via menu return) |
| `logs/tail.ts` | ≥1 s polling tail, byte-offset resume, rotation/truncation tolerant, survives files held open by the game |
| `logs/watcher.ts` | live watcher: newest-session discovery + switching, cursor persistence, feeds store + events, `patch.detected` when folder version ≠ snapshot version (M8.1) |
| `backfill.ts` + `cli/backfill.ts` | M2.3 one-command history replay, oldest → newest, `(profileId, version)` breakpoints, idempotent |
| `screenshots.ts` | M2.4 position+quaternion from screenshot filenames; chokidar watch with folder-creation re-arm (folder doesn't exist until the first in-game screenshot) |
| `xp.ts` | M2.5 estimator: exact task XP + documented raid-outcome heuristics + calibration anchors → `{level, xp, confidence:{low,high}}` |
| `tracker.ts` | M2.7 TarkovTracker mirror: token from `data/local/config.json`, `GET /progress` import, debounced single-batch pushes, progressEpoch guard, 401/backoff resilience, injectable `fetch` |
| `journal.ts` | M2.8 raid journal readers + `setRaidOutcome` |

## Honest limitations (by design, from research/03)

- Logs contain **no** survived/died/extract/XP/level/hideout signal. Raid
  outcomes land as `unknown` (manual/OCR can upgrade them); level is an
  **estimate** with a confidence band that collapses on calibration.
- `flea.sale.itemName` carries the sold item's 24-hex **item id** (logs have
  ids, not names); resolve display names via `@tac/data-core`.
- The TarkovTracker **real-account round-trip is deferred** — no token exists
  on this machine yet. All mirror behavior is tested against a mocked `fetch`.

## How to test

```
pnpm --filter @tac/state-engine typecheck
pnpm --filter @tac/state-engine test        # 43 tests, fixtures = sanitized real logs (1.0.1 → 1.0.6)
```

Real-machine smoke (read-only on the game, writes a scratch DB):

```
pnpm --filter @tac/state-engine exec tsx src/cli/backfill.ts --profile-key smoke-regular --db-dir /tmp/profiles
```

Fixtures under `test/fixtures/Logs/` are verbatim excerpts of real sessions
with profile/account/session ids replaced by fake hex values.
