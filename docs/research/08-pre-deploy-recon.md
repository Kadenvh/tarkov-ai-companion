# Pre-deployment recon — ecosystem, ToS, and surface scan
### 2026-07-11 · two independent recon passes (web + local audit), key claims cited

## 1. The three ecosystems (who is who)

| Project | What it is | Repo / license | Notes for us |
|---|---|---|---|
| **tarkovtracker.io** | The ORIGINAL tracker (Vue 2/Firebase). **Stale** — last release Dec 2023, frozen pre-1.0; site still up as legacy | `TarkovTracker/TarkovTracker` | Do not integrate; only exists as a migration source |
| **tarkovtracker.org** | The community successor (Nuxt 4/Supabase/Cloudflare), extremely active (v1.55.6 released 2026-07-11), fully 1.0-native (story chapters, endings, prestige, PvP/PvE) | `tarkovtracker-org/TarkovTracker` — **GPL-3.0** ([README](https://github.com/tarkovtracker-org/TarkovTracker)) | **Our mirror target.** API: `api.tarkovtracker.org` (v2.1.0, OpenAPI 3.1). Quotas = the fair-use policy: Free tier **1,000 reads / 100 writes per day, 30 req/min** ([docs/API.md](https://github.com/tarkovtracker-org/TarkovTracker/blob/main/docs/API.md)). Tokens `PVP_`/`PVE_` are mode-bound. Target the api subdomain directly (cross-host 308 drops Authorization) |
| **tarkov.dev** | The data plane (items, tasks, prices, maps) run by **the-hideout** org | website `the-hideout/tarkov-dev` = MIT; API server `the-hideout/tarkov-api` = GPL-3.0 | API is explicitly **free, no rate limit, no ToS, no required attribution** (their api-docs page); they ask for voluntary Open Collective support. The *data* carries no explicit license. Our usage (per-patch snapshot + ≤5-min price polling) is far below anything they discourage |
| **TarkovMonitor** | the-hideout's desktop log-reader (C#) — the tool whose T1 pattern we follow | `the-hideout/TarkovMonitor` — **GPL-3.0** | We referenced log-format *facts* only; all our TypeScript is original (audited — see §4). Copying actual code would force GPL-3.0 on the whole repo |
| **RatScanner** | OCR item scanner | **NOT open source** — Elastic License 2.0-based (`NOASSERTION` on GitHub) | Never copy code from it: ELv2 forbids commercial distribution and is MIT-incompatible |

## 2. BSG ToS posture (as of 2026-07-11)

- Operative EULA clauses (verified via the Arena license text; EFT-specific page is JS-walled): **4.2.5** (no reverse engineering / client modification), **4.2.10** (no "automated scripts for collecting information… with the Game and its elements"), **4.2.11** (no use beyond customary gameplay). Log reading isn't clearly covered by any of them — and isn't blessed either.
- The controlling public statement remains **BSG's Oct 2021 forum post**: the ban line = software that can "replace, override or modify any existing game client files or data in the memory." Nothing found 2022–2026 that tightens or loosens this for log readers.
- **Q1 2026 ban wave** (25k bans): 46% were RMT/bots/"other prohibited software" — named categories are **macros, overlays, input automation**. Log readers not named. BSG announced TPM 2.0 + Secure Boot requirements and more proactive detection (secondary source; original blog unreachable).
- **No BSG sanctioned-tools/Overwolf program exists.** Overwolf EFT apps' "100% allowed" claims are developer claims, not BSG statements.
- Zero known bans attributed to the TarkovMonitor/TarkovPilot class through July 2026. Our architecture is strictly inside that class (loopback-only, read-only, no process/window interaction).

## 3. Licensing corrections & obligations

- **CORRECTION (applied repo-wide 2026-07-11):** the EFT Fandom wiki is **CC BY-NC-SA 3.0**, not CC-BY-SA (verified via wiki footer + `meta=siteinfo&siprop=rightsinfo`). Consequences:
  - **NC** — the wiki-derived story dataset (`data/story/story.json`) is non-commercial. Forecloses monetizing the story features; the code is unaffected.
  - **SA** — if the repo goes public, the dataset *file* ships under CC BY-NC-SA with per-page source links (already present in its `sources` map) — the code can carry any license (dual-licensing note in the repo README recommended).
  - Facts (quest names, objectives, stats) aren't copyrightable; our paraphrased summaries are the clean pattern.
- **Dependency audit:** 168 prod packages — MIT/ISC/BSD/BlueOak/Unlicense only; **zero GPL/AGPL/LGPL**. One proprietary: `@anthropic-ai/claude-agent-sdk` (Anthropic, all-rights-reserved; fine to depend on, users bring their own Claude login).
- **No LICENSE file in the repo yet** — decision needed before publishing. No copied GPL/ELv2 code (spot-audited parse.ts, tracker.ts, wiki/*; pattern citations only).

## 4. Local surface scan (verdict: safe to deploy locally)

- **Network:** service + agent bind `127.0.0.1` only; no CORS registered (safe default). **Fixed 2026-07-11:** Host-header allowlist on both servers (DNS-rebinding guard) and `.csv`-only restriction on `POST /api/environment/perf/import {path}` (was an arbitrary-file-read primitive). Never rebind to `0.0.0.0` without adding auth.
- **Secrets:** TarkovTracker token lives in `data/local/config.json` (gitignored, nothing tracked under `data/local/`); zero committed tokens; agent auth never writes credentials.
- **Privacy:** all 19 real profile ids + 18 account ids extracted from the live logs grep to **zero hits** in tracked files; fixtures use synthetic ids.
- **Outbound:** tracker mirror debounced/batched with backoff + 401 self-disable (well inside the 1,000-read/day quota); tarkov.dev fetched only by the manual snapshot CLI (UA-identified, backoff); **no runtime wiki fetcher exists** (parser is pure; `wiki_cite` builds URLs without network).
- **Ops:** WAL-mode SQLite, append-only journal (KB/week — no retention issue for years); watchers are ≥1s polls that re-arm after sleep/wake; auto-start documented in the app READMEs.

## 5. Patch 1.1.0 "Kord Breach" urgency

- Confirmed **July 2026**, exact day unannounced — could land any day. Includes a **Unity 6 engine upgrade** (log formats/paths may shift → budget a parser re-validation pass on patch day) and **seasonal characters** (a second parallel character class that may surface in logs and tracker models).
- Our detection: `patch.detected` fires on version change, `/api/health.patchDetected`, WS notice prompting `pnpm snapshot`. **Gap:** the M1.2 snapshot-*diff* CLI still doesn't exist — the sentinel says "review the diff" with nothing to review it with. Highest-priority P5 item.
- `latestSnapshot()` picks the newest snapshot by lexicographic sort — correct for `1.1.0` vs `1.0.6`; would mis-sort a hypothetical `1.0.10` (known, commented).
