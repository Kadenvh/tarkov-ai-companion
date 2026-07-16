# 09 — Upstream source study: TarkovMonitor & TarkovTracker

**Date:** 2026-07-14. Local read-only reference checkouts of
[the-hideout/TarkovMonitor](https://github.com/the-hideout/TarkovMonitor)
(C#/.NET, GPL-3.0) and
[tarkovtracker-org/TarkovTracker](https://github.com/tarkovtracker-org/TarkovTracker)
(Nuxt/Vue, GPL-3.0). **Gitignored, never vendored** (`/.gitignore` → `/TarkovMonitor/`,
`/TarkovTracker/`): different stacks, so there is nothing to import — the value is in
studying behavior and reimplementing in our own TS idiom with attribution.

## Verified — now pinned in `@tac/monitor`

tarkov.dev crowdsourced submission API (source: `TarkovMonitor/TarkovDev.cs` —
`ITarkovDevAPI`, `QueueTimeBody`, `GoonsBody`, `PostQueueTime`, `PostGoonsSighting`):

- Base URL `https://manager.tarkov.dev/api`.
- `POST /queue` body `{ map, time, type, gameMode }` — **our `queueTime` payload already matched exactly.**
- `POST /goons` body `{ map, gameMode, timestamp, accountId }` where **`timestamp` is Unix milliseconds** and **`accountId` is an integer**. Our earlier payload sent an ISO-8601 timestamp + string id and omitted `gameMode` — **fixed** in `submit.ts` to match. This removed the "experimental / verify before enabling" caveat on the shape (it stays opt-in and off by default).

## Adopted

- **Failed-task alert (`quest-failed`).** TarkovMonitor plays a "failed tasks"
  reminder because many failed tasks are immediately restartable. We now raise a
  `warn`-chime voice alert on `quest.changed` status `failed` (previously we only
  alerted on `completed`).

## Validated — already at parity, no change needed

- **Log rotation.** TarkovMonitor reads `application`/`notifications`/`traces`
  plus their `_000` rotated variants. Our `discover.ts` already matches streams by
  substring and tracks `_NNN` rotation counters.
- **Profile-detection spellings.** TarkovMonitor keys on `SelectProfile` and
  `SelectedProfile`. Our `parse.ts` regex already covers
  `SelectProfile` / `SelectedProfile` / `CompleteSelectProfile`.

## Deferred (per direction: not pursuing scav features)

- **Auto PMC-vs-Scav detection.** TarkovMonitor infers raid type from the gap
  between `application|GameStarting` and `application|GameStarted`: `> 3 s` ⇒ PMC
  (the insertion countdown), else Scav; a PVE profile is always PVE. It then
  auto-starts the scav cooldown on a Scav/PVE raid *end*. Implementing this would
  require our state-engine parser to emit a `GameStarting` event and carry the
  raid *type* on `raid.started`/`raid.ended` (CONTRACTS §3 change). Recorded here
  so the approach isn't lost.
- **Accurate scav cooldown.** Base `1500 s` (matches our default), refined by
  tarkov.dev `settings.scavCooldownSeconds` + Intelligence Center hideout level +
  Fence reputation modifier.

## Licensing

Both projects are GPL-3.0, same as this repo, so studying and adapting with
attribution is fine. We reimplemented behavior in TypeScript rather than copying
code (also forced by the language gap). RatScanner (ELv2/proprietary) is
intentionally **not** consulted. Credit retained in `apps/monitor/README.md`.
