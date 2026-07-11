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

All eight units passed independent adversarial verification (2026-07-11); integration wave drove the full stack live against real logs, real snapshot, and a real Claude briefing. Remaining forward work is tracked in SPEC.md §4 (open questions) and the P5 row of the phase table.
