# Competitive Landscape & Gap Analysis — Research (2026-07-11)

> Product vision tested: given a player's progress (level, tasks, rep, hideout) and goals (Kappa, story endings, Lightkeeper, prestige, hideout), generate optimal task routing — multi-task-per-raid batches, pre-stock lists, unlock-order optimization.

## 1. Task routing / optimizer tools that exist

- **tarkov.dev** (tarkov.dev/tasks): the ecosystem backbone; task list filters by trader/map, Kappa/LK flags, mark-complete, TarkovTracker token support. **No ordering/routing advice, no batching, no XP simulation.** Reference DB everyone builds on — including us.
- **TarkovTracker** (.org): the standard 1.0 progress tracker — tasks, objectives, storyline, hideout, needed items, squads, public API. **Zero planning.** Shows available tasks; never recommends which raid, what to batch, what order.
- **TarkovMonitor**: log-based auto-sync to TarkovTracker (tasks only). Explicit limits: "No log events for hideout stations"; "PMC level information is not logged by the game"; passive in-raid.
- **TarkovBuddy** (tarkovbuddy.org): closest conceptual competitor. Free, cloud-synced. Claims "Quest Optimizer" (level-aware planning, key tracking, map focus, reduced raid switching), graph "Quest Path" for Kappa, **Storyline tracker with chapter/node dependencies** (rare), quest/hideout items, profits, map. As far as verifiable: "optimizer" = filtered/sorted recommendations, **not constraint optimization**; progress is manual; no per-raid batch computation, no XP sim, no plan-tied item lists.
- **Learn to Tarkov** (learntotarkov.com): owns the "plan your raid" framing — build a task list before each raid, map picker showing which map has most available quests, visual chains, account sync (cross-device, not from game), ~2,400 users. **Batching is manual** — you assemble the list.
- **KappaQuests** (kappaquests.com/route): all 257 Kappa tasks in one computed order ("always prefers available task with lowest min level — never blocked on a level gate"), tarkov.dev data, updated Jun 2026. **One static topological sort.** No map batching, items, XP model.
- **kappas.pages.dev**: quest mind-map/dependency viz + collector + storyline decision map. Viz only.
- **mcserep/tarkov-graph**: dependency graph viz + TarkovTracker overlay. Explicitly "doesn't compute optimal completion paths."
- Others: eft.monster (tracker/tree), TarkovAdvisor (tracker + items + hideout), tarkovkappa.com, Tarkov Kappa Navi (local IndexedDB manager), Whoandozco/tarkovtrackerquests (quest data **with XP rewards** — raw material no shipped tool uses), TarkovBOT (tarkovbot.eu — Discord/Twitch bots, prices, goons; tarkovbot.dev does not resolve).
- **BSG in-game**: 1.0 story chapter UI; 1.0.5 added near-item directional indicator; 1.0.6 added task search. **BSG is absorbing QoL basics — pure-reference features are a melting iceberg; planning/optimization is the defensible layer.**

## 2. Map tools

| Tool | Offers | YOUR-task overlay? | Route lines? | Live position? |
|---|---|---|---|---|
| tarkov.dev/maps | Free interactive 2D/3D, quest markers, extracts, spawns | Limited personalization via token | No | No |
| **Map Genie Pro** (user has Pro) | 10 maps, 1500+ locations, custom markers, heatmaps, presets | **No** — static locations, zero task-state awareness | No | No |
| tarkov-market maps + quests-interactive | Quest objective overlays w/ Kappa/LK filters | Partial — **free tier caps at 3 simultaneous quests** | No | **Yes via Tarkov Pilot** (log sync, auto map/floor switch, squad sync ext) |
| **TarkovQuestie** (€3.75/mo) | Live position via screenshots, **auto quest sync from logs (490+ quests)**, quest markers, minimap/fullscreen/phone modes, squad positions + shared-quest map picker | **Yes — closest to it** | Not evidenced | Yes |

**Gap:** nobody draws an optimal route through your remaining objectives in-raid, and nobody connects the map layer to a cross-raid plan ("run Customs twice: batch A then batch B").

## 3. Item / goal planners

- TarkovTracker Needed Items: aggregate remaining task+hideout items; no prioritization or acquisition advice.
- tarkov-market progression suite: items-to-keep, usage across quests/hideout/crafts/barters, craft/barter calculators. Freemium.
- **RatScanner**: scan item in-game → price + "needed for quests/hideout" (you + team). Reactive per-item, not plan-driven.
- tarkov.guru: hideout-profit calc (no quest tracking at all). eft-graph.com: hideout dependency graph. TimmyTracker: hideout build-order + flea prices. TarkovForge: "Should I Keep This?", hideout priority, story guide.
- **Etsy sells a paid Kappa/hideout Google Sheet** — willingness-to-pay signal for planning artifacts.

**Gap:** everyone answers "what do I need eventually?" Nobody answers **"what should I acquire NOW, how (buy/barter/craft/FIR-find), in what order, for my next N raids"** — no next-best-action layer, no craft-timer scheduling, no FIR-vs-purchasable routing.

## 4. AI-driven tools

- **TarkovAI** (tarkov.ai): the only real LLM product. Second-screen companion: mid-raid Q&A, maps, quest tracking, squad chat, voice "Sherpa" beta. Freemium ($0/10 prompts → $8.99/mo 2,000 prompts + voice). Built on tarkov.dev. **Reactive Q&A only — no ingestion of your progress, no plan generation, no optimization.**
- Discord bots (Tarkov Assistant, Stash): data lookups. Custom GPTs: stale, no state, hallucination-prone. Kotaku covered an EFT quest chatbot's accuracy failures — ungrounded LLM advice is a known failure mode in this niche.

**No one does dynamic, state-grounded planning with an LLM/agent. TarkovAI validated willingness-to-pay for AI assistance but stopped at chat.**

## 5. Content/data for optimization

- tarkov.dev GraphQL/JSON: full dependency graph, min levels, objectives w/ coordinates, XP rewards, FIR flags, hideout, prices. Everything a solver needs.
- Wiki: quest trees, Story chapters, Endings (4: Savior/Survivor/Debtor/Fallen; decision points esp. in The Ticket).
- **KappaGuide** (kappaguide.com): Lightkeeper guide incl. the **alternate-completion trap** (Mechanic-line alternates that expire if you advance the main line — "locking yourself out... can add 2–4 hours"), endings, 6 prestige levels. **High-value domain knowledge to encode into the planner.**
- XP thresholds known (~161k XP to lvl 15/flea); task XP in data. **Nobody has published critical-path/XP-simulation analysis** — KappaQuests' level-gate sort is the shipped ceiling.
- Community: endings flowchart videos; Pestily's Kappa spreadsheet (community-updated for 1.0 by ItzPyroGG).

## 6. Mainstream companions

- **Blitz.gg EFT**: post-raid stats, performance metrics, **overlays** (flea prices, inventory value, quest & hideout tracking overlay) — overlays now marketed openly post-Steam. No planning.
- **Overwolf**: Tarkov Companion etc. — reference/tracking, manual state, no event API for EFT.
- **Mobalytics: no Tarkov support.** The "deep companion" slot is unoccupied by any major player.

## 7. Gap table

Legend: ● does it well · ◐ partial/manual · — absent

| Capability | tarkov.dev (+Monitor) | TarkovTracker | TarkovBuddy | LearnToTarkov | KappaQuests | tarkov-market (+Pilot) | TarkovQuestie | MapGenie Pro | Blitz/Overwolf | TarkovAI | In-game 1.0 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Auto progress sync | ◐ tasks only | ◐ via Monitor | — | — | — | ◐ raid/position | ◐ quest sync | — | ◐ raid stats | — | ● |
| **Task batching per map-raid** | — | — | ◐ | ◐ manual | — | — | ◐ squad picker | — | — | — | — |
| **Level/XP planning & simulation** | — | — | ◐ filter | — | ◐ gate sort | — | — | — | — | — | — |
| **Plan-tied item pre-stock** | — | ◐ global | ◐ global | — | — | ◐ keep-lists | — | — | — | — | ◐ |
| **Story branch/ending planning** | — | ◐ tracking | ◐ viz | — | — | — | — | — | — | — | ◐ |
| Live in-raid guidance | — | — | — | — | — | ◐ position | ● position+markers | — | ◐ price overlay | ◐ chat | ◐ |
| Price/economy | ● | — | ◐ | — | — | ● | — | — | ● | ◐ | ◐ |
| Hideout planning | ◐ data | ◐ tracking | ◐ | — | — | ◐ | — | — | ◐ | — | ◐ |
| LK path w/ trap-avoidance | — | ◐ | ◐ | — | — | ◐ | — | — | — | — | — |
| Prestige/multi-run planning | — | — | — | — | — | — | — | — | — | — | ◐ |
| **Adaptive replanning / next-best-action** | — | — | — | — | — | — | — | — | — | — | — |

## The 5 genuinely unserved capabilities

1. **Actual constraint optimization over the task graph — per-raid batches, not sorted lists.** "Your next 5 raids: Customs [A,B,C + FIR item X], Shoreline [D,E, bring key Y]..." minimizing total raids across level gates, keys, FIR, rep, story locks. Data fully supports it; solver unbuilt.
2. **Full player-state reconstruction + adaptive replanning.** Fuse log parsing + screenshot OCR + XP accrual model to estimate level; **replan after every raid**. Everything today is static checklists that go stale mid-session.
3. **Goal-conditional multi-objective planning with irreversibility foresight.** "Kappa + Savior + LK before prestige" — no tool answers it. Encode decision-point warnings ("do NOT accept this Mechanic task yet; it voids your LK alternate"). Maps perfectly to LLM+solver hybrid.
4. **Economy-integrated next-best-action pre-stock lists.** "Before tonight: buy these 4 (flea dip), start this 6-h craft, do this barter — they feed raids 2 and 4."
5. **Level/XP-path simulation.** "Route A hits the level-25 gate 3 raids early; route B stalls 6 raids." State of the art is KappaQuests' greedy level sort.

**Watch list:** TarkovBuddy (closest conceptually), Learn to Tarkov (owns raid-planning framing), TarkovQuestie + Tarkov Pilot (own live-position tech), TarkovAI (owns AI positioning, no state grounding), BSG itself (QoL absorption — stay above the reference-feature waterline).

*(Full source URL list in original agent report; key ones inline above.)*
