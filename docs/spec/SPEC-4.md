# SPEC-4 — Environment & Meta (M6)

> Phase spec derived from [SPEC.md](../../SPEC.md) module **M6** (P4). Status: **PACKAGE COMPLETE (2026-07-11)** — `packages/environment` built and tested; service routes (§5.4) and web surface land with `apps/service`/`apps/web`. M7 insights is documented separately in SPEC-5.

## Objective
Total control over the *environment around* the game — settings, driver, frame telemetry, ammo meta — at tier T0/T1 with zero game-process contact (the SPEC §1 posture: read everything the game writes, write only what the in-game UI itself exposes, game closed, backed up).

## Scope (`packages/environment`)
Settings advisor + safe apply (M6.1), NVIDIA read-only advisor (M6.2), PresentMon ingestion + regression detection (M6.3), ammo tier feed (M6.4).

## Deliverables & status

| ID | Deliverable | Tier | Status |
|---|---|---|---|
| 4.1 | `eft-settings.ts`: locate + parse `%APPDATA%\Battlestate Games\Escape from Tarkov\Settings\{Graphics,Game,PostFx,Sound,Control}.ini` (plain JSON; research/06 §1) into a typed model of the perf/visibility fields; loose zod (`partial().passthrough()`) so patch-time key churn never crashes | T1 | ✅ validated against the real 1.0.6 files on this machine |
| 4.2 | `profiles.ts`: 3 curated profiles (`max-fps` / `balanced` / `max-visibility`), per-setting rationale strings; diff engine `{key, current, recommended, why}[]` + `diffAllProfiles` (the §5.4 payload) | T0 | ✅ |
| 4.3 | `apply.ts`: game-closed guard (`tasklist` image-name query → typed `GameRunningError`, service maps to 409), timestamped backup to `data/local/backups/<id>/` (+ manifest.json) before any write, read-modify-write preserving all untouched keys, `restoreBackup(id)` byte-for-byte, `listBackups()` | T1-write | ✅ |
| 4.4 | `nvidia.ts`: GPU/driver detection via `nvidia-smi` (injectable runner; null on absence), recommendation payload (Reflex/power-mode/VSync/shader-cache/DLSS guidance per research/06 §4) — **read-only this wave**, DRS writes deferred | T0 | ✅ |
| 4.5 | `presentmon.ts`: CSV parser (v1 `MsBetweenPresents` + v2 `FrameTime` layouts; process filter, dropped-frame skip) → `{fps_avg, fps_p1, frametime p50/p95/p99}`; `toPerfSampleRow` shaped exactly for the `perf_samples` DDL (CONTRACTS §4); per-map regression detector | T0 | ✅ |
| 4.6 | `ammo.ts`: tier table (S–F by penetration) from the committed 1.0.6 snapshot; caliber filter + `topAmmoForBriefing` for M6.4 briefings | T0 | ✅ |
| 4.7 | Service routes `GET/POST /api/environment/*` (§5.4) + web Environment view | — | ⏳ apps wave |
| 4.8 | NVIDIA DRS per-app profile *writes* (NVAPI / nvidiaProfileInspector `.nip`) | T0 | ⏳ deferred — needs the recon workflow's DRS setting-ID reference; advisor text ships now |
| 4.9 | Live-settings echo from `application.log` (`Game settings:` dump) as a second read path | T1 | ⏳ optional; on-disk files already cover every advised key |

## Acceptance (M6 rows)

- **M6.1** — parser + diff + apply-with-backup shipped; apply refuses while `EscapeFromTarkov.exe` is listed (or when the check can't run — fail-closed). *"Apply→launch→verify loop"* remains a manual acceptance once the service route lands. **Met at package level.**
- **M6.2** — detection + recommendations shipped read-only; *apply/verify via NVAPI* deferred to 4.8 (deviation recorded below). **Partially met by design this wave.**
- **M6.3** — FPS percentiles per run in `perf_samples` shape; regression threshold documented (>10% relative **and** >5 FPS absolute on `fps_avg` or `fps_p1` vs per-map baseline). **Met** (service wiring pending).
- **M6.4** — ammo tiers from current-patch data; spot-check M855A1 (pen 44, tier B) > M855 (pen 31, tier D) on the real snapshot. **Met.**

## Test evidence
**46/46 tests green** (`pnpm --filter @tac/environment test`): fixture + live-file settings parsing, diff engine, apply refusal (injected process check), backup/restore round-trip in a temp dir (tests never touch the real install), PresentMon v1/v2 parsing + hand-computed percentiles, regression thresholds, ammo tiers on the real snapshot. Typecheck green under strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.

## Design decisions
- **Fail-closed apply.** If the tasklist check itself errors (non-Windows CI, locked-down shell), we report "running" and refuse to write. Never write when we cannot prove the game is closed.
- **Never invent files.** The diff/apply layer skips profile keys whose settings file is absent — a fresh install that hasn't written `PostFx.ini` yet gets no synthetic file.
- **Loose schemas at the boundary.** Settings zod models are `partial().passthrough()`: we type only what we reason about, preserve everything (including nested `DisplaySettings`) verbatim on write, and survive BSG key churn without a patch-day crash.
- **`fps_p1` = 1000 / p99 frametime** (standard "1% low" approximation) — checked alongside `fps_avg` because post-patch regressions usually show as stutter, not lower averages.
- **PresentMon is user-run.** We parse CSVs only; no binary bundling/downloading/launching (README documents the two-line capture command).
- **Ammo tiers by penetration bands** (S ≥54 … F <20), matching the community "highest armor class reliably defeated" convention; `totalDamage = damage × projectileCount` so buckshot ranks honestly; flea-banned rounds carry a sourcing note for briefings.

## Deviations from CONTRACTS/SPEC
- **M6.2 "profile applied & verified"** — this wave ships detection + guidance only. Rationale: DRS writes need exact NVAPI setting IDs (recon report pending) and a write path (`nvidiaProfileInspector` shell-out or N-API helper) that must clear the no-native-deps rule; advisor value ships now, writes are additive later (4.8).
- None otherwise — DDL shape, tier annotations, backup location (`data/local/`), and fixture hygiene all follow CONTRACTS §2/§4/§9.

## Notes for downstream waves
- `apps/service`: map `GameRunningError` (`.code === "GAME_RUNNING"`) → HTTP 409 on `POST /api/environment/settings/apply`; `diffAllProfiles(loadEftSettings())` is the GET payload; `toPerfSampleRow` output inserts directly into `perf_samples` (state-engine owns the DB handle).
- `apps/agent`: `topAmmoForBriefing(table, caliber)` returns briefing-ready one-liners; `nvidiaReport()` and settings diffs are cite-able tool outputs.
- Per-map baselines for `detectRegression` are an SQL aggregate (median of prior runs on same map+version) — insights/service owns that query; the detector is pure.
