# tarkov.dev API Surface — Verified Research (2026-07-11)

> Live-verified against `https://api.tarkov.dev/graphql` via POST introspection and data queries on 2026-07-11. Prices carried same-day `updated` timestamps; 1.0-only content (Terminal, Icebreaker, Labyrinth maps; Mr. Kerman/Voevoda traders) present.

## Verdict

tarkov.dev fully covers the **trader-task dependency graph, hideout build-out, item economy, and map/positional data** needed for a progression optimizer — but it has **zero coverage of the 1.0 story chapters** (confirmed absent from live data; tracked as open feature request [the-hideout/tarkov-dev#1287](https://github.com/the-hideout/tarkov-dev/issues/1287), June 2026, unassigned). Story chapter/ending data must come from the Fandom wiki. Also: **the GraphQL API is officially in maintenance mode** ("schema changes will not be made") in favor of the newer JSON API at `json.tarkov.dev` — same data, different shape. **Build against the JSON API; use GraphQL for ad-hoc exploration.**

## 1. Task data — verified schema

`tasks(faction, lang, gameMode, limit, offset)` returns **510 tasks** (regular) / 506 (pve). `gameMode` enum = `regular | pve`. Single lookup: `task(id!, lang, gameMode)`.

**`Task` fields (complete, from live introspection):**
`id`, `tarkovDataId` (legacy, only 253/510 populated — don't rely on it), `name`, `normalizedName`, `trader`, `map` (nullable), `experience`, `wikiLink`, `taskImageLink`, `minPlayerLevel`, `taskRequirements` (`{task, status[]}` — status includes `"complete"` AND `"failed"`), `traderRequirements` (loyalty gates), `availableDelaySecondsMin/Max`, `objectives`, `startRewards`, `finishRewards`, `failConditions` (`[TaskObjective]`), `failureOutcome`, `restartable`, `factionName` (498 Any / 6 BEAR / 6 USEC), `requiredPrestige`, `kappaRequired` (**257 true**), `lightkeeperRequired` (**102 true**), message IDs.

- `TaskRewards` = `{ traderStanding (incl. negative rep — e.g. Chemical Part 3 → Jaeger −0.01), items, offerUnlock, skillLevelReward, traderUnlock, craftUnlock, achievement, customization }`.

**`TaskObjective` interface** — common `{ id, type, description, maps: [Map]!, optional! }`, 15 subtypes. Per-objective map association is native. Live distribution across 510 tasks: Item 572, QuestItem 230, Basic 212, Shoot 200, Extract 103, Mark 99, BuildItem 30, TraderLevel 10, Skill 10, TaskStatus 9, UseItem 8, Experience 1, TraderStanding 1.

Key subtype fields:
- `TaskObjectiveItem`: `items`, `count`, `foundInRaid!`, `dogTagLevel`, `min/maxDurability`, `zones: [TaskZone]`, `requiredKeys: [[Item]]` (OR-groups of key alternatives).
- `TaskObjectiveShoot`: `targetNames`, `count`, `shotType`, `zoneNames`, `bodyParts`, `usingWeapon(Mods)`, `wearing/notWearing`, `distance`, health effects, `timeFromHour/timeUntilHour`, `zones`, `requiredKeys`.
- `TaskObjectiveExtract`: `exitStatus`, `exitName`, `zoneNames`, `count`, `requiredKeys`.
- `TaskObjectiveQuestItem`: `questItem`, `count`, **`possibleLocations: [MapWithPosition]`**, `zones`, `requiredKeys`.
- `TaskZone` = `{ id, map, position{x,y,z}, outline[], top, bottom }` — real 3D volumes. **318 objectives carry geo zones**, 38 carry requiredKeys.

Working reference query — see agent report; standard `tasks(limit: 100000)` with fragments per objective type works.

## 2. Story chapters — NOT in the API (the critical gap)

- Zero matches across all 510 task names for any of the 10 chapters. Same in PvE mode and JSON API.
- The surrounding 1.0 world IS present: story NPC traders (Mr. Kerman, Voevoda, Taran, Survivor, Radio station — 0 tasks, 1 loyalty level each), maps (Terminal — gated by "Reprogrammed RFID keycard with Mr. Kerman's hash codes", Icebreaker, The Labyrinth, Ground Zero Tutorial), and 110 achievements referencing story beats ("Inferno — Learn everything about the Blue Fire", "Enough of Your Games! — Refuse to fall for Mr. Kerman's schemes", "Cracks in the Ice — ... aboard the icebreaker 'Boreas'").
- **Branching IS modeled for trader tasks**: mutually-exclusive sets via `failConditions` containing `TaskObjectiveTaskStatus` (verified: Chemical Part 4 / Out of Curiosity / Big Customer; Supply Plans / Kind of Sabotage; A Healthy Alternative / One Less Loose End; 1.0 "[PVP ZONE]" sets). 38 tasks have failConditions; 24 tasks require a **failed** prereq (e.g., Loyalty Buyout requires Chemical Part 4: failed).

## 3. Hideout — fully sufficient

`hideoutStations` → **26 stations** (incl. 1.0-era Gear Rack, Cultist Circle, Defective Wall, Weapon Rack). Levels carry `constructionTime`, `itemRequirements` (count + FIR flag), `stationLevelRequirements`, `skillRequirements`, `traderRequirements`, `bonuses`, `crafts`. **211 crafts** with `duration`, `requiredItems`, `rewardItems`, `taskUnlock`. Everything needed for a full build-out solver (item totals, prereq DAG, trader/skill gates, time).

## 4. Maps — 16 maps, rich positional data

Factory, Customs, Woods, Lighthouse, Shoreline, Reserve, Interchange, Streets, Night Factory, The Lab, Ground Zero (+21+ / Tutorial variants), **The Labyrinth, Terminal, Icebreaker**. Fields: `raidDuration, players, min/maxPlayerLevel, accessKeys, bosses (spawnChance + locations), spawns, extracts (w/ position), transits, locks (w/ key + position), switches, hazards, lootContainers, stationaryWeapons, btrStops`. Position objects are `{x,y,z}` floats (verified: Customs "Cellars" extract x:73.89, y:−3.29, z:−29.08). Streets: 414 spawns/17 extracts/58 locks. Map tiles: `the-hideout/tarkov-dev-svg-maps` + `leaflet-tiles`.

⚠ One dangling transit→map reference produced a partial GraphQL error alongside valid data — code defensively for `errors` + `data` coexistence.

## 5. Items / prices / barters / crafts — all confirmed

`Item`: `usedInTasks`, `receivedFromTasks`, `bartersFor/Using`, `craftsFor/Using`, `avg24hPrice`, `lastLowPrice`, `low/high24hPrice`, `changeLast48h(Percent)`, `lastOfferCount`, `updated`, `fleaMarketFee`, `minLevelForFlea`, `sellFor/buyFor` (with `minTraderLevel`, `taskUnlock`), `historicalPrices`, `basePrice`, `properties`. Also `historicalItemPrices(id!, days)` (7-day, 2-hour resolution) and `archivedItemPrices` (daily back to 2022). **779 barters, 211 crafts** with `taskUnlock` + `buyLimit`. Flea market live in 1.0 data: `{ enabled: true, minPlayerLevel: 15, sellOfferFeeRate: 0.03, foundInRaidRequired: false }` both modes; prices update ~5-minutely. Trader loyalty gates: `traders { levels { level requiredPlayerLevel requiredReputation requiredCommerce } }` (Mechanic LL4 = lvl 40 / 0.60 rep / ₽3.7M). Leveling model: `playerLevels` (**79 levels, max 27,091,684 XP**) and `prestige` (**6 entries**: conditions, rewards, transferSettings).

## 6. Operational

- **Free, no auth, no key.** POST to `https://api.tarkov.dev/graphql`.
- **Rate limits**: no hard number; server-cached 5 min; official guidance "no need to query faster than 5 min; use common sense". Empirically: transient `GraphQL server unavailable` errors under burst/heavy queries (3 in ~25 calls); retry after 5–10 s always succeeded. Design for retries.
- **GraphQL in maintenance mode** — new JSON API: `https://json.tarkov.dev/endpoints` → GET `/{regular|pve}/tasks|items|maps|hideout|barters|crafts|traders|prices/{itemId}|/status`, 19 languages. Verified `/regular/tasks` = same 510 tasks keyed by id, plus `neededKeys`, `failureOutcome`, questItems/achievements/prestige bundled. New game *systems* will only reach the JSON API.
- **Data pipeline**: ① Tarkov Changes (game-file extraction) ② EFT Fandom wiki ③ legacy tarkovdata (dead since Aug 2024) ④ their own scanner network → `tarkov-data-manager` (SQL, serves json.tarkov.dev). Prices ~5 min; static data updated per patch by maintainers.
- **Licensing**: API/data free for any use, no key, no stated attribution requirement (code repos are GPL-3.0/MIT — irrelevant unless forking their server). They ask you to share your project on their Discord.
- **the-hideout org**: `tarkov-dev` (222★), `TarkovMonitor` (205★), `tarkov-api` (195★), `stash` (41★), `tarkov-data-manager` (16★), `tarkov-dev-svg-maps`, `leaflet-tiles`, `tarkov-dev-image-generator`. No `the-hideout/tarkov-data` repo — that name is legacy `TarkovTracker/tarkovdata` (stale).

## 7. Complementary sources & gaps

| Source | Adds | Cost/terms |
|---|---|---|
| **EFT Fandom wiki (MediaWiki API)** | Only structured-ish source for **story chapters, stages, choices, endings**. Verified: `api.php?action=parse&page=Story_chapters&format=json&prop=wikitext` returns clean wikitext (10 chapters incl. Boreas; per-chapter pages with stage tables). CC BY-NC-SA 3.0 — attribute if republishing; non-commercial only (corrected 2026-07-11). | Free |
| **tarkov-market.com API** | Alt flea prices, item dumps, PvE. Requires paid "Pro status" (~$8/mo Patreon), personal use, mandatory credit, 5 req/min. Strictly worse than tarkov.dev except as cross-check. | Paid |
| **tarkov-changes.com** | Raw game-file per-patch diffs; upstream source *for* tarkov.dev. Aggressive bot protection. Useful for patch-diff alerting only. | Free-ish |
| **SPT (sp-tarkov)** | SPT 4.0.x targets EFT **0.16.9 (pre-1.0)**, no story content, ToS-gray. **Skip.** | Free |

### What tarkov.dev LACKS (build/plan around)
1. **Story chapters entirely** — hand-curate ~10 chapters + 4 endings from wiki; static per patch, cheap.
2. **Dynamic availability windows / live events** — no event calendar or active-window metadata.
3. **`tarkovDataId` legacy/half-null** — key on tarkov.dev's 24-hex `id` (matches BSG quest IDs).
4. Task-level full description text (only message IDs; objective descriptions exist).
5. **No versioned snapshots of static data** — snapshot per patch yourself (critical with 1.1.0 task reshuffle incoming).
6. Partial-error responses are normal — handle `errors` + `data` together.

### What it enables (all verified)
Complete trader-task DAG with AND/OR + failure-branch semantics → optimal quest router with level/loyalty/faction/prestige gates; per-objective map+coordinate routing (318 geo-tagged objectives, extract/transit/lock positions); full hideout build-out solver; cheapest-acquisition solver per item (flea vs trader vs 779 barters vs 211 crafts, task-unlock aware); XP/leveling model (79-level curve + per-task XP + prestige); Kappa/Lightkeeper filtered planning; dual PvP/PvE; 19 languages.
