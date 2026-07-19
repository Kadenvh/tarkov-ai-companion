# @tac/sources

Sources (SPEC module **M10**). The efficient external-data monitoring layer: one
registry + one client discipline for every *remote* data feed, so efficiency and
resilience live in the layer, not sprinkled per call. Sibling to `@tac/connectors`
(M9, *local tools*); this package owns *remote sources* (tarkov.dev, TarkovTracker,
later the EFT wiki).

## Risk tiers (declared per module, policy in SPEC.md §1)

| Module | Tier | Why |
|---|---|---|
| `capabilities.ts` / `source.ts` / `cache.ts` / `quota.ts` / `registry.ts` | **T0** | Pure types + in-memory cache/quota/registry + provenance helpers. No I/O of their own. |
| `http.ts` | **T0** | Network reads of public data. Never touches the game process/memory/input/packets. |
| `sources/tarkov-dev-json.ts` | **T0** | Read-only, unauthenticated reads of public tarkov.dev JSON (game-data + prices). |
| `sources/tarkovtracker.ts` | **T0** | Read-only read of the user's *own* progress via a user token. Authenticates a REST read only — no game contact. **Writes are default-off (not implemented).** |

**Everything here is read-only and network-only.** No code path touches the EFT
process, memory, input, window, or packets. No writes to TarkovTracker (would
double-spend the shared 100/day write budget and collide with TarkovMonitor).

## What it does (efficiency discipline)

- **Cache-first, TTL per source** (`cache.ts`): static game data → long TTL
  (snapshot-per-patch), prices → 5-min TTL (matches tarkov.dev's server cache).
  Nothing re-fetches inside its TTL.
- **Conditional requests** (`http.ts`): a cached ETag is sent as `If-None-Match`;
  a 304 is a cache hit — no body parse, no quota spend.
- **Quota budgeter** (`quota.ts`): parses `X-RateLimit-*` + `Retry-After`; the
  TarkovTracker source *refuses* a read when the shared budget is exhausted
  rather than eating a 429.
- **Resilience** (`http.ts`): retry with exponential backoff + jitter on 429/5xx,
  honoring `Retry-After`. Deterministic (injectable rng + sleep) for tests.
- **Real User-Agent** on every request (a naive fetch 403s on TarkovTracker's
  Cloudflare front).

## Sources (M10.2)

- `tarkov-dev-json` — `game-data` + `prices`, primary, base `https://json.tarkov.dev`.
- `tarkovtracker` — `progress-read` (GP scope), quota-aware, base pinned to
  `https://api.tarkovtracker.org`.

## Status surface (M10.3)

`SourceRegistry.status()` → `{ id, up, apiVersion?, lastFetch?, cacheAgeSec?, quota?, lastError? }[]`
— the shape behind `GET /api/sources/status` and the WS `source.status` event.

## Shared-shape note

`HealthStatus`, the provenance envelope (`SourceReading`), `makeReading`, and
`hashData` intentionally mirror `@tac/connectors`. They should later be hoisted
into `@tac/shared` and shared by both layers (SPEC-10 §Design). We do not refactor
`@tac/connectors` in this slice.

## How to test

```
pnpm --filter @tac/sources typecheck
pnpm --filter @tac/sources test
```

Unit tests inject `fetchImpl` with fixture responses (`test/fixtures/`) and never
touch the network. One `it.skipIf(!process.env.TAC_LIVE)` live smoke per source is
off by default; run with `TAC_LIVE=1` to hit the real APIs.
