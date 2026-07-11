# Auto-Detection of EFT Game State — Research (2026-07-11)

> Sources: full source inspection of `the-hideout/TarkovMonitor` (last commit 2026-06-23) and `RatScanner/RatScanner` (2026-04-10), plus **first-hand inspection of live 1.0.6 logs on this machine** (`C:\Battlestate Games\Escape from Tarkov\Logs\log_2026.07.11_4-38-37_1.0.6.0.46010\`). The "what's in the logs" section is verified fact, not inference.

## 1. TarkovMonitor — what it parses

Repo: https://github.com/the-hideout/TarkovMonitor (C#/.NET, WinForms + Blazor WebView). Actively maintained for 1.0 (v1.11.1.0, 2026-06-23).

### Log discovery (NOT %LOCALAPPDATA%)
Logs live in the **game install dir**, `<install>\Logs\` (Steam: `<install>\build\Logs\`). Install found via registry:
- `HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\EscapeFromTarkov` → `InstallLocation` (BSG launcher)
- `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 3932890` → `InstallLocation` (Steam)

Per-session folder `log_yyyy.MM.dd_H-mm-ss` (1.0 adds version suffix: `log_2026.07.11_4-38-37_1.0.6.0.46010`). Monitors `application_000.log` and `push-notifications_000.log` via **substring** filename matching (survives BSG renames — `notifications` → `push-notifications`).

Master log-line regex (`GameWatcher.cs:113`):
```
(?<date>^\d{4}-\d{2}-\d{2}) (?<time>\d{2}:\d{2}:\d{2}\.\d{3})(?<tzoffset> [+-]\d{2}:\d{2})?\|(?<message>.+$)\s*(?<json>^{[\s\S]+?^})?
```
Each entry: `date time|version|Level|channel|message` + optional multi-line JSON payload. (tz offset gone in 1.0 — verified locally.)

### Detectable events (verified trigger strings)

| Event | Log | Trigger |
|---|---|---|
| PvP vs PVE mode | application | `Session mode: (?<mode>\w+)` → Regular/PVE |
| Profile/account ID | application | `Select(?:ed)?Profile ProfileId:(\w+) AccountId:(\d+)` (1.0: `CompleteSelectedProfile ...`) |
| Keybinds dump | application | `Control settings:` + JSON (full keyBindings; used to find `MakeScreenshot` bind) |
| Map identified | application | `scene preset path:maps\/(?<bundle>\w+)\.bundle` + bundle→map dict (incl. `labyrinth_preset`, `city_preset`→Streets, etc.) |
| Load/queue times | application | `LocationLoaded:...real:(...)` / `MatchingCompleted:...real:(...)` |
| Match found (server lock) | application | `TRACE-NetworkGameCreate profileStatus` → `Location:`, `RaidMode: Online`, `shortId: [A-Z0-9]{6}` (6-char raid ID; reused = **reconnect detection**). Verified live: `... Location: factory4_day, Sid: US-STL01G030_..., shortId: 0JJW2J` |
| Raid countdown / start | application | `GameStarting` / `GameStarted` |
| Matching aborted | application | `Network game matching aborted` or (1.0) `... cancelled` |
| Raid over | push-notifications | `Got notification \| UserMatchOver` + JSON (`location`, `shortId`) |
| Post-raid menus | application | `Init: pstrGameVersion:` after raid end |
| Group events (invite/ready/settings/leave) | push-notifications | `GroupMatchInviteAccept`, `GroupMatchRaidReady` (**full member loadouts**), `GroupMatchRaidSettings`, `GroupMatchUserLeave`, `GroupMatchWasRemoved` |
| **Quest started/failed/finished** | push-notifications | `ChatMessageReceived` with `message.type` **10/11/12**; quest ID = `templateId.Split(' ')[0]` (verified live: type 12 = `"<24-hex questId> successMessageText"`) |
| **Flea sale** (buyer, item, count, money) | push-notifications | `ChatMessageReceived` type 4, `templateId == "5bdabfb886f7743e152e867e 0"`; expired = `"5bdabfe486f7743e1665df6e 0"` |
| Player position | **screenshots folder** | see §3 |
| Game running | OS | polls `EscapeFromTarkov` process / 30 s |

`MessageType` enum (parseable, partly unused): `PlayerMessage=1, Insurance=2, FleaMarket=4, InsuranceReturn=8, TaskStarted=10, TaskFailed=11, TaskFinished=12, TwitchDrop=13`.

**Raid-type inference:** PMC vs Scav from the `GameStarting`→`GameStarted` gap (>3 s ⇒ PMC countdown). Airdrops/goons are NOT auto-detected (goons = manual report button → POST `api.tarkov.dev/goons` with consent; queue times auto-submitted opt-in to `/queue`).

### Push targets
- **TarkovTracker** (`TarkovTracker.cs`): Refit REST vs `https://tarkovtracker.org/api/v2` (domain selectable), bearer token, per-EFT-profile tokens (PvP/PVE separate). `POST /progress/task/{id}`, batch `POST /progress/tasks` (used by "Read Past Logs" backfill with (profileId, version) breakpoints). Locally fails mutually-exclusive quests via tarkov.dev `failConditions`. 15 req/min self-limit.
- **tarkov.dev maps remote-control** (`SocketClient.cs`): websocket `wss://socket.tarkov.dev?sessionid={remoteId}-tm`; sends `{"type":"command","data":{"type":"map","value":...}}` on raid load and `{"type":"command","data":{"type":"playerPosition","map":...,"position":{x,y,z},"rotation":yawDeg}}` on screenshot.

## 2. What's IN the logs vs NOT (1.0-verified)

**IN (verified first-hand):** profile/account ID, PvP-vs-PVE mode, game version, **full Game settings JSON (incl. FOV, language, StreamerMode)**, Sound settings, **all keybinds**, map bundle, load/queue times, server IP/datacenter, raid shortId, GameStarting/Started, raid-over with map, quest status transitions (started/failed/finished + IDs), flea sales with amounts, group events with full teammate loadouts, insurance/Twitch-drop messages. New 1.0 files: `backend_000.log` (every BSG HTTPS request URL — `gw-pvp.escapefromtarkov.com/client/...` — URLs only), `network-messages`, `errors`.

**NOT in logs (grep-verified zero hits for `survived|runthrough|killedby|experience|extract|exitName|exitStatus` in a real raid session; confirmed by TarkovMonitor FAQ):**
- Quest **objective** progress mid-raid (kill counts, partial hand-ins) — only whole-task transitions, pushed out-of-raid.
- Items looted, kills, deaths, extract used, run-through vs survived, XP earned, **PMC level**.
- **Hideout construction/upgrades** — zero log events (why no tool auto-tracks hideout).
- Stash contents / inventory.

**In-raid silence:** between `UserConfirmed` and `UserMatchOver`, logs are near-silent. The only in-raid signal is the screenshot trick.

**1.0 logging changes (verified):** folder version suffix; `{timestamp}_{version} ` filename prefix + `_000` counters; `notifications.log` → `push-notifications_000.log`; tz offset dropped; `SelectProfile` → `CompleteSelectedProfile`; "matching cancelled" variant; new backend/network-messages/spatial-audio/assetBundle/files-checker/output logs; Steam path `<install>\build\Logs`. **New 1.0 push events `UserMatchCreated` and `UserConfirmed`** (pre-raid server+map assignment) — **unused by every existing tool; free differentiation win.**

## 3. Screenshot-position trick — confirmed working in 1.0

EFT writes screenshots to `%USERPROFILE%\Documents\Escape From Tarkov\Screenshots\` with position+rotation **in the filename**: `YYYY-MM-DD[HH-MM]_x, y, z_qx, qy, qz, qw... (N).png` — 2-decimal Unity world coords + rotation quaternion → yaw. Map identity from the log stream. Works **mid-raid** (client-side file write on keypress). Whole 1.0-era tool crop built on it: TarkovPilot (feeds tarkov-market live map + TarkovPilotSync squad sharing), tarkov.nexus, tarkovquestie.com, TarkovMapTracker. Caveats: screenshots accumulate; `MakeScreenshot` key must be bound (detectable from `Control settings:` log dump).

## 4. RatScanner

Repo: https://github.com/RatScanner/RatScanner (C#/.NET, WPF + Blazor overlay). Maintained: v3.8.6 fixed name-scan for 1.0 four days after launch; v3.9.2 Dec 2025; tarkovtracker-org fork v3.9.3 Jan 2026. **Name scan** (click magnifier → GDI `CopyFromScreen` region → RatEye: OpenCV template matching + Tesseract) and **icon scan** (modifier+click). Tooltip overlay (external always-on-top; game must be Borderless/Windowed). TarkovTracker integration for you+team needs. Explicitly no memory access. 5+ years, ~1,000+ daily users, zero proven bans.

## 5. ToS / ban-risk tiers (best → worst)

Formal rule broad (License 4.3.4 "extracting data from the project"; BSG KB 423), enforcement narrow (2021 forum statement: line = modifying client files or memory).

1. **Passive log reading — de facto safe.** External process; TarkovMonitor public since ~2022; TarkovTracker docs recommend it; zero known bans. No official BSG blessing either.
2. **Screenshot-filename position — same risk class** (reads files the game writes) but confers in-raid info; community ships "use at your own risk"; no BSG action through mid-2026.
3. **Screen capture + OCR (RatScanner model) — proven safe in practice.** BattlEye states players aren't banned for non-hack overlays/capture.
4. **Overlays — mostly fine, caveat kicks not bans.** External topmost windows don't inject (don't render over exclusive fullscreen). Overwolf hosts EFT overlay apps. BattlEye may soft-block some processes ("Disallowed program" — killed TarkovRPC). Never hook/inject the swapchain.
5. **Memory reading — unambiguously bannable** (clause 4.3.4; ban waves).
6. **Policy volatility:** DWM_lut precedent (Feb 2023) — BSG can re-classify gray tools by tweet. No 1.0-era policy change on log readers/trackers/OCR found; ecosystem operates openly post-Steam.

**Rules for a new product:** never touch the process (no injection/ReadProcessMemory/input automation), never modify game files, read-only on logs/screenshots/configs, overlays in separate windows, gate in-raid-informative features behind the user's own action (their screenshot keypress).

## 6. Tool landscape

- **TarkovPilot** (ggdiam/TarkovPilot): tray app, LogsWatcher + ScreenshotsWatcher → tarkov-market live map; quest completion tracking. + **TarkovPilotSync** for squads.
- **TarkovMapTracker**, **tarkov.nexus**, **TarkovQuestie** — screenshot-position map tools (floor detection from Y coord).
- **tarkov-desktop** (the-hideout, superseded by TarkovMonitor).
- **Hideout/stash auto-tracking: nobody has it** (data not in logs). OCR of hideout/stash screens is the only path — feasible, RatScanner risk class.
- **Overwolf**: EFT apps are overlay-only; **no game-event API for EFT** — they can't auto-detect state.
- **Discord RPC**: Tarkov-Rich-Presence (log-based, "EULA compliant"); TarkovRPC abandoned over BattlEye flagging.

## 7. Recommended architecture (proven pattern: 3 watchers + on-demand OCR, all read-only)

1. **Paths resolver:** registry keys above → `<install>\Logs` or `<install>\build\Logs`; manual override (OneDrive-relocated Documents happens).
2. **Log watcher:** FSW on Logs root for new session folders + **polling tail** per file (EFT holds files open — `FileShare.ReadWrite`, byte-offset resume, UTF-8, don't trust FSW for appends). Substring filename matching. Master regex + JSON payload parse. Per-profile state keyed on ProfileId. "Read past logs" backfill with (profile, version) breakpoints.
3. **Screenshot watcher:** FSW on `Documents\Escape From Tarkov\Screenshots` (`*.png`); if absent, watch Documents for folder creation and re-arm. Filename → position + quaternion→yaw; pair with current map from log stream.
4. **OCR on demand only** (hotkey → GDI region grab → OpenCV/Tesseract). Never continuous scraping; never input injection.
5. **OS integration points (verified locally):** logs as above; screenshots as above; configs `%APPDATA%\Battlestate Games\Escape from Tarkov\Settings\*.ini` (rarely needed — application.log dumps Game/Sound/Control settings JSON at startup; parse FOV + screenshot keybind from there); process poll; registry install detection.
6. **Integrations:** TarkovTracker API v2 (bearer, batch backfills, per-profile tokens); tarkov.dev data (incl. `failConditions` cascades); optionally tarkov.dev remote socket to drive their maps.
7. **Truthfulness guardrails:** don't promise kill/XP/extract/hideout auto-tracking from files — offer timers + inference (raid type from start-gap, reconnect via shortId, survival heuristics) and manual/OCR fallbacks. Use `UserMatchCreated`/`UserConfirmed` (unused by incumbents).
