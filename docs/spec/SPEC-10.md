# SPEC-10 — Sources: efficient external-data monitoring (M10)

> Status: **M10.1–M10.2 built** (2026-07-16) — `packages/sources` (`@tac/sources`): registry + TTL/ETag cache + quota ledger + retry/backoff, and the `tarkov-dev-json` (game-data/prices) and `tarkovtracker` (progress-read, GP) clients. 41 tests green (+2 live-smoke skipped), workspace typecheck clean. Read-only/network-only. CONTRACTS §1/§3/§4/§5.7 carry the source surface. M10.3 status endpoint + M10.4 wiki/submit remain. The structurally-architected foundation for monitoring external **data sources** as efficiently as possible (Kaden's stated #1 priority). Sibling to `@tac/connectors` (M9, *local tools*); this layer owns *remote sources*. Reference material: [research/01](../research/01-tarkov-dev-api.md), [02](../research/02-tarkovtracker-state-store.md), [09](../research/09-upstream-source-study.md). CONTRACTS wins on conflict. New module **M10**; SPEC.md registry needs the row.

## Purpose

Today each external source (tarkov.dev, TarkovTracker, EFT wiki, tarkov.dev manager) is hit ad-hoc by whichever package needs it. That does not scale and it burns quota. **Sources** is one registry + one client discipline for every remote source, with **efficiency and resilience built into the layer, not sprinkled per call.**

## Efficiency principles (the caps-emphasized requirement — enforced by the layer)

1. **Cache-first, TTL per source.** Static game data (tasks/maps/hideout/items/barters/crafts/traders) is **snapshotted per patch and NOT re-fetched per run** (we already snapshot — M1). Prices carry a **5-min TTL** (matches tarkov.dev's server cache; their guidance: "no need to query faster than 5 min"). Nothing re-fetches inside its TTL.
2. **Conditional requests.** ETag / If-None-Match / Last-Modified where the source supports it; a 304 costs no quota and no parse.
3. **Quota budgeter (critical for TarkovTracker).** TT Free = **1,000 reads / 100 writes per day, SHARED across ALL of the user's tools** — and Kaden now runs **TarkovMonitor**, which already spends that budget. A local budget ledger tracks `X-RateLimit-*` + `Retry-After`; the layer refuses or queues near the limit rather than eating a 429.
4. **Prefer JSON API over GraphQL.** tarkov.dev GraphQL is in **maintenance mode**; build against `json.tarkov.dev` (verified live 2026-07-16: 9 endpoints, regular+pve, 19 langs). GraphQL is ad-hoc-exploration only.
5. **Resilience:** retry with exponential backoff + jitter; tolerate partial GraphQL errors (`data` + `errors` coexist — research/01 §4); circuit-breaker after repeated failures; every source assumed occasionally-down (community infra).
6. **Batch writes** (TT batch endpoint = **one** write vs quota).

## The pivot this forces: read TarkovTracker, don't fight it

Kaden runs **TarkovMonitor → TarkovTracker** now, so **TarkovTracker is his live progress source of truth.** The efficient, non-conflicting design is for our tool to be a **reader (GP scope)** of TarkovTracker, with local log-watching demoted to **enrichment/fallback** for what TT/TM don't persist (objective counts beyond TM, perf telemetry, story chapters, hideout detail). Writing progress ourselves would **double-spend the shared 100/day write quota** and collide with TarkovMonitor's server-side cascades — so **writes stay default-off.** This de-duplicates the ecosystem and is the whole point of "monitor efficiently."

## Design — registry + disciplined client

Reuses the `@tac/connectors` primitives (provenance envelope, `HealthStatus`, registry shape); network concerns are added here. Extract the shared envelope/health into `@tac/shared` so both layers depend on it.

```ts
type SourceKind = 'rest' | 'graphql' | 'mediawiki';
interface Source {
  id: string;                 // "tarkov-dev-json" | "tarkovtracker" | "eft-wiki" | ...
  kind: SourceKind;
  baseUrl: string;
  capabilities: SourceCapability[];  // game-data | prices | progress-read | story | submit
  health(): Promise<HealthStatus>;
  fetch<T>(req: SourceRequest): Promise<SourceReading<T>>; // cache + conditional + retry + budget
  quota?(): QuotaState;       // TarkovTracker: reads/writes remaining, resetsAt
}
```
- **Cache** (TTL + ETag store; static → per-patch snapshot, dynamic → TTL).
- **Quota ledger** (per source, persisted; parses rate-limit headers).
- **Status probe** (cheap liveness + version sniff; a naive GET may 403 on TT's Cloudflare — probe must send a real UA).

## The "latest-status, approachable" deliverable

- **Runtime:** `GET /api/sources/status` → per source `{ id, up, apiVersion?, lastFetch, cacheAgeSec, quota?, lastError? }`, and a **Sources status view** in the UI (up/down, version, cache age, quota remaining + reset, last error). WS `source.status` on change.
- **Reference:** this spec + research/01/02/09 are the living reference; the status view links them. Keep the docs' "verified" dates current on each patch pass.

## Deliverables (testable)

- **M10.1 Registry + cache + quota ledger + retry/backoff.** Tests: TTL hit skips network; 304 costs no quota; budgeter blocks at limit; backoff on 429/5xx; partial-GraphQL `data`+`errors` handled.
- **M10.2 First sources.** `tarkov-dev-json` (game-data + prices, primary) and `tarkovtracker` (**progress-read**, GP scope, quota-aware). Tests against fixtures; live smoke `it.skipIf` network.
- **M10.3 Status surface.** `/api/sources/status` + WS `source.status` + the status view data shape.
- **M10.4 Wiki + submit sources.** `eft-wiki` (MediaWiki, story — the one source with a proper UA that gets past Fandom's bot-block) and `tarkov-dev-manager` submit (opt-in, off by default — already in `@tac/monitor`, re-expressed as a Source).

## Relationship to existing units
- **Sibling to M9 connectors**; shared primitives move to `@tac/shared`.
- **Feeds M1/M2**: snapshots + the TarkovTracker read path become Source-mediated.
- **Feeds the status view** in the desktop app (SPEC-9).

## Open questions
- Persist the quota ledger where? (`data/local/config.json` vs a `source_quota` table — CONTRACTS §4 addition.)
- Should snapshot refresh be event-driven off `patch.detected` (CONTRACTS §3)? (Likely yes — snapshot-on-patch, not on-schedule.)
