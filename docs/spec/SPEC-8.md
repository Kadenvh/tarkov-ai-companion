# SPEC-8 — Connectors (M9)

> Status: **M9.1–M9.4 implemented** (2026-07-16) — `packages/connectors` (`@tac/connectors`): registry + capability resolver + provenance envelope, and the `eft-config`, `wootility`, and `manual-capture` connectors. 32 tests green, typecheck clean, real-machine EFT read verified. Writes (M9.5) and the plugin loader (M9.6) remain. CONTRACTS.md §1/§3/§4/§5.6 now carry the connector surface. Derived from [SPEC.md](../../SPEC.md); where this and [CONTRACTS.md](CONTRACTS.md) disagree, CONTRACTS wins. New module **M9**; SPEC.md module registry still needs the M9 row added.

## Purpose

The Coach is only as good as the data it can read and the environment it can orchestrate. Today the environment adapters (EFT `Settings\`, NVIDIA DRS, PresentMon) are hard-wired inside M6 (SPEC-4). **Connectors** generalize them into a pluggable adapter layer so that *any user connects the tools they already run* — and so third parties (or Kaden) can publish new adapters without touching core. This is both the input/output layer for "The Coach" (H2) and the **plugin seam** for the community-surface track (H3).

Design driver (Kaden, 2026-07-16): *"an embedded connectors functionality — users can connect & utilize their own setup for upmost accuracy & orchestration; I use Wootility, SteelSeries Sonar, NVIDIA app… but users may use alternatives."*

## Principles

1. **Capability-first, vendor-second.** A connector advertises *capabilities* (e.g. `keyboard-actuation`), not a brand. Alternatives compete to satisfy the same capability, so The Coach reasons about capabilities and stays vendor-neutral.
2. **Account-safe by construction (T0/T1 only).** Connectors touch on-disk config, vendor-local APIs, and OS telemetry — **never the game process.** No memory reading, injection, packet capture, or input automation. Reasserts the Never-list; a connector that would require process contact is rejected at registration.
3. **Reads are default-on; writes are default-off, explicit, reversible.** Any `write`/`orchestrate` capability is opt-in per connector, backs up prior state before applying, and is one-click revertible.
4. **Assisted capture is a first-class fallback.** When no adapter exists for a needed capability, a `manual-capture` connector prompts the user (paste/screenshot). Occasional prompts are acceptable (per the H2 "Coach" decision); the goal is coverage, not zero-touch purity.
5. **Every read is provenance-tagged.** Connector output carries `{ connectorId, capability, capturedAt, gameVersion, settingsHash? }` so the M6.3 attribution engine can correlate environment ↔ outcome.

## Capability taxonomy (v1)

| Capability | Reads | Optional write/orchestrate | First adapters |
|---|---|---|---|
| `game-config` | EFT `Settings\*.ini` (JSON) | apply setting profile | **EFT Settings** (first-party) |
| `keyboard-actuation` | actuation points, rapid-trigger, layers | push profile | **Wootility** (Wooting HE); generic no-op |
| `audio-mix` | device routing, EQ, ChatMix | apply footstep EQ | **SteelSeries Sonar/GG**; Voicemeeter; NVIDIA Broadcast |
| `gpu-3d-profile` | per-app DRS profile for `EscapeFromTarkov.exe` | write DRS (the SPEC-4 M6.2 deferred item) | **NVIDIA** (NVAPI DRS / NVIDIA app) |
| `display-config` | resolution/refresh/HDR | — | OS display query |
| `perf-telemetry` | frametimes, GPU util/VRAM/clocks/temps | — | **PresentMon/ETW**; nvidia-smi |
| `tracker-sync` | quest/hideout/goal state | push state | **TarkovTracker .org** mirror |
| `manual-capture` | user-supplied paste/screenshot → OCR | — | **Assisted Capture** (fallback) |

## Connector interface (shape — bind concrete types in CONTRACTS)

```ts
interface Connector {
  id: string;                 // "wootility", "steelseries-sonar", "nvidia-drs"
  vendor: string;
  capabilities: Capability[]; // what it can satisfy
  riskTier: 'T0' | 'T1';      // registration rejects > T1
  detect(): Promise<DetectResult>;      // installed? config path found? version?
  read(cap: Capability): Promise<ConnectorReading>;   // provenance-tagged
  write?(cap: Capability, patch: unknown): Promise<WriteResult>; // opt-in, backs up first
  health(): Promise<HealthStatus>;      // connected | stale | missing | error
}
```

Detection uses the known config-path map in [`docs/research/06-environment-paths.md`](../research/06-environment-paths.md). The registry auto-detects installed tools on service start and offers to connect them; a user may also connect manually or fall back to `manual-capture`.

## Deliverables (testable)

- **M9.1 Registry + interface.** Connector registry, capability resolver (picks the best connector per capability, with manual override), provenance envelope. Tests: capability with 0 / 1 / N adapters resolves correctly; T2+ connector is refused.
- **M9.2 First-party connectors.** `game-config` (EFT Settings — refactor of existing M6.1) and `tracker-sync` (TarkovTracker — refactor of existing M2.7) re-expressed as connectors with no behavior change. Tests: parity with pre-refactor reads.
- **M9.3 Vendor read adapters.** Wootility (`keyboard-actuation`), SteelSeries Sonar (`audio-mix`), NVIDIA (`gpu-3d-profile` read + `perf-telemetry`). Detection + read + health. Tests: detect against fixture config trees; graceful `missing` when absent.
- **M9.4 Assisted-capture connector.** `manual-capture` — prompt schema, OCR hand-off (out-of-raid only), writes a provenance-tagged reading. Tests: prompt round-trip produces a structured reading.
- **M9.5 Orchestration writes (opt-in).** Reversible `write` for `game-config`, `audio-mix` (footstep EQ), `gpu-3d-profile` (unblocks the SPEC-4 M6.2 DRS-write deferral). Every write backs up prior state + is revertible. Tests: write→revert restores byte-identical prior state; write is refused unless explicitly enabled.
- **M9.6 Plugin seam (H3).** Stable connector contract + a loader for out-of-tree connectors, so a published connector is a community contribution without a core change. Tests: a fixture out-of-tree connector loads and satisfies a capability.

## Relationship to existing units

- **Subsumes** the hard-wired adapters in **SPEC-4 / M6** — those become the first concrete connectors (M9.2/M9.3). M6's optimization logic stays; only its I/O layer moves behind the registry.
- **Feeds** M6.3 attribution and the M7 insights (SPEC-5): provenance-tagged readings are the join key for environment ↔ outcome analysis.
- **Enables** H3: M9.6 is the plugin the community track ships.

## Open questions

- CONTRACTS additions: connector REST/WS surface, `connector_reading` table DDL, capability enum. (Add before M9.1 lands.)
- Vendor API stability: Wootility and SteelSeries GG expose config primarily via local files, not documented public APIs — confirm read paths per the recon doc; treat writes as file-level with backups.
- Which capabilities warrant `write` on the **main account** vs. observe-only? (audio EQ + game-config = clearly safe; DRS write = safe but higher blast radius — default off.)
