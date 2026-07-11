# Local Environment & Paths — First-Hand Recon (2026-07-11)

> Verified directly on Kaden's machine. EFT `1.0.6.0.46010`, Arena `0.5.2.0.46045`, RTX 3080 (driver 610.62). A web-sourced companion brief (ToS/anti-cheat, Overwolf/Blitz, NVAPI, telemetry) is landing separately from the recon workflow and will be folded into this file + a compliance doc.

## 1. Escape from Tarkov — main game

**Install (game binaries + logs):** `C:\Battlestate Games\Escape from Tarkov\`
- `EscapeFromTarkov.exe`, `EscapeFromTarkov_BE.exe` (BattlEye launcher), `BattlEye\`, `GameAssembly.dll`, `UnityPlayer.dll`, `EscapeFromTarkov_Data\`
- `Logs\` — per-session folders `log_<date>_<time>_<version>\` (e.g. `log_2026.07.11_6-32-50_1.0.6.0.46010`). Steam installs nest under `...\build\Logs\`.
- `Logging.config` (log verbosity control) at the install root.

**Settings (all plain JSON despite `.ini`):** `%APPDATA%\Battlestate Games\Escape from Tarkov\Settings\`
| File | Controls |
|---|---|
| `Graphics.ini` | resolution, fullscreen mode, texture/shadow/clouds quality, VSync, **frame caps (`GameFramerate`, `LobbyFramerate`, `DisableGameFramerateLimit`)**, `NVidiaReflex`, DLSS/FSR mode + preset, SSR/SSAO/AA, `AnisotropicFiltering`, `OverallVisibility`, `LodBias`, `ShadowDistance`, mip streaming |
| `PostFx.ini` | `EnablePostFx`, Brightness, Saturation, Clarity, `LumaSharpen`, `AdaptiveSharpen`, ColorFilter, colorblindness |
| `Game.ini` | `FieldOfView`, `HeadBobbing`, `StreamerModeEnabled`, `SetAffinityToLogicalCores`, `AutoEmptyWorkingSet`, `EnableHideoutPreload`, quest-item notify/search, UI/HUD prefs |
| `Control.ini` | mouse sensitivity (`MouseSensitivity`, `MouseAimingSensitivity`, `OpticSensitivity`), invert, and the full `axisBindings` / keybind arrays |
| `Sound.ini` | audio config |

**Screenshots (position-encoded filenames):** `%USERPROFILE%\Documents\Escape From Tarkov\Screenshots\` — **does not exist until the first in-game screenshot**; watcher must arm on folder-creation. Filename format encodes `x, y, z` + rotation quaternion.

**Launcher:** `%LOCALAPPDATA%\Battlestate Games\BsgLauncher\` (`CefCache\`, `Logs\`).

**Live settings echo:** at startup the client also dumps `Game settings:`, `Sound settings:`, and `Control settings:` (full keybind JSON) into `application.log` — so FOV and the screenshot keybind are readable from the log stream too, no file read needed.

## 2. Escape from Tarkov Arena (separate game)

**Install:** `C:\Battlestate Games\Escape from Tarkov Arena\` — own `EscapeFromTarkovArena.exe`, `_BE.exe`, `BattlEye\`, `D3D12\`, `cache\`, `Logs\` (`log_<date>_<time>_<version>`, e.g. `..._0.5.2.0.46045`), own `Logging.config`.

**Settings:** `%APPDATA%\Battlestate Games\Escape from Tarkov Arena\Settings\` — same JSON files as EFT **plus `Regions.ini`** (matchmaking regions). Mirrors the main-game format, so a single config module handles both games with a game selector.

**Presets:** `%APPDATA%\Battlestate Games\EFT Arena\Presets\` (loadout presets; currently empty).

**Arena↔main crossover** (from game-state research): one-way Arena→PvE progression, Ref transfer service (GP coins ~250/day, roubles w/ tax). Arena Armory survives prestige. Treat Arena as a distinct profile in state schema.

## 3. Config-write safety

Editing these JSON files **while the game is closed**, changing only values the in-game UI itself exposes, with a backup first, is player-normal (T1-write in the risk model). What is on disk is client-side (graphics/FOV/keybinds/postfx); gameplay-affecting values live server-side and are not here. Do **not** edit beyond the UI's value ranges (unverified anti-cheat/consistency risk — `ConsistencyInfo` file exists in the install root). The recon workflow is confirming community consensus on which edits persist vs. get overwritten on launch.

## 4. NVIDIA 3D Settings — programmatic surface (all T0, fully outside the game)

**Hardware:** GeForce RTX 3080, 10 GB, driver 610.62, VBIOS 94.02.71.40.66.

**Where "Manage 3D Settings" persists:** `C:\ProgramData\NVIDIA Corporation\Drs\` — `nvdrsdb0.bin` / `nvdrsdb1.bin` (the Driver Settings profile DB, ~2.5 MB each), `nvdrssel.bin`, `nvAppTimestamps`. Global + per-application profiles (keyed to `EscapeFromTarkov.exe` / `EscapeFromTarkovArena.exe`) live here.

**Runtime present:** `C:\Windows\System32\nvapi64.dll` (NVAPI is installed) → the `NvAPI_DRS_*` API (CreateSession → LoadSettings → FindProfileByName/CreateProfile → SetSetting → SaveSettings) can read/write per-app 3D profiles. Access from TS via a small native helper (node-ffi/N-API to nvapi64.dll) or shell out to `nvidiaProfileInspector` with an exported `.nip`. `nvidia-smi` present for GPU telemetry (util/VRAM/clocks/power/temps) but it does **not** set 3D-profile settings.

**Registry:** `HKLM\SOFTWARE\NVIDIA Corporation\Global\` (subkeys incl. `DrsPath`, `NVTweak`, `NvApp`).

**EFT-relevant 3D settings to manage** (per-app profile): NVIDIA Reflex / Low Latency Mode, Power Management (Prefer Maximum Performance), Texture Filtering Quality, Threaded Optimization, Vertical Sync, Max Frame Rate, Shader Cache Size, DLSS/DLDSR, Anisotropic filtering, Preferred refresh rate. (DRS setting-ID reference + exact IDs are in the recon workflow's NVIDIA report.)

## 5. Telemetry & performance monitoring — safe-by-construction (T0)

All external, no game-process contact:
- **PresentMon (Intel, ETW-based):** frame time, FPS, GPU-busy, PC latency, dropped frames — captured from the OS event stream, no injection. Primary source.
- **Windows PDH / ETW counters:** per-process attribution (`\Process(EscapeFromTarkov)\% Processor Time`, Working Set, GPU Engine, GPU Process Memory) + system CPU/RAM.
- **NVML / nvidia-smi:** GPU util, VRAM, temps, clocks, power.
- **LibreHardwareMonitor:** CPU/GPU/thermal sensors.
- ⚠ **RTSS/Afterburner** render an in-game overlay via hooking — different (higher) risk class than the above; the companion uses external ETW instead. (Recon workflow confirming community safety record.)

Attribution: tag every frame/telemetry sample with the current map + settings hash + game version → per-map/per-patch regression detection (M6.3).

## 6. What this confirms for the build

Kaden's "underdeveloped game, everything on disk" instinct is correct: FOV, Reflex, every graphics value, mouse sensitivity, and all keybinds are readable/writable plain JSON; NVIDIA 3D settings are fully controllable out-of-process; performance is fully observable via ETW. The **entire environment- and settings-optimization pillar (M6) is achievable at tier T0/T1 — zero game-process contact, zero ban risk.**
