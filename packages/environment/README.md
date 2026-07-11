# @tac/environment

Environment & Meta (SPEC module **M6**). Everything around the game, nothing inside it: EFT settings advisor + safe apply, NVIDIA guidance, PresentMon frame-telemetry ingestion, and the ammo meta feed for briefings.

## Risk tiers (declared per module, policy in SPEC.md §1)

| Module | Tier | Why |
|---|---|---|
| `eft-settings.ts` | **T1** | Read-only parse of the JSON settings files EFT itself writes (`%APPDATA%\Battlestate Games\Escape from Tarkov\Settings\*.ini`). |
| `profiles.ts` | **T0** | Pure data + diffing; never touches disk. |
| `apply.ts` | **T1-write** | Writes those same files — **only while the game is closed** (tasklist image-name check; refuses with a typed `GameRunningError` otherwise), only keys the in-game UI exposes, always after a timestamped backup into `data/local/backups/<id>/`. `restoreBackup(id)` reverses any apply byte-for-byte. |
| `nvidia.ts` | **T0** | `nvidia-smi` telemetry (tolerates absence) + static driver-profile guidance. Read-only this wave — no DRS writes. |
| `presentmon.ts` | **T0** | Parses CSVs the *user* captured with Intel PresentMon (ETW, external to the game). We never bundle, download, or launch capture binaries. |
| `ammo.ts` | **T0** | Reads the committed tarkov.dev snapshot only. |

Nothing here ever touches the EFT process, memory, input, or window. The game-running check is process *listing* (`tasklist /FI "IMAGENAME eq EscapeFromTarkov.exe"`), not process access.

## Pieces

- `eft-settings.ts` — loads `Graphics/Game/PostFx/Sound/Control.ini` (plain JSON despite the extension; verified against the real 1.0.6 files on this machine). Loose zod schemas (`partial().passthrough()`): BSG renames keys across patches and a missing field must never crash the advisor. `getSetting(settings, "Graphics.VSync")` flat-key access.
- `profiles.ts` — three curated profiles (`max-fps`, `balanced`, `max-visibility`), every setting with a rationale string. `diffSettings(current, profile)` → `{key, current, recommended, why}[]`; `diffAllProfiles` is the `/api/environment/settings` payload.
- `apply.ts` — `applyProfile(profile, opts)`: game-closed guard → backup touched files + `manifest.json` → read-modify-write only the differing keys (everything else preserved verbatim, including nested blocks like `DisplaySettings`). `listBackups()`, `restoreBackup(id)`.
- `nvidia.ts` — `detectGpu()` via `nvidia-smi --query-gpu` (null on AMD/CI); `nvidiaRecommendations(gpu)` guidance payload (Reflex, power mode, VSync off, shader cache, DLSS-off-at-1440p reasoning).
- `presentmon.ts` — `parsePresentMonCsv` (v1 `MsBetweenPresents` and v2 `FrameTime` layouts; filters other processes + dropped frames), `summarizeRun` → `{fps_avg, fps_p1, frametime p50/p95/p99}`, `toPerfSampleRow` shaped exactly for the `perf_samples` DDL (CONTRACTS §4), `detectRegression` vs a per-map baseline.
- `ammo.ts` — ammo tier table (S–F by penetration) from the real snapshot; `topAmmoForBriefing` gives the agent one-line recommendations with flea-ban sourcing notes.

## Recommendation sources

Profiles and NVIDIA guidance are grounded in [docs/research/06-environment-paths.md](../../docs/research/06-environment-paths.md) (field inventory verified on this machine, EFT 1.0.6 / RTX 3080) plus long-standing community performance consensus for EFT as a CPU-bound Unity title (EFT wiki "Game settings" page; widely-circulated competitive configs and r/EscapefromTarkov guides): shadows/visibility/LOD dominate frame time, SSR/SSAO/volumetrics/PostFx are GPU taxes, VSync off + Reflex on for latency, Clarity/LumaSharpen/grass-shadow-off for spotting. Ammo tiers follow the tarkov.dev/wiki convention of grouping by highest armor class reliably defeated.

## PresentMon setup (user-run, never bundled)

1. Download PresentMon from Intel's GitHub releases: <https://github.com/GameTechDev/PresentMon> (the single `PresentMon-*.exe` is enough).
2. Capture while playing (run from an elevated terminal):

   ```powershell
   .\PresentMon.exe -process_name EscapeFromTarkov.exe -output_file raid.csv -stop_existing_session
   ```

   Stop with `Ctrl+C` after the raid (or add `-timed 600` for a fixed window).
3. Feed `raid.csv` to the ingestion (service route, or directly: `parsePresentMonCsv` → `summarizeRun` → `toPerfSampleRow`). The row lands in `perf_samples` tagged with the current map + raid.

**Regression threshold (documented):** a run regresses vs its per-map baseline when `fps_avg` **or** `fps_p1` drops more than **10% relative AND more than 5 FPS absolute**. `fps_p1` catches "same average, new stutter" — the usual post-patch signature; the double floor keeps spawn/PMC-density variance from spamming alerts.

## How to test

```bash
pnpm --filter @tac/environment typecheck
pnpm --filter @tac/environment test
```

46 tests: settings parser vs a sanitized fixture copy of the real 1.0.6 files (plus the live dir when present, read-only), diff engine, apply refusal with an injected "game running" check, backup/restore round-trip in a temp dir (tests never point at the real install), PresentMon parser vs an authored realistic CSV, ammo tiers spot-checked on the real snapshot (M855A1 pen > M855).
