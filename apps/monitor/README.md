# @tac/monitor

A **TarkovMonitor-style live companion** for tarkov-ai-companion. It is a pure
consumer of the service's event stream — it connects to `@tac/service` over the
WebSocket at `:3141`, so it reuses all existing log parsing and raid detection
and **never touches the game, its logs, its memory, or its process** (risk tier
T0, like the rest of the suite).

Run it as the third process alongside the service and agent:

```bash
pnpm service    # daemon + UI   → http://localhost:3141   (must be running)
pnpm agent      # AI copilot    → :3142                   (optional)
pnpm monitor    # live monitor  → http://localhost:3143
```

Then open **http://localhost:3143** and click **Enable sound** once (browsers
block audio until a user gesture) to arm voice + chime alerts.

## What it does

- **Voice + chime alerts** (browser SpeechSynthesis + Web Audio — no sound
  files) on: match found, raid started, run-through cleared, raid ended, scav
  cooldown ready, quest completed, and (off by default) queue entered / flea
  sale. Each alert is individually toggleable in Settings.
- **Live raid timers**: time-in-raid, and a **run-through countdown** (default
  420 s — extract after this and it counts as *Survived* rather than *Run
  Through*; the game also clears it at ~200 in-raid EXP, which logs don't
  expose, so the timer tracks the time criterion only).
- **Scav cooldown countdown**: a calibratable estimate you start with the
  **Scav out** button. Our logs don't record PMC-vs-Scav side, so this is
  manual rather than automatic; set your real base in Settings (Intelligence
  Center lowers it).
- **Session stats**: raids, flea sales, roubles, and a per-map breakdown.
- **Crowdsourced submissions to tarkov.dev** (like TarkovMonitor) — **off by
  default, opt-in**:
  - *Queue times* (anonymous: map, seconds, PMC/scav, PVP/PVE), sent on raid
    start.
  - *Goons sightings* (map + your account id, for de-dup), sent from the manual
    **Report goons** button.

  > These are **experimental**: the exact `manager.tarkov.dev` request schema is
  > not pinned in this repo (endpoint is env-overridable via
  > `TAC_TARKOVDEV_MANAGER_URL`). Verify against
  > [the-hideout/tarkov-api](https://github.com/the-hideout/tarkov-api) before
  > enabling so you never feed malformed data into the community dataset.
  > Goons reports need an account id — set `TAC_MONITOR_ACCOUNT_ID`.

Quest completion is auto-marked by the service's TarkovTracker mirror (Goals →
TarkovTracker sync), so the monitor doesn't duplicate that.

## Attribution

Behavior (alert set, run-through timer, and the tarkov.dev queue/goons
submission payloads) is modeled on
[the-hideout/TarkovMonitor](https://github.com/the-hideout/TarkovMonitor)
(GPL-3.0). No code was copied — it's a C#/.NET app and this is a reimplementation
in our TypeScript stack. See `docs/research/09-upstream-source-study.md` for the
verified API shapes and what we adopted vs. deferred.

## Config / env

| Env | Default | Purpose |
|---|---|---|
| `TAC_MONITOR_PORT` | `3143` | monitor window + API port |
| `TAC_SERVICE_URL` | `http://localhost:3141` | upstream service |
| `TAC_MONITOR_RUNTHROUGH_SEC` | `420` | run-through threshold |
| `TAC_MONITOR_SCAV_SEC` | `1500` | scav cooldown base estimate |
| `TAC_MONITOR_ACCOUNT_ID` | — | account id for opt-in goons reports |
| `TAC_TARKOVDEV_MANAGER_URL` | `https://manager.tarkov.dev/api` | submission endpoint |

Runtime config (alert toggles, timing, submission opt-ins) persists to
`data/local/monitor.json`; audio prefs (voice/chimes/volume) are stored
per-device in the browser.

## Start on boot (optional, Windows)

Same recipe as the service/agent: create a shortcut running
`pnpm --filter @tac/monitor start` in `shell:startup`, or add a Task Scheduler
entry. See `apps/service/README.md` for the full walkthrough.
