# 11 — TarkovTracker.org Product Recon (IA, Views, Features, Delta)

**Date:** 2026-07-16 · **Target:** [tarkovtracker-org/TarkovTracker](https://github.com/tarkovtracker-org/TarkovTracker)
(Nuxt 4 + Vue 3 + Supabase, GPL-3.0) · live at **tarkovtracker.org**.

**Method note.** The live site is Cloudflare-protected (confirmed again — search engines index it but the
app shell is gated), so this recon is built from the **source tree at `main`** (SHA `8b02ed…`, pushed
2026-07-16 00:40 UTC) — the `app/pages/`, `app/features/`, `app/composables/`, and `app/stores/`
directories, read directly. Their **`pages/` dir literally IS the route table / IA.** API and data-model
facts are **not** repeated here — see `docs/research/02-tarkovtracker-state-store.md` (API v2.1.0, progress
schema, prestige) and `docs/research/09-upstream-source-study.md` (behavioral study). This doc is IA + views +
features + UX + our delta.

**Repo pulse (2026-07-16):** 56★ / 17 forks / 21 open issues / GPL-3.0. Description: *"Escape from Tarkov
quest, hideout, item, and progression tracker for PvP/PvE with squad sync, built with Nuxt 4 and Supabase."*
Low star count (org is young; the 3k★ legacy `.io` repo carries the historical stars) but **extremely active**
— near-daily releases, v1.55.6 as of doc 02, i18n in 7+ languages (EN/DE/ES/FR/RU/UK/ZH), Codecov/Crowdin CI,
dense `__tests__` coverage beside almost every composable and store.

---

## 1. Information architecture

Nav is a single left drawer (`app/features/drawer/DrawerLinks.vue`), collapsible, with **one flat
"Navigation" section**. Content is organized **by function/object-type**, NOT by map or by trader (except the
Kappa page, which pivots to trader columns). The drawer also carries a level widget (`DrawerLevel.vue`), a
game-settings quick block (`DrawerGameSettings.vue` — PvP/PvE + edition), and external links.

### Primary nav (drawer, in order)

| Order | Label | Route | Icon | Purpose |
|---|---|---|---|---|
| 1 | Home | `/` (`index.vue`) | squares-2x2 | Dashboard: focus/next-actions card, milestones, trader rep, progress |
| 2 | Storyline | `/storyline` | book-open | 1.0 story chapters/objectives/endings (carries a **WIP badge**) |
| 3 | Tasks | `/tasks` | clipboard-list | The core quest tracker (list / **map** / **graph** views) |
| 4 | Needed Items | `/needed-items` | cube | Aggregated item requirements (tasks + hideout) |
| 5 | Hideout | `/hideout` | home | Station module build tracking |
| 6 | Team | `/team` | user-group | Squad create/join/invite + shared progress & needs |
| 7 | Settings | `/settings` | cog | All config: tokens, level, skills, rep, prestige, keybinds, import/export |
| 8 | Kappa | `/kappa` | trophy | Dedicated Kappa view — trader-column layout of collector tasks |
| 9 | Supporter | `/supporter` | heart | Paid tiers / donations (funds the hosted infra) |

### Secondary / non-drawer routes (footer, deep-links, auth, admin)

| Route | Purpose |
|---|---|
| `/profile` and `/profile/[userId]/[mode]` | **Public shareable read-only profile** — tabs: Overview, Tasks, Hideout, Storyline, Progression (`app/features/profile/*`) |
| `/resources` and `/resources/[slug]` | **Resources & Guides hub** — companion apps, community tools, dev resources, guides; searchable + category-filtered |
| `/streamer-tools` | Overlay/tools for streamers (`useStreamerToolsOverlay`, `StreamerToolsPanel.vue`) |
| `/changelog` | In-app changelog (also surfaced on the dashboard) |
| `/kappa` (above) · `/account` | Account management |
| `/login`, `/auth/callback`, `/oauth/consent` | Supabase OAuth + an **OAuth-provider consent screen** (they act as an identity provider for third-party tools) |
| `/supporter`, `/credits`, `/privacy`, `/terms-of-service`, `/not-found` | Legal / attribution / errors |
| `/admin` | Admin console (audit log, cache, supporter-access) — `middleware/admin.ts` gated |
| `/needed-items` vs `/neededitems`, `/kappa` | note a legacy `neededitems.vue` alias exists alongside canonical `needed-items.vue` |

**Key IA observation: there is NO top-level "Maps" route.** Maps are a *view mode embedded inside the Tasks
page* (Leaflet objective markers for the selected map). So their IA is: **object-type pages** (tasks, items,
hideout, story) + **goal pages** (kappa) + **social** (team, profile) + **config** (settings) + **meta**
(resources, supporter, changelog). No "planner", no "raid", no "route", no "acquire" concept exists as a
first-class surface.

---

## 2. Feature inventory (per view)

### Dashboard (`index.vue` + `app/features/dashboard/*`)
- **"Next Actions" / Focus card** (`DashboardNextActions.vue` + `useDashboardRecommendations.ts`) — the closest
  thing they have to planning. A **greedy single-task scoring heuristic**: for each pending, faction-filtered,
  type-filtered task it computes a score =
  `trader-unlock(+1000) + impact×120 + lightkeeper(+90) + kappa(+70) + progressRatio×100 + closeness − blocker penalties`,
  where **impact = count of *immediate* downstream tasks** (`task.children`/`successors`, one level deep — NOT a
  full critical-path count). Emits **one primary + up to 3 secondary** recommendations, each with a human "why /
  progress / status" panel, a blocker taxonomy (`level`, `fence`, `prerequisite`, `trader-unlock`, `ready`,
  `filters`, `complete`), and deep-links to `/tasks?task=<id>`. Also a "blocked" mode (closest-unlock) and a
  "caught up / review your filters" mode.
- Milestone card, overall progress bar/card, **per-trader cards with a manual reputation input**
  (`DashboardTraderCard.vue`, `ReputationInput.vue`), and an embedded changelog feed.

### Tasks (`tasks.vue` + `app/features/tasks/*`) — the flagship
- **Three view modes** switched by a filter bar:
  1. **List/card view** — `TaskCard` with header, badges (Kappa/LK/faction/optional), objectives, rewards,
     actions; a "focused task" pinned section; skeleton/loading/empty states.
  2. **Map view** — inline **Leaflet map** (`LeafletMap.vue`) with per-objective markers, extract layer +
     toggle, legend, **in-game map time (day/night) badges**, resizable height, and a **"required items on this
     map" summary** (`MapRequiredItemsSummary.vue`). *Static objective markers — NO live player position.*
  3. **Graph view** — `TaskGraphView.vue` / `TaskGraphNode.vue`, a **dependency-graph visualization** of the
     quest tree (`useGraphBuilder`, `useTaskGraphData`).
- **Filtering & sorting** (`useTaskFilters.ts`, `TaskFilterBar`, `TaskFiltersSection`, `AdvancedTasksSection`):
  **fuzzy search** (`fuzzyMatchScore`), filter by trader / map / task type, Kappa-only, Lightkeeper, **hide
  completed**, "hide completed map objectives" toggle, hide global tasks, faction-aware. Route-synced filters
  (`useTaskRouteSync`, `useRouteFilters`) so filter state is shareable/bookmarkable.
- **Task actions** (`useTaskActions`): mark complete / uncomplete / **failed**, with **server-side cascade** of
  prerequisites/alternatives; per-objective **count controls** (`ObjectiveCountControls`); undo via action
  history. Deep-link to a single task (`useTaskDeepLink`).
- Objective-level detail: required items with FIR indicators, item groups, wiki links (`useWikiLink`).

### Needed Items (`needed-items.vue` + `app/features/neededitems/*`)
- Aggregates **all remaining item requirements across tasks + hideout** into one list.
- Filter tabs (All / Tasks / Hideout / Completed) with live counts; **FIR filter**, **Kappa-only**, **hide
  owned**, **hide team items**, hide non-FIR special equipment; **group-by-item** (with a grouped modal showing
  every task/hideout use) vs flat rows; sort by (name/count/etc.) + direction; **list vs grid** view; compact vs
  expanded cards; per-item **count controls** (track how many you already have). Infinite scroll + perf-budgeted
  progressive load. `TeamNeedsDisplay` folds in teammates' needs.

### Hideout (`hideout.vue` + `app/features/hideout/*`)
- Station cards (`HideoutCard`) with per-module **requirements** (items, other modules, trader levels, skills),
  station status (locked/available/built via `useHideoutStationStatus`), station wiki links, a settings drawer,
  and route-synced filtering (`useHideoutFiltering`, `useHideoutRouteSync`). Prereq resolution in
  `stores/tarkov/hideoutPrereqs.ts`.

### Storyline (`storyline.vue` + `useStorylineChapters.ts`) — *marked WIP*
- Chapter cards with a completion progress bar (`completed/total chapters`), per-chapter objectives, **route
  choices modeled as `open | chosen | blocked`** with `routeAlternatives` / `routeBlockingAlternatives`
  (i.e. it KNOWS which branch choices lock out others), **endings** (`StorylineEndingView` with
  `routeChoiceIndex`), **optional vs main objectives**, and **estimated map/trader/reward unlocks per
  objective**. Toggle chapter/objective; wiki links. This is a genuinely rich data model — but it's a
  **tracker/visualizer**, not a foresight engine (see gaps).

### Kappa (`kappa.vue` + `app/features/kappa/*`)
- A **dedicated collector view**: tasks laid out in **trader columns** (`KappaTraderColumn`, `KappaTaskRow`), a
  trader selector, and a `TrackerSummary`. A focused checklist for the Kappa grind, separate from the general
  Tasks page.

### Team (`team.vue` + `app/features/team/*`)
- Create/join a team, **invite links** (`TeamInvite`), member cards showing each member's level & progress,
  team options, and **shared needed-items** across the squad. Backed by Supabase Realtime + `GET
  /team/progress`.

### Profile (`profile.vue`, `profile/[userId]/[mode].vue`)
- **Public, read-only, per-game-mode profile** you can share as a URL. Tabs: Overview, Tasks, Hideout,
  Storyline, Progression. Sharing is toggled in Settings (`ProfileSharingCard`).

### Settings (`settings.vue` + `app/features/settings/*`) — very deep
Cards: **ApiTokens** (create/scope/revoke Bearer tokens for tarkov.dev/RatScanner/TarkovMonitor),
**GameModeToggle** (PvP/PvE), **Experience** (set level), **Skills**, trader **reputation**, **PrestigeCard**
(prestige 1–6 with per-level requirement checklists + run history), **KeybindsCard**, **MapSettingsCard**,
**TaskDisplayCard**, **DisplayNameCard**, **ProfileSharingCard**, **PrivacyCard**, **DiscordLinkCard**,
**ExternalLinksCard**, **DataManagementCard** (see import/export), **DebugStateCard**, **ResetProgress**,
**AccountDeletion**.

### Import / Export / Interop
- **Data backup**: export/import full progress as JSON (`useDataBackup`).
- **Import from tarkov.dev** (`useTarkovDevImport`) and **migrate from legacy .io** profiles.
- **Browser-side EFT log import** (`useEftLogsImport` + `eftLogQuestParser`): upload a **zip of your EFT logs**
  and it parses quest completions/fails to backfill progress (one-time, client-side, up to 512 MB). Distinct
  from TarkovMonitor's live streaming.
- **Public API v2.1.0** + they act as an **OAuth identity provider** (`/oauth/consent`) for third-party tools.

### Cross-cutting UX
- **Omnibar** (`Omnibar.vue`) — a global fuzzy **command palette / search**, opened with a configurable keybind
  or `/` (GitHub-style).
- **Keybinds** (`useKeybinds`): configurable **undo** (backed by an action-history store — undo any progress
  change) and omnibar.
- **In-app help system**: `PageHelpPanel`, `PageHelpSpotlight`, `GlobalHelpLauncher`, per-page help content
  (`usePageHelpContent`) — guided tooltips/spotlights.
- **In-game clock** (`useTarkovTime`, `useMapTime`) for map day/night.
- **Analytics with a consent banner** (opt-in `useAnalyticsConsent`), toast/i18n system, back-to-top, context
  menus, side rails, settings drawers per page.
- **PvP/PvE dual mode** threaded everywhere (per-mode tokens, teams, profiles, prestige).

---

## 3. What they nail (the bar we must meet)

1. **Breadth + polish.** Every object type (tasks, objectives-with-counts, items, hideout, story, kappa,
   prestige, skills, rep) is tracked, in a clean, fast, responsive Nuxt UI with dark theme, skeletons, toasts,
   an omnibar, undo, keyboard shortcuts, and an in-app guided-help system. This is a mature, well-tested app
   (tests next to nearly every unit).
2. **Three complementary task views** (list / interactive Leaflet map / dependency graph) with **route-synced,
   fuzzy, faction-aware filtering** and shareable filter URLs. The map's "required items on this map" summary is
   a genuinely nice touch.
3. **Team/squad sync done well** — realtime, invite links, shared needed-items, per-member progress.
4. **Storyline modeled richly** — chapters, main/optional objectives, **branch choices with open/chosen/blocked
   state**, endings, and estimated unlocks. Best-in-class *tracking* of the 1.0 story.
5. **Prestige 1–6 modeled natively** with per-level requirement checklists and run history (see doc 02).
6. **Interop / ecosystem hub.** Public API + OAuth provider + import-from-everywhere (tarkov.dev, .io, **raw EFT
   log zips**) + they maintain forks of TarkovMonitor/RatScanner. They are the de-facto progress **system of
   record** for the whole tool ecosystem.
7. **Near-daily updates, i18n (7+ langs), strong test/CI discipline.** They keep pace with BSG patches.
8. **A basic "next best task" already exists** — the Dashboard focus card. We must beat it convincingly, not
   pretend it's absent (see §4/§5).

---

## 4. Gaps & weaknesses (our opportunity)

Being fair: they added a greedy recommender, so the gap is **depth of planning**, not "they have zero
recommendations." Concretely, they do **not**:

1. **No solver / no per-raid batching.** Their recommender picks **one task at a time**; there is no concept of
   "these 4 objectives are all on Customs — run Customs, then Shoreline for these 3." Nothing groups objectives
   by map into raid-sized batches or minimizes total raids. `action` is always `/tasks?task=<id>`.
2. **Impact is shallow.** "Impact" = count of *immediate* children (one hop). No transitive critical-path
   weighting, so a task that unlocks a long high-value chain scores the same as one unlocking 2 dead-ends.
3. **No XP / level-gate simulation.** They detect a level gate as a *current* blocker (`minPlayerLevel >
   currentLevel`) but never **project** it: no "route A hits the Collector L45 gate 3 raids early", no XP-accrual
   model, no ordering to defer/clear gates. Level is a manual field.
4. **No irreversibility / decision-point foresight.** The storyline model *knows* branch alternatives become
   `blocked`, and the LK/Mechanic-alternate trap is real (see doc 04 / KappaGuide) — but there is **no proactive
   warning** ("do NOT accept this task yet; it voids your Savior ending / your LK alternate"). It records the
   lockout after the fact; it doesn't coach you before it.
5. **No acquisition / craft / barter scheduling.** Needed Items is a **static aggregate bucket** ("what do I need
   eventually"). No "buy these 4 now (flea dip), start this 6-h craft, do this barter — they feed raids 2 and
   4", no FIR-vs-purchasable routing, no craft-timer awareness, no next-N-raids pre-stock.
6. **No live in-raid layer.** The map is **static objective markers** — no live position, no spawn-aware route
   through tonight's objectives, no in-raid guidance. (By design; they're a web app.)
7. **No environment / settings / performance intelligence.** Nothing about graphics/audio/controls, NVIDIA
   profiles, or frame telemetry — entirely out of scope for them.
8. **No AI / natural-language layer.** No copilot, no grounded Q&A, no narrated plan or debrief.
9. **No personal analytics / outcome model.** No raid history, survival-by-map, net-worth curve, playstyle
   fingerprint, or learned weights. Progress is a checklist state, not a behavioral model.
10. **Cloud system-of-record + quotas.** Their store is Supabase-hosted; the API has daily read/write quotas
    shared across the user's tools (doc 02). Web-only, account-required, Cloudflare-gated. No local-first,
    no offline, no second-monitor native app.
11. **Fundamentally a *checklist*, not a *planner*.** Every surface answers "what is my state / what do I need
    *eventually*." Only the dashboard card nudges "what next," and only as a greedy single pick. **Nobody there
    answers "what should I do across my next N raids, in what order, with what pre-stock, avoiding which traps."**

---

## 5. Our supreme delta

### (a) Differentiating features to lean into (the moat — none of which they do)
1. **A real solver, not a scorer.** Multi-objective constraint optimization over the task graph → **per-raid
   batches**: "Next 5 raids: Customs [A,B,C + bring key X, FIR item Y], Shoreline [D,E]…", minimizing total raids
   across level gates, keys, FIR, rep, and story locks. This is the headline the dashboard card only gestures at.
2. **XP/level-path simulation.** Project when each level gate clears under a given route; reorder to never stall.
   Show "raids-to-goal" deltas (our North-Star metric) vs. their implicit greedy order.
3. **Irreversibility foresight.** Turn their `blocked`-branch *data* into *pre-emptive warnings*: "Accepting this
   now voids Savior / your LK alternate — do X first." Story endings + LK trap as a guarded plan, not a tracker.
4. **Quartermaster (plan-tied acquisition).** Convert Needed Items from a bucket into a **schedule**: buy/barter/
   craft/FIR-find, in order, timed to the raids that consume them; craft-timer aware; FIR-vs-purchasable routing.
5. **AI copilot grounded in solver + state.** Pre-raid plan narration, post-raid debrief, "why this order",
   answer-my-question — grounded, never freelancing (our Doctrine #1). They have zero AI.
6. **Personal + environment intelligence.** Raid-outcome model, net-worth/ETA curves, learned weights; plus the
   settings/NVIDIA/perf layer — all entirely outside their scope.
7. **Local-first + single native second-monitor app + live in-raid layer** (screenshot position, spawn-aware
   route) — the always-on, quota-free daily driver they can't be as a web app.

### (b) IA / nav recommendation for OUR app — position us as the "what-next brain" *above* a tracker
Do **not** mirror their object-type nav. Lead with **verbs/plans**, keep object-type surfaces secondary and
read-mostly (we mirror TarkovTracker/tarkov.dev state, we don't rebuild the checklist). Proposed IA:

| Our view | Role | Relationship to TarkovTracker |
|---|---|---|
| **Tonight / Plan** (home) | The solver output: your next-N-raid batches, per-raid objective+item cards, "why", raids-to-goal | *This is the surface they don't have.* Our identity. |
| **This Raid** (in-raid) | Live: spawn-aware route through tonight's objectives, on-map, feature-flagged | They have static markers only |
| **Quartermaster** | Plan-tied acquire/craft/barter schedule for the next raids | Beats their static Needed Items |
| **Goals & Foresight** | Kappa/LK/story/prestige as goal-conditional plans + **irreversibility warnings** | Beats their trackers/Kappa page |
| **Debrief / You** | Post-raid outcomes, personal model, net-worth/ETA, playstyle | They have nothing |
| **Copilot** | Grounded chat, ambient across every view | They have nothing |
| **Setup** | Env/settings/perf + connectors (Wootility/Sonar/NVIDIA) | Out of their scope entirely |
| *(Progress mirror)* | A thin read-through of task/hideout/story state, synced from TarkovTracker | **Integrate, don't rebuild** |

Principle: **their app is a noun-oriented tracker; ours is a verb-oriented planner.** Every one of our primary
views answers "what do I DO," and the tracker state sits underneath as read-mostly ground truth.

### (c) Integrate rather than rebuild (per NORTH-STAR "Never" list)
- **Read TarkovTracker as the live progress mirror** (TarkovMonitor already feeds it; doc 02). Model our local
  SQLite on their schema (tarkov.dev IDs, `{complete,failed,timestamp}`+counts+epoch) so sync is near-identity.
- **Do NOT rebuild**: the basic checklist, team-sync basics, the raw item aggregate, the public map layer
  (tarkov.dev/Leaflet), prices, scanning. Consume, don't clone.
- **Do reuse their open data/behavior with attribution** (both GPL-3.0): their storyline **branch/route-lock
  data model** (`useStorylineChapters` shapes) is a great scaffold to build foresight *on top of*; their prestige
  requirement checklists; their trader-unlock task maps.
- Offer **one-token interop** so our user's single TarkovTracker token also lights up tarkov.dev + RatScanner.

### (d) 3–5 "wow" moments that flip a TarkovTracker user
1. **"Your next 5 raids" card** on first launch — a real batched plan with per-raid item pre-stock and a
   raids-to-goal number. They've never seen anything group objectives into raids; the dashboard card only ever
   hands them one task.
2. **The trap warning that saves 2–4 hours**: a red pre-emptive alert — "Do NOT accept *[task]* yet — it locks
   out your Lightkeeper alternate / Savior ending. Clear *[X]* first." Encodes exactly the KappaGuide trap
   (doc 04) their tracker only records *after* it fires.
3. **XP-gate foresight**: "Route A stalls you at the L45 Collector gate for 3 raids; Route B doesn't — here's B."
   No tool anywhere ships XP simulation.
4. **Quartermaster pre-stock**: "Before tonight: buy these 4 on the flea (dip now), start this 6-h craft, run
   this barter — they feed raids 2 and 4." Turns their static bucket into an actionable timed list.
5. **Grounded copilot + auto-state**: ask "what should I do tonight?" in plain English and get a narrated,
   receipts-backed plan — with state that updated itself from your logs 5 minutes after your last raid, zero
   manual entry (their level/rep/skills are manual fields).

---

## Sources
- Repo tree @ `main` (SHA 8b02ed…), read directly: `app/features/drawer/DrawerLinks.vue` (nav),
  `app/pages/*` (routes/IA), `app/features/dashboard/DashboardNextActions.vue` +
  `app/composables/useDashboardRecommendations.ts` (recommender heuristic),
  `app/features/tasks/*` + `app/pages/tasks.vue` + `app/features/tasks/composables/useTaskFilters.ts`
  (task views/filters), `app/composables/useNeededItems.ts`, `app/composables/useStorylineChapters.ts` +
  `app/pages/storyline.vue`, `app/features/settings/*`, `app/features/team/*`, `app/features/profile/*`,
  `app/features/kappa/*`, `app/composables/useEftLogsImport.ts`, `app/composables/useKeybinds.ts`,
  `app/features/omnibar/Omnibar.vue`, `app/pages/resources/index.vue`.
  <https://github.com/tarkovtracker-org/TarkovTracker>
- GitHub API repo stats (56★/17 forks/21 issues/GPL-3.0, pushed 2026-07-16). <https://api.github.com/repos/tarkovtracker-org/TarkovTracker>
- Live site (Cloudflare-gated — verified indexed, app shell inaccessible): <https://tarkovtracker.org/>, <https://tarkovtracker.org/storyline>, <https://tarkovtracker.org/supporter>
- Cross-refs (not re-derived here): `docs/research/02-tarkovtracker-state-store.md` (API/data model/prestige),
  `docs/research/09-upstream-source-study.md` (behavior), `docs/research/04-competitive-gap-analysis.md` (ecosystem gaps).

**Could not fully verify:** exact live visual layout / recent-release UX polish (Cloudflare block on the running
app; leaned on source + search snippets). Release-version currency (v1.55.x) is carried from doc 02, not
re-verified this session.
