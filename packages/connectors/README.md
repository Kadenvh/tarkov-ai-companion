# @tac/connectors

Connectors (SPEC module **M9**). A pluggable, capability-first adapter layer so
users connect the tools they already run (EFT Settings, Wootility, Sonar, NVIDIA
app…) and third parties can publish new adapters without touching core. This is
the input/output layer for "The Coach" (H2) and the plugin seam for the
community track (H3).

## Risk tiers (declared per module, policy in SPEC.md §1)

| Module | Tier | Why |
|---|---|---|
| `connector.ts` / `capabilities.ts` / `registry.ts` | **T0** | Pure types, the provenance-stamping helper, and an in-memory registry/resolver. No I/O of their own. |
| `connectors/eft-config.ts` | **T1** | Read-only re-expression of M6.1 — parses the JSON `Settings\*.ini` files EFT itself writes. |
| `connectors/wootility.ts` | **T1** | Read-only parse of a Wootility profile-export JSON on disk. No device I/O. |
| `connectors/manual-capture.ts` | **T0** | Shapes a prompt or wraps a user-supplied payload. Touches nothing. |

**Account-safe by construction.** The registry refuses to register any connector
above T1 (`RiskTierRejectedError`). No code path here touches the EFT process,
memory, input, window, or packets. Writes (M9.5) and the out-of-tree plugin
loader (M9.6) are **not** implemented in this slice.

## Pieces

- `capabilities.ts` — the `Capability` string-union taxonomy (v1) + `isCapability` guard.
- `connector.ts` — the `Connector` interface (SPEC-8 shape), `RiskTier`,
  `HealthStatus`, `DetectResult`, the `ConnectorReading<T>` provenance envelope,
  `WriteResult` (defined for M9.5, unused here), `makeReading()` (stamps
  `capturedAt` via an injectable `Clock`), and `hashData()` (stable
  `settingsHash`).
- `registry.ts` — `ConnectorRegistry`: `register` (T0/T1 guard), `list`,
  `byCapability`, `resolve` (prefers a `connected` candidate; `opts.prefer`
  manual override), `read` (resolve-then-read; clear error when unsatisfiable),
  `healthAll`.
- `connectors/eft-config.ts` — `game-config` (T1). Wraps `loadEftSettings`
  (@tac/environment) in a provenance envelope.
- `connectors/wootility.ts` — `keyboard-actuation` (T1). Tolerant zod schema for
  a Wootility profile export (actuation mm, rapid-trigger, per-key overrides,
  layers/Fn). **Format unconfirmed** — schema is loose and will be refined
  against a real export.
- `connectors/manual-capture.ts` — `manual-capture` (T0). Assisted-capture
  fallback: emits a prompt descriptor, or wraps a user-supplied payload.

## How to test

```
pnpm --filter @tac/connectors typecheck
pnpm --filter @tac/connectors test
```

Tests run against fixtures under `test/fixtures/` (a copy of the real 1.0.6 EFT
settings files, plus an authored Wootility profile). The eft-config suite has an
`it.skipIf` real-machine smoke test that runs only where EFT is installed.
