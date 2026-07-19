# Spec series

Phase specs derived from the master [SPEC.md](../../SPEC.md). Each SPEC-n scopes one build unit to concrete, testable deliverables. [CONTRACTS.md](CONTRACTS.md) is the binding cross-package interface contract (ports, REST/WS API, SQLite DDL, event names) — where a SPEC-n and CONTRACTS disagree, CONTRACTS wins.

| Spec | Unit | Modules | Status |
|---|---|---|---|
| [SPEC-0](SPEC-0.md) | Foundation (Data Core) | M1, M8.2 | ✅ complete |
| [SPEC-1](SPEC-1.md) | Planner + Quartermaster | M3.1–M3.6 | ✅ complete |
| [SPEC-2](SPEC-2.md) | State Engine (log watcher, backfill, XP, mirror, journal) | M2, M8.1 | ✅ complete |
| [SPEC-3](SPEC-3.md) | AI Copilot (grounded briefings, NL goals, replan, learned weights) | M4 | ✅ complete (live LLM verified 2026-07-11) |
| [SPEC-4](SPEC-4.md) | Environment (settings/NVIDIA/PresentMon/ammo) | M6 | ✅ complete (M6.2 DRS *writes* deferred — recorded) |
| [SPEC-5](SPEC-5.md) | Insights (raid analytics, economy, fingerprint) | M7 | ✅ complete |
| [SPEC-6](SPEC-6.md) | Service daemon (REST+WS host, watchers, patch sentinel) | M5.1, M5.6, M8 | ✅ complete |
| [SPEC-7](SPEC-7.md) | Web UI (Tonight's Plan, Goals/story, Quartermaster, Insights, Environment, Map) | M5.2–M5.5 | ✅ complete (route overlay = P5 open question) |
| [SPEC-8](SPEC-8.md) | Connectors (capability-based pluggable adapters; plugin seam for H3) | M9 (subsumes M6 adapters) | 🚧 M9.1–M9.4 built + Wootility/NVIDIA/Sonar reads + `game-config` write (M9.5, opt-in/gated); DRS+audio writes + M9.6 plugin loader open |
| [SPEC-9](SPEC-9.md) | Desktop app shell & packaging (Electron single-app + `.exe`/`.msi`; UI elevation) | M11 | ✅ M11.1+M11.2 shipped (NSIS .exe, 137MB, service boots); MSI + M11.3 deferred |
| [SPEC-10](SPEC-10.md) | Sources: efficient external-data monitoring (registry, cache, quota, status; TT-read pivot) | M10 | ✅ M10.1–M10.4 built (tarkov-dev JSON, TarkovTracker read, EFT wiki, manager-submit disabled); status API + Sources view live |

The P0–P5 units (SPEC-0…7) passed independent adversarial verification (2026-07-11); the integration wave drove the full stack live against real logs, a real snapshot, and a real Claude briefing. The P6 "Coach" units (SPEC-8…10) followed (2026-07-16). Remaining forward work is tracked in SPEC.md §4 (open questions) and the P5/P6 rows of the phase table.
