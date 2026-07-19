# VISION — Tarkov AI Companion

> **Everything a Tarkov player could dream of. No gaps.**
> One local-first, AI-driven companion that knows the game, knows *you*, and turns every session into measurable progress.

## Why this exists

Tarkov is the deepest progression game ever shipped, and its tooling ecosystem is a scatter of single-purpose reference sites: one for prices, one for checklists, one for maps, one for metas. The player is the integration layer — alt-tabbing, cross-referencing, holding the plan in their head. Post-1.0 the stakes rose: progression is permanent, story choices are irreversible, prestige is the only do-over. Nobody built the brain that sits above all of it.

**Tarkov AI Companion is that brain — "The Coach."** Not another tracker. Not another wiki mirror. A *proactive* agentic suite that ingests the entire game (data APIs + the wiki's full mechanical knowledge), reconstructs your personal state automatically, optimizes everything that can be optimized, and coaches you like a veteran sherpa who has read every page and watched every one of your raids — planning before, debriefing after, and speaking up the moment a choice matters. It doesn't wait to be asked.

## The dream (full scope)

**Progression intelligence** — the core moat
- Per-raid task batching from a real solver (never "a sorted list" — an actual plan)
- Story chapters, all 4 endings, optional branches, decision foresight ("this choice locks out Savior")
- Kappa, Lightkeeper, hideout, prestige — goal-conditional, multi-objective, replanned after every raid
- XP/level simulation: know you'll hit the Collector level-45 gate before it stalls you
- Quartermaster: plan-tied buy/barter/craft/find lists, craft-timer scheduling, FIR routing

**Personal intelligence**
- User-specific data & insights: raid history, survival by map/time/loadout, economy & net-worth curves, playstyle fingerprint
- AI-driven weights for everything — map preference, risk tolerance, session length, pace — learned from your outcomes, not hardcoded
- Every recommendation personalized and explained with receipts

**Environment intelligence**
- Optimal & trending in-game settings and configurations (graphics, sound, controls) with one-click apply
- NVIDIA Control Panel / driver-profile optimization (fully outside the game — zero risk)
- Performance monitoring: frame telemetry per map/settings combo, regression detection after patches

**Your setup, connected** — the environment layer, generalized
- Connectors: bring your *own* tools — Wootility, SteelSeries Sonar, the NVIDIA app — and the Coach reads (and, opt-in, orchestrates) them. Capability-first, so your alternatives work just as well. Account-safe and out-of-process, always.
- Sources: every external data plane (tarkov.dev, TarkovTracker, the wiki) behind one disciplined client — cache-first, quota-aware, resilient to outages. We *read* TarkovTracker as your live progress (TarkovMonitor already feeds it) instead of fighting its write quota. Monitor everything, as efficiently as possible.

**In-raid intelligence** (risk-gated, honest)
- Automatic map loading and live position (screenshot-position, proven safe)
- Spawn-aware pathing: from your spawn, the optimal route through tonight's objectives to extract
- Vision/OCR local models where ToS-validated — always feature-flagged, always the player's choice

**Platform**
- **One application:** the whole suite ships as a single installable Windows app (`.exe`/`.msi`) — service, agent, UI, and the live monitor behind one launch, no terminal. It sits on your second monitor like it belongs there.
- Auto-updating, patch-aware (data snapshots + wiki drift detection survive every BSG reshuffle)
- Agentic to the core: Claude plans, narrates, replans, and answers — grounded in the solver and your state, never guessing
- Community-ready as a **local-first plugin + overlay + published guide/dataset** — shareable without becoming a hosted service; squad-aware later. Only ever if it stays true to the daily driver first.

## Doctrine (the identity)

1. **Grounded > generative.** The AI never freelances game facts. Solver + data are ground truth; the model narrates and adapts.
2. **No gaps, but no rebuilds.** If the ecosystem already does it well (prices, maps, scanners), we integrate it. We build only what doesn't exist.
3. **Local-first.** Your state, your machine, your data. Cloud services are mirrors and enrichments, never the system of record.
4. **Safe > clever.** Read-only on everything the game writes. No memory, no injection, no input automation — ever. Gray-zone features ship feature-flagged and default-off. We keep the account.
5. **Honest ceilings.** If the data can't support a feature (logs don't contain hideout state), we say so and design the best legitimate approximation — we don't pretend.
6. **Progression is the product.** Every feature must move the player toward a goal faster or make the next session smarter. Delight is measured in saved raids.

## Who it serves

First: **Kaden** — fast-paced, progression-driven, Kappa/endings/Lightkeeper-focused, already skilled, allergic to wasted raids. The companion earns its place on the second monitor every single session, or it has failed.

Eventually, maybe: every Tarkov player who has ever alt-tabbed to a wiki mid-raid.

---
*Companion documents: [NORTH-STAR.md](NORTH-STAR.md) (how we decide and measure) · [SPEC.md](SPEC.md) (what we build, exactly) · [docs/DESIGN.md](docs/DESIGN.md) (architecture) · [docs/research/](docs/research/) (verified evidence base)*
